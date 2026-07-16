# CHANGELOG

## v3.0.0-beta.1 — 2026-07-15

**重大重构：双向增量同步引擎**

> **部署说明**：当前为热部署状态 — backend `dist/` 已适配到 v3.0 运行中容器（镜像标签仍为 v2.0.1）。
> 完成产物：`backend/dist-v3.0.0-beta.1.tar.gz`（供后续 CI 打完整镜像）。
> **TODO：**基于 `deploy/docker-compose.yml` 重建完整 backend 镜像，将镜像标签同步升至 `3.0.0-beta.1`。

老版本（v2.x）基于扩展本地 `path` 字段的单向"客户端权威"推送。设备之间任何一方删除都会被另一方无声还原，编辑冲突以随机顺序覆盖，长期使用不可靠。v3.0 从数据模型、传输协议、客户端调度三个层面重构。

### 数据模型

| 变更 | 说明 |
| --- | --- |
| `bookmarks.path` 移除 | 层级完全由 `parent_id` 派生，服务器不再存冗余路径 |
| `id` 改为客户端生成的 UUID | 首次接入通过 (root, parent_path, name, url) 去重合并，稳定后 id 即真相 |
| 新增 `server_updated_at` | 服务器时间戳，作为增量拉取的 `since` 基线 |
| 新增 `version` | 每次修改 +1，用于观测/调试 |
| `deleted_at` 保留 30 天 | 墓碑窗口内可跨设备传播删除，之后 GC |

### API

| 端点 | 变更 |
| --- | --- |
| `GET /api/sync/pull?since=<ms>` | `since` 缺失/非法/超过 30 天窗口 → `full: true` 返回全量含墓碑；否则返回 `server_updated_at > since` 的增量行 |
| `POST /api/sync/push` | 输入 `{added, modified, removed}`，每个 modified/removed 携带 `date_modified`；服务器按字段级 LWW 判决，冲突返回 `conflicts: [{id, reason: newer_exists\|already_deleted\|not_found}]` |
| `POST /api/sync/force` | 用户显式覆盖：软删所有现有行，插入客户端提交的快照 |

冲突判决规则（SRS §7.2）：

- **修改 vs 修改**：`date_modified` 大者胜
- **修改 vs 删除**：删除赢（30 天窗口内）
- **添加 vs 已存在 id**：`newer_exists`，客户端应改用 modified

所有 push 操作幂等：重复 `remove` 已墓碑的行、`add` 已存在 id、`modify` 早于服务器的更新，都不会污染数据、不会报错。

### 扩展

- 后台调度改为 `chrome.alarms` 定时（默认每 15 分钟一次 pull+push 循环，SRS §9.3）
- 移除 `chrome.bookmarks.onChanged/Created/Removed/Moved` 事件监听器 —— 避免本地事件风暴导致的丢失和乱序
- 新增 `idMapStore`（本地书签 id ↔ 服务端 UUID）、`syncState`（LKG 状态）、`uuid` 三个持久化模块
- 首次接入执行 `initialMerge`：本地 vs 服务器按 (root, parent_path, name, url) 去重，本地新有的推送，服务器新有的下拉
- Popup 新增手动 `Sync now` / `Force upload` / 状态显示；Options 新增服务器测试、Token 保存、权限授予

### 后端

- 迁移逻辑：启动时检测 `PRAGMA table_info(bookmarks)`，若有 `path` 或缺 `server_updated_at` 则 `DROP TABLE bookmarks`，重新按 v3.0 schema 建表。**用户 / API Token / 备份 / 同步日志 / 系统设置全部保留**
- `sync_logs` 保留（含 `duration_ms`）
- `backup.ts` 与 `bookmarks.ts` 全部去 `path` / `updated_at`，改走 `server_updated_at` + `date_modified`

### 测试

`backend/scripts/test.mjs` 完全重写：

- 保留 12 项 v2 有效用例（health / auth / register / login / tokens / stats / logs / tree / revoke）
- 新增 20+ 项 v3.0 sync 场景（无 since、有 since、过期 since、added 冲突、modified LWW、modified 墓碑、removed 幂等、force 覆盖）
- 自动 spawn 独立后端 + 临时 DB，独立于生产数据
- **共 52 项全部通过**

### 破坏性变更（Breaking）

1. 客户端必须升级到 3.0（Chrome/Firefox `manifest.json` 已 bump 到 3.0.0）。旧客户端调用 `/api/sync/push` 会因缺失 `date_modified` 字段而 400。
2. 服务器升级时会 DROP `bookmarks` 表 —— **书签数据将被清空**。建议升级前手工点一次"下载 JSON"备份。
3. `PUT /api/bookmarks/:id` 不再接受 `path` 字段（web 管理台仍显示 path，但保存时该字段会被忽略）。

### 遗留

- Web 管理台的书签编辑表单仍显示"路径"输入（未拆表示层）。此版本简化：字段被 API 忽略，不影响数据一致性。UI 面包屑重构留待 v3.1。
- Extension `scripts/zip-extension.cjs` 依赖 `archiver` 全局模块；本次打包退回到系统 `zip` 命令。若需生产 CI 打包，安装 `npm i -g archiver`。

### Commits

- 77c5ca2 P0: schema v3 - drop path, add server_updated_at & version
- b795988 P2: add idMapStore, syncState, uuid client modules
- a3014f3 P1: rewrite sync API - LWW conflicts, incremental pull, tombstone cleanup
- 47b71db P3: initialMerge - dedupe by (root,parent_path,name,url), create missing, push new
- 4ce8afc P4: syncCycle - bidirectional LWW sync, remote apply, local diff
- a6a4945 P5: chrome.alarms scheduling, remove bookmark event listeners, add forceUpload
- 951ea86 P6: popup UI (sync/force/status), options (test/save/permissions)
- **P7 (this): fix tests, rebuild ext/web, deploy, changelog**
