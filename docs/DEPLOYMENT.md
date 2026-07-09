# MarkSync 部署指南

## 生产部署（Docker Compose）

### 1. 环境准备

- NAS: 192.168.31.197 (fn-nas)
- Docker + Docker Compose
- Cloudflare Tunnel MCP 已配置（Tunnel ID: `e6f5c810-e338-4607-aec6-007b036dca53`）
- 目标域名: `bookmark.zcoolq.cn`

### 2. 部署步骤

```bash
cd /vol2/1000/important-folders/it-projects/MarkSync/deploy

# 1. 生成 .env
cp .env.example .env
# 编辑 .env 设置 JWT_SECRET / REGISTRATION_OPEN 等

# 2. 启动
docker compose up -d --build

# 3. 查看日志
docker compose logs -f marksync

# 4. 添加 Cloudflare Tunnel 穿透
# 通过 MCP 工具:
# fnos-tunnel__tunnel_register_app_domain(
#   appName="nas",
#   domain="bookmark.zcoolq.cn",
#   service="http://localhost:8888"
# )
```

### 3. 目录挂载

```
/vol2/1000/important-folders/it-projects/MarkSync/backend/data/
  ├── bookmarks.db          # SQLite 主库
  ├── bookmarks.db-shm      # WAL shared memory
  ├── bookmarks.db-wal      # WAL log
  └── jwt.secret            # JWT 签名密钥（首次自动生成）
```

### 4. 备份

**自动备份 cron**（每天 03:00）:
```bash
# 加到 crontab -e
0 3 * * * cd /vol2/1000/important-folders/it-projects/MarkSync/backend/data && \
  cp bookmarks.db /vol2/1000/important-folders/it-projects/MarkSync/backups/bookmarks-$(date +\%Y\%m\%d).db && \
  find /vol2/1000/important-folders/it-projects/MarkSync/backups/ -name "bookmarks-*.db" -mtime +30 -delete
```

### 5. 更新

```bash
cd /vol2/1000/important-folders/it-projects/MarkSync
git pull
cd deploy
docker compose up -d --build
```

---

## 本地开发

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm run dev             # http://localhost:3000
```

### Web
```bash
cd web
npm install
npm run dev             # http://localhost:5173
```

Vite 已配置 `/api` 代理到 `http://localhost:3000`。

### Extension
```
Chrome → chrome://extensions → 开发者模式 → 加载已解压 → 选择 extension/
```

在扩展设置里：
- 后端类型：**自建后端**
- API URL: `http://localhost:3000/api`
- API Token: 从 Web 管理台创建

---

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 后端端口 |
| `DB_PATH` | `./data/bookmarks.db` | SQLite 文件路径 |
| `JWT_SECRET` | 自动生成 | JWT 签名密钥 |
| `JWT_EXPIRES_IN` | `7d` | JWT 有效期 |
| `REGISTRATION_OPEN` | `false` | 是否允许注册（首用户不受限制） |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的 CORS 源，逗号分隔 |
| `LOG_LEVEL` | `info` | 日志级别 |

---

## 目录结构总览

```
MarkSync/
├── README.md
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── DEPLOYMENT.md
│   └── EXTENSION.md
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.ts
│   │   ├── db.ts
│   │   ├── config.ts
│   │   ├── lib/
│   │   │   ├── auth.ts
│   │   │   ├── crypto.ts
│   │   │   └── logger.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── error.ts
│   │   │   └── rate-limit.ts
│   │   └── routes/
│   │       ├── auth.ts
│   │       ├── tokens.ts
│   │       ├── sync.ts
│   │       ├── bookmarks.ts
│   │       └── stats.ts
│   └── data/
├── web/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── Dockerfile         (可选，多阶段构建)
│   └── src/
│       ├── main.ts
│       ├── App.vue
│       ├── router.ts
│       ├── api/
│       ├── stores/
│       ├── views/
│       │   ├── LoginView.vue
│       │   ├── DashboardView.vue
│       │   ├── BookmarksView.vue
│       │   ├── TokensView.vue
│       │   └── SettingsView.vue
│       └── components/
├── extension/
│   ├── manifest.json
│   ├── background/
│   ├── popup/
│   ├── utils/
│   └── icons/
└── deploy/
    ├── docker-compose.yml
    ├── .env.example
    └── nginx.conf         (可选，如果要独立)
```
