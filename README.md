# MarkSync

自托管的浏览器书签**多端双向同步**系统 — 浏览器扩展 + 后端 API + Web 管理台三件套。

> **v4.0 (2026-10)** — 可靠双向增量同步引擎全面成熟：UUID 主键、字段级 LWW 冲突解决、删除墓碑、分批推送、自动去重收敛；扩展已上架 **Chrome 应用商店** 与 **Edge 加载项商店**；后端镜像发布至 **Docker Hub**（`zcoolq/marksync`）；提供**飞牛 fnOS 应用中心**一键安装包。
> 升级自旧版（基于 `path` 的单向推送）时，服务端会自动 DROP 旧 `bookmarks` 表（仅书签数据，用户/Token 保留）。详见 [`docs/CHANGELOG.md`](docs/CHANGELOG.md) 与 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 特性

- **双向增量同步**：每台设备独立 UUID，只传变更（`server_updated_at` 拉取 + 本地 diff 推送），冲突字段级 LWW 合并，删除经墓碑传播到所有设备
- **可靠不丢数据**：推送失败自动回滚基线（不会出现"改了但永远同步不上"）、分批推送规避 413、网络错误退避重试
- **自动同步**：默认每 5 分钟增量周期 + 书签变更监听（可在设置页关闭），手动「立即同步 / 清理重复」随时可用
- **多用户 + REST API**：JWT 认证、API Token 管理、同步日志、备份恢复，Web 管理台开箱即用
- **数据私有**：书签数据只存你自己的服务器（SQLite 单文件），不出家门

## 安装

### 方式一：浏览器扩展（最常用）

| 商店 | 链接 |
|------|------|
| Chrome 应用商店 | [MarkSync 书签同步](https://chromewebstore.google.com/detail/marksync-%E4%B9%A6%E7%AD%BE%E5%90%8C%E6%AD%A5/lmleaekggnegoeemedmkdmgegjjdpibo) |
| Edge 加载项商店 | [MarkSync 书签同步](https://microsoftedge.microsoft.com/addons/detail/marksync-%E4%B9%A6%E7%AD%BE%E5%90%8C%E6%AD%A5/kgfedigcggagbdlfokgdeojaahknnfie) |
| zip 手动安装 / Firefox | [marksync-extension-v4.0.zip](https://marksync.zcoolq.cn/downloads/marksync-extension-v4.0.zip) |

扩展设置页填入后端 API 地址（`http://<服务器>:8888/api`）与 API Token 即可。

### 方式二：飞牛 fnOS 应用中心

应用中心「手动安装」上传 [`deploy/fnos/marksync/`](deploy/fnos/) 构建的 `marksync.fpk`（安装向导可直接设置管理员账号），或等待上架后一键安装。构建方法见 [deploy/fnos/README.md](deploy/fnos/README.md)。

### 方式三：Docker（任意 Linux/NAS）

```bash
docker run -d --name marksync \
  -p 8888:3000 \
  -v marksync-data:/app/backend/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  zcoolq/marksync:4.0.0
```

或用 compose（见 [`deploy/docker-compose.yml`](deploy/docker-compose.yml)）。访问 `http://<服务器>:8888`，**首个注册用户即管理员**。

## 在线演示

https://marksync.zcoolq.cn （部署于自托管 fnOS，Cloudflare Tunnel 出口）

## 组成

- **`extension/`** — Chrome/Edge/Firefox 扩展（Manifest V3），自建后端 + Gitee Gist 双模式
- **`backend/`** — Node 22 + Hono + better-sqlite3 后端 API（用户、Token、书签同步、备份）
- **`web/`** — Vue 3 + Naive UI 管理台（仪表盘、书签管理、插件下载、Token、同步日志）
- **`deploy/`** — Docker 部署（compose + deploy.sh）；**`deploy/fnos/`** — 飞牛 fnOS fpk 应用包
- **`docs/`** — 架构、API、部署文档

## 本地开发

```bash
# 后端（tsx 热重载，测试 70 项）
cd backend && npm install && npm run dev && npm test

# 前端
cd web && npm install && npm run dev

# 扩展
# Chrome → chrome://extensions → 开发者模式 → 加载已解压 → 选 extension/
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node 22 + Hono + better-sqlite3 + Argon2 |
| 前端 | Vue 3 + Vite + Naive UI + Pinia |
| 扩展 | 原生 JS + Manifest V3（chrome.alarms 调度） |
| 认证 | JWT (HS256) + CSRF + API Token |
| 部署 | Docker Compose / 飞牛 fpk / Cloudflare Tunnel |

## 仓库

- **Gitee（主）**：https://gitee.com/zcoolq/mark-sync
- **GitHub（镜像）**：https://github.com/liushuai3/mark-sync
- **Docker Hub**：https://hub.docker.com/r/zcoolq/marksync

## 文档

- [架构设计](./docs/ARCHITECTURE.md)
- [API 规范](./docs/API.md)
- [部署指南](./docs/DEPLOYMENT.md)
- [扩展改造说明](./docs/EXTENSION.md)
- [飞牛 fnOS 上架包](./deploy/fnos/README.md)
