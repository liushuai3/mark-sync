#!/usr/bin/env bash
# MarkSync 一键构建 & 发布脚本
# 使用: ./deploy.sh [选项]
#
# 选项:
#   -h, --help        显示帮助
#   --no-web          跳过 web dist 本地预构建（仍在容器内 build）
#   --no-pull         不 git pull（默认会尝试拉取远程最新代码）
#   --logs            部署完成后跟随容器日志
#   --no-cache        docker 不使用缓存
#
# 例:
#   ./deploy.sh              # 拉最新代码 → build → 重启容器
#   ./deploy.sh --logs       # 部署完成后跟随日志
#   ./deploy.sh --no-pull    # 只用本地代码部署

set -euo pipefail

# ─── 配置 ─────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$PROJECT_ROOT/deploy"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
CONTAINER_NAME="marksync"
IMAGE_NAME="marksync:latest"
BUILD_LOG="/tmp/marksync-deploy-$(date +%Y%m%d-%H%M%S).log"

# ─── 选项 ─────────────────────────────────────────
DO_WEB=1
DO_PULL=1
FOLLOW_LOGS=0
NO_CACHE=""

usage() {
  cat <<'EOF'
MarkSync 一键构建 & 发布脚本
使用: ./deploy.sh [选项]

选项:
  -h, --help        显示帮助
  --no-web          跳过 web dist 本地预构建（仍在容器内 build）
  --no-pull         不 git pull（默认会尝试拉取远程最新代码）
  --logs            部署完成后跟随容器日志
  --no-cache        docker 不使用缓存

例:
  ./deploy.sh              # 拉最新代码 → build → 重启容器
  ./deploy.sh --logs       # 部署完成后跟随日志
  ./deploy.sh --no-pull    # 只用本地代码部署
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --no-web) DO_WEB=0 ;;
    --no-pull) DO_PULL=0 ;;
    --logs) FOLLOW_LOGS=1 ;;
    --no-cache) NO_CACHE="--no-cache" ;;
    *) echo "❌ 未知选项: $1" >&2; usage ;;
  esac
  shift
done

# ─── 工具 ─────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'

step() { echo -e "${CYAN}${BOLD}▶ $*${RESET}"; }
ok()   { echo -e "${GREEN}✔ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $*${RESET}"; }
die()  { echo -e "${RED}✖ $*${RESET}" >&2; exit 1; }

# ─── 前置检查 ─────────────────────────────────────
step "环境检查"
command -v docker >/dev/null || die "未找到 docker"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose"
[[ -f "$COMPOSE_FILE" ]] || die "找不到 $COMPOSE_FILE"
ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ─── Git 同步 ─────────────────────────────────────
if [[ $DO_PULL -eq 1 ]]; then
  step "拉取远程最新代码"
  cd "$PROJECT_ROOT"
  if git remote get-url origin >/dev/null 2>&1; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)
    if git fetch origin "$BRANCH" 2>/dev/null; then
      LOCAL=$(git rev-parse HEAD)
      REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")
      if [[ "$LOCAL" != "$REMOTE" ]]; then
        echo "  $DIM$LOCAL → $REMOTE$RESET"
        git pull --ff-only origin "$BRANCH"
        ok "已同步到最新提交"
      else
        ok "已是最新（$LOCAL）"
      fi
    else
      warn "git fetch 失败，跳过拉取"
    fi
  else
    warn "未配置 origin，跳过 git pull"
  fi
fi

# ─── 版本 ─────────────────────────────────────────
EXT_VERSION=$(node -e "console.log(require('$PROJECT_ROOT/extension/manifest.json').version)" 2>/dev/null || echo "unknown")
GIT_SHA=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "no-git")
echo "  Extension: v$EXT_VERSION  |  Commit: $GIT_SHA"

# ─── 可选：本地 web 预构建（校验 Vue 代码可编译） ──
if [[ $DO_WEB -eq 1 ]]; then
  step "本地预构建 web（可选，用于快速失败）"
  if [[ -d "$PROJECT_ROOT/web" ]]; then
    (cd "$PROJECT_ROOT/web" && \
      { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && \
      npm run build) 2>&1 | tail -3
    ok "web 本地构建通过"
  else
    warn "跳过：找不到 web/"
  fi
fi

# ─── Docker 构建 ──────────────────────────────────
step "Docker 构建镜像 $IMAGE_NAME"
echo "  日志: $BUILD_LOG"
cd "$DEPLOY_DIR"

# setsid 让 build 完全脱离父 shell，避免中途被 SIGKILL/SIGHUP 中断
if ! setsid docker compose build $NO_CACHE >"$BUILD_LOG" 2>&1 < /dev/null; then
  echo "  ─── build 日志末尾 ──────────────"
  tail -30 "$BUILD_LOG"
  die "构建失败，完整日志见 $BUILD_LOG"
fi
ok "构建成功"

# ─── 重建容器 ─────────────────────────────────────
step "重建并启动容器"
docker compose up -d --force-recreate 2>&1 | tail -5
ok "容器已启动"

# ─── 健康检查 ─────────────────────────────────────
step "等待健康检查"
for i in $(seq 1 30); do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "no-container")
  if [[ "$STATUS" == "healthy" ]]; then
    ok "健康检查通过（${i}s）"
    break
  fi
  if [[ "$STATUS" == "no-container" ]]; then
    die "容器未启动"
  fi
  sleep 1
  [[ $i -eq 30 ]] && warn "30s 内未变 healthy，当前状态: $STATUS"
done

# ─── 概览 ─────────────────────────────────────────
echo
echo "${BOLD}${GREEN}✅ 部署完成${RESET}"
docker ps --filter "name=$CONTAINER_NAME" --format "  {{.Names}}  {{.Status}}  {{.Ports}}"
echo
echo "  Web:       https://marksync.zcoolq.cn"
echo "  API:       https://marksync.zcoolq.cn/api"
echo "  Extension: https://marksync.zcoolq.cn/downloads/marksync-extension-${EXT_VERSION}.zip"
echo "  Commit:    $GIT_SHA"
echo
echo "  💡 日志:   docker compose -f $COMPOSE_FILE logs -f"
echo "  💡 重启:   docker compose -f $COMPOSE_FILE restart"
echo

if [[ $FOLLOW_LOGS -eq 1 ]]; then
  step "跟随容器日志（Ctrl+C 退出）"
  docker compose -f "$COMPOSE_FILE" logs -f --tail=50
fi
