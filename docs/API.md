# MarkSync API 规范

Base URL: `https://bookmark.zcoolq.cn/api` (prod) / `http://localhost:3000/api` (dev)

所有响应统一格式：
```json
{ "ok": true, "data": {...} }
{ "ok": false, "error": "错误信息", "code": "ERROR_CODE" }
```

## 认证

两种 Bearer Token：
- **JWT**（Web 管理台）：登录后获取，7 天过期
- **API Token**（扩展）：格式 `mks_<32hex>`，用户在管理台生成

Header：`Authorization: Bearer <token>`

后端中间件自动识别：以 `mks_` 开头走 API Token 校验，否则走 JWT。

---

## 1. 认证接口

### POST /api/auth/register
注册（仅当 `REGISTRATION_OPEN=true` 或首个用户）

**Request**:
```json
{ "username": "zcoolq", "email": "a@b.com", "password": "xxx" }
```

**Response 200**:
```json
{
  "ok": true,
  "data": {
    "user": { "id": 1, "username": "zcoolq", "email": "a@b.com" },
    "token": "eyJhbGc..."
  }
}
```

**Response 403** (registration closed): `{ "ok": false, "error": "Registration closed", "code": "REG_CLOSED" }`

### POST /api/auth/login
```json
{ "username": "zcoolq", "password": "xxx" }
```
**Response**: 同 register

### POST /api/auth/logout
需 JWT。前端清理本地 token 即可，服务端无操作（无状态）。

### GET /api/auth/me
需 JWT。返回当前用户信息。
```json
{ "ok": true, "data": { "id": 1, "username": "zcoolq", "email": "a@b.com", "is_admin": 1 } }
```

### PUT /api/auth/password
需 JWT。修改密码。
```json
{ "old_password": "xxx", "new_password": "yyy" }
```

---

## 2. Token 管理（需 JWT）

### GET /api/tokens
列出当前用户所有未撤销 Token。
```json
{
  "ok": true,
  "data": [
    {
      "id": 1,
      "name": "MacBook Chrome",
      "token_prefix": "mks_abc12345",
      "last_used_at": 1783550000000,
      "expires_at": null,
      "created_at": 1783500000000
    }
  ]
}
```

### POST /api/tokens
创建新 Token。**明文只返回一次**。
```json
Request:  { "name": "MacBook Chrome", "expires_in_days": null }
Response: {
  "ok": true,
  "data": {
    "id": 1,
    "name": "MacBook Chrome",
    "token": "mks_a1b2c3d4e5f6...",   // 完整明文，立即保存
    "token_prefix": "mks_a1b2c3d4",
    "created_at": 1783550000000
  }
}
```

### DELETE /api/tokens/:id
撤销 Token（软删除）。

---

## 3. 书签同步（需 API Token）

### GET /api/sync/pull?since=<ts>
拉取书签。`since` 可选，返回 `updated_at > since` 的所有书签（包含 tombstone）。不带 `since` 则返回全部未删除书签。

**Response**:
```json
{
  "ok": true,
  "data": {
    "bookmarks": [
      {
        "id": "uuid-1",
        "type": "folder",
        "parent_id": null,
        "root": "bookmark_bar",
        "name": "工作",
        "url": null,
        "path": "/工作",
        "position": 0,
        "date_added": 1690701000000,
        "date_modified": null,
        "deleted_at": null,
        "version": 1
      },
      {
        "id": "uuid-2",
        "type": "url",
        "parent_id": "uuid-1",
        "root": "bookmark_bar",
        "name": "Vue 官网",
        "url": "https://vuejs.org",
        "path": "/工作/Vue 官网",
        "position": 0,
        "date_added": 1690701300000,
        "date_modified": null,
        "deleted_at": null,
        "version": 1
      }
    ],
    "server_time": 1783553606704
  }
}
```

### POST /api/sync/push
增量推送变更。

**Request**:
```json
{
  "added": [
    { "id": "uuid-3", "type": "url", "parent_id": "uuid-1", "root": "bookmark_bar", "name": "...", "url": "...", "path": "...", "date_added": 1783553000000 }
  ],
  "modified": [
    { "id": "uuid-2", "name": "Vue.js 官网", "date_modified": 1783553000000 }
  ],
  "removed": ["uuid-4"]
}
```

**去重逻辑**：
- `added` 里的书签，如果服务端已存在相同 `(user_id, url, path)`，跳过
- folder 用 `(user_id, path)` 去重

**Response**:
```json
{
  "ok": true,
  "data": {
    "added_count": 1,
    "modified_count": 1,
    "removed_count": 1,
    "skipped_count": 0
  }
}
```

### POST /api/sync/force
全量覆盖（谨慎）。传完整书签树，服务端软删除所有旧的，重新插入。

**Request**:
```json
{
  "bookmarks": [ /* 完整列表，格式同 pull */ ]
}
```

---

## 4. 书签管理（需 JWT，Web 管理台用）

### GET /api/bookmarks
分页查询。

**Query**:
- `page` (默认 1)
- `page_size` (默认 50, 最大 200)
- `search` (搜索 name/url/path)
- `root` ('bookmark_bar' | 'other' | 'mobile')
- `parent_id`
- `type` ('folder' | 'url')

**Response**:
```json
{
  "ok": true,
  "data": {
    "total": 1234,
    "page": 1,
    "page_size": 50,
    "items": [/* bookmark objects */]
  }
}
```

### GET /api/bookmarks/tree
返回完整树形结构。
```json
{
  "ok": true,
  "data": {
    "bookmark_bar": { "id": "root_0", "name": "书签栏", "children": [...] },
    "other": { ... },
    "mobile": { ... }
  }
}
```

### PUT /api/bookmarks/:id
编辑单个书签（name/url/parent_id）。

### DELETE /api/bookmarks/:id
软删除单个书签。

### POST /api/bookmarks/batch-delete
```json
{ "ids": ["uuid-1", "uuid-2"] }
```

---

## 5. 统计（需 JWT）

### GET /api/stats
```json
{
  "ok": true,
  "data": {
    "total_bookmarks": 1234,
    "total_folders": 56,
    "total_tokens": 3,
    "recent_syncs": [/* 最近 10 条 sync_log */],
    "last_sync_at": 1783553606704
  }
}
```

### GET /api/sync-logs?page=1&page_size=20
分页查询同步历史。

---

## 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `INVALID_INPUT` | 400 | 参数错误 |
| `UNAUTHORIZED` | 401 | 未认证 |
| `FORBIDDEN` | 403 | 无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 用户名/邮箱已存在 |
| `RATE_LIMITED` | 429 | 请求频率过高 |
| `REG_CLOSED` | 403 | 注册已关闭 |
| `SERVER_ERROR` | 500 | 服务器内部错误 |
