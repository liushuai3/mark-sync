# MarkSync 架构设计

## 系统架构

```
┌───────────────┐         ┌──────────────────┐        ┌────────────────┐
│ Chrome 扩展   │  HTTPS  │  Backend API     │  SQL   │  SQLite        │
│ - 本地书签监听 │◄───────►│  Node + Hono     │◄──────►│  bookmarks.db  │
│ - 支持双模式   │  Token  │  - 用户/Token    │        │  (单文件)      │
└───────────────┘         │  - 书签同步      │        └────────────────┘
                          └────────┬─────────┘
                                   │ HTTPS + JWT
                                   ▼
                          ┌──────────────────┐
                          │  Web 管理台      │
                          │  Vue3 + NaiveUI  │
                          └──────────────────┘
```

## 数据流

### 扩展 → 后端同步

```
用户操作书签
  → chrome.bookmarks 事件触发
  → background.js 防抖 3s
  → 读取本地书签树
  → 展平为 bookmark 数组
  → POST /api/sync/push
  → 后端合并（去重/软删除）
  → 返回同步结果
```

### 拉取同步

```
用户点击"云端同步到本地"
  → GET /api/sync/pull?since=<timestamp>
  → 后端返回未删除的书签列表
  → 前端构造书签树
  → 与本地书签合并（三元组去重）
  → chrome.bookmarks.create 逐个创建
```

## 数据库设计（SQLite）

### users
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,        -- Argon2id
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### api_tokens
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- 设备名
  token_hash TEXT UNIQUE NOT NULL,    -- SHA256(token)
  token_prefix TEXT NOT NULL,         -- "mks_abc12345" 前 12 位
  last_used_at INTEGER,
  expires_at INTEGER,                 -- NULL = 永不过期
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_tokens_user ON api_tokens(user_id);
CREATE INDEX idx_tokens_hash ON api_tokens(token_hash);
```

**Token 格式**：`mks_<32 hex chars>`，共 36 字符
- 明文只在创建时返回一次
- 数据库存 SHA256(token)
- 前缀 `mks_xxxxxxxx` 用于列表显示

### bookmarks
```sql
CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,                -- UUID v4
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                 -- 'folder' | 'url'
  parent_id TEXT,                     -- 父文件夹 id，NULL = root
  root TEXT NOT NULL,                 -- 'bookmark_bar' | 'other' | 'mobile'
  name TEXT NOT NULL,
  url TEXT,                           -- folder 为 NULL
  path TEXT NOT NULL,                 -- '/工作/前端/Vue' 便于搜索+去重
  position INTEGER DEFAULT 0,
  date_added INTEGER,
  date_modified INTEGER,
  deleted_at INTEGER,                 -- NULL = 存在，非 NULL = tombstone
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id, deleted_at);
CREATE INDEX idx_bookmarks_url ON bookmarks(user_id, url);
CREATE INDEX idx_bookmarks_path ON bookmarks(user_id, path);
CREATE INDEX idx_bookmarks_updated ON bookmarks(user_id, updated_at);
```

**去重规则**：`(user_id, url, path)` 三元组，folder 用 `(user_id, path)`

**软删除**：删除操作只更新 `deleted_at`，pull 时 `WHERE deleted_at IS NULL`；tombstone 保留 30 天后清理（cron 或手动）

### sync_logs
```sql
CREATE TABLE sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
  action TEXT NOT NULL,               -- 'push' | 'pull' | 'force_push'
  added_count INTEGER DEFAULT 0,
  removed_count INTEGER DEFAULT 0,
  modified_count INTEGER DEFAULT 0,
  device_info TEXT,                   -- User-Agent
  ip TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_synclogs_user ON sync_logs(user_id, created_at DESC);
```

## 认证机制

### JWT（Web 管理台）
- Header: `Authorization: Bearer <JWT>`
- Payload: `{ sub: user_id, iat, exp }`, `exp = iat + 7d`
- 算法: HS256
- Secret: 环境变量 `JWT_SECRET`（首启动自动生成）

### API Token（扩展）
- Header: `Authorization: Bearer mks_<32hex>`
- 中间件自动识别前缀 `mks_` → 查 `api_tokens.token_hash`
- 命中后设置 `c.set('user', user)` + `c.set('token', token)`
- 更新 `last_used_at`

## 权限模型

**单用户模式**（默认）：
- 首次访问后端 `/api/auth/register` 允许注册一个 admin
- 之后 `REGISTRATION_OPEN=false` 环境变量关闭注册
- 所有 API 只操作 `user_id = current_user.id` 的数据

**多用户扩展**（未来）：
- 设 `REGISTRATION_OPEN=true`
- 每个用户完全隔离

## 部署拓扑

```
Internet
   ↓
Cloudflare Tunnel (marksync.zcoolq.cn)
   ↓
NAS 192.168.31.197:8888
   ↓
Docker Container
   ├─ backend  (Bun, 内部 :3000)
   └─ web      (静态文件, backend 一起 serve)
   ↓
Volume mount → /vol2/1000/.../MarkSync/backend/data/
```

Web 静态文件通过 Hono `serveStatic` 直接由后端提供，无需 Nginx。

## 安全考量

1. **密码**：Argon2id，`memoryCost=19456, timeCost=2, parallelism=1`（OWASP 推荐）
2. **Token**：仅 SHA256 存储，无法反查明文；创建时一次性返回明文
3. **JWT Secret**：`crypto.randomBytes(32).toString('hex')`，持久化到 `data/jwt.secret`
4. **CORS**：白名单 `http://localhost:5173` (dev) + 生产域名
5. **Rate Limit**：登录接口每 IP 5次/分钟（用 Bun 内存 Map 实现）
6. **HTTPS**：Cloudflare Tunnel 自动 TLS
7. **SQL 注入**：全部用 `db.prepare().run()` 参数化查询
