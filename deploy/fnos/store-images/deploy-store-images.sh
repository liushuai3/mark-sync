#!/usr/bin/env bash
# 部署 fnOS 商店图片到 Cloudflare Pages
# 用法: CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx ./deploy-store-images.sh
# 产出: https://marksync-store.pages.dev/ + （可选）img.zcoolq.cn 自定义域
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=marksync-store
DOMAIN=img.zcoolq.cn
: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN 环境变量（Cloudflare API Token，权限见 README）}"
: "${CLOUDFLARE_ACCOUNT_ID:?需要 CLOUDFLARE_ACCOUNT_ID（从 /zones/{id} 的 account.id 获取）}"

echo "==> 部署 $PROJECT ..."
npx --yes wrangler@latest pages project create "$PROJECT" --production-branch main 2>/dev/null || true
npx --yes wrangler@latest pages deploy . --project-name "$PROJECT" --branch main --commit-dirty=true

echo
echo "==> 默认域名: https://${PROJECT}.pages.dev/"
echo "==> 自定义域 ${DOMAIN} 绑定（需 Zone DNS Edit 权限，同 zone 自动激活）:"
npx --yes wrangler@latest pages domain add "$DOMAIN" --project-name "$PROJECT" || {
  echo "自动绑定失败——手动方式：dash.cloudflare.com → ${PROJECT} 项目 → Custom domains → Add"
  echo "或把 ${DOMAIN} 的 DNS 改 CNAME → ${PROJECT}.pages.dev（代理开启）"
}
