# MarkSync

轻量级书签同步系统 — 浏览器扩展 + 后端 API + Web 管理台三件套。

## 组成

- **`extension/`** — Chrome/Firefox 扩展（Manifest V3），基于 BookmarkSync 改造，支持 Gitee Gist + 自建后端双模式
- **`backend/`** — Bun + Hono + SQLite 后端 API（用户、Token、书签同步）
- **`web/`** — Vue 3 + Naive UI 管理台（登录、书签管理、Token 管理）
- **`deploy/`** — docker-compose + Dockerfile + 部署脚本
- **`docs/`** — 架构、API、部署文档

## 快速开始

### 生产部署（推荐）

```bash
cd deploy
docker compose up -d
```

访问：https://marksync.zcoolq.cn（走 Cloudflare Tunnel）

### 本地开发

```bash
# 后端
cd backend && npm install && npm run dev

# 前端
cd web && npm install && npm run dev

# 扩展
# Chrome → chrome://extensions → 加载已解压 → 选 extension/
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node 22 + Hono + better-sqlite3 |
| 前端 | Vue 3 + Vite + Naive UI + Pinia |
| 扩展 | 原生 JS + Manifest V3 |
| 认证 | JWT (HS256) + Argon2 |
| 部署 | Docker Compose + Cloudflare Tunnel |

## 文档

- [架构设计](./docs/ARCHITECTURE.md)
- [API 规范](./docs/API.md)
- [部署指南](./docs/DEPLOYMENT.md)
- [扩展改造说明](./docs/EXTENSION.md)
