# MarkSync 扩展改造说明

## 基于原 BookmarkSync 的改动

原项目：`/vol2/1000/important-folders/it-projects/BookmarkSync/`
新项目：`/vol2/1000/important-folders/it-projects/MarkSync/extension/`

### 保留

- ✅ Manifest V3 结构
- ✅ Service Worker 生命周期
- ✅ 书签事件监听 + 防抖 3s + 定时兜底 30min
- ✅ Gitee Gist 模式（**保留为可选**）
- ✅ XOR + Base64 加密（Gitee 模式用，自建后端不加密）
- ✅ 三元组去重合并（本地合并逻辑不变）

### 新增

1. **后端类型选择**（options 页面）
   - Gitee Gist（原有）
   - **自建后端 MarkSync**（新增）

2. **`utils/backend/`** 目录 — 后端策略
   - `gitee.js` — 原逻辑抽取
   - `marksync.js` — 新增，调用 MarkSync API
   - `index.js` — 工厂，根据配置返回对应实例

3. **`utils/bookmarkManager.js`** 重构
   - 提取业务逻辑（书签树遍历、去重合并）
   - 通过依赖注入使用 backend

4. **品牌变更**
   - 名称：MarkSync
   - 图标：新设计（暂用原 icon 占位，后续替换）

### 目录结构

```
extension/
├── manifest.json          # name 改 MarkSync
├── background/
│   └── background.js      # 保持原逻辑
├── popup/
│   ├── popup.html/js/css
│   ├── options.html/js/css   # 新增后端类型 tab
│   ├── help.html/js/css
│   ├── remote-bookmark.html/js
│   └── tokens.html/js        # 新增：帮助用户跳转 Web 管理台创建 Token
├── utils/
│   ├── bookmarkManager.js
│   └── backend/
│       ├── index.js
│       ├── gitee.js
│       └── marksync.js
├── icons/
└── docs/
    └── README.md
```

### 配置存储

`chrome.storage.sync` 键值：
```js
{
  backend_type: 'gitee' | 'marksync',       // 新增
  gitee_token: '...',                       // 原有
  gitee_description: 'MarkSync',            // 原有
  encryption_key: '...',                    // 原有（Gitee 模式）
  marksync_api_url: 'https://bookmark.zcoolq.cn/api',  // 新增
  marksync_token: 'mks_...',                // 新增
  auto_sync: true,                          // 原有
}
```

### MarkSync 后端策略实现要点

`utils/backend/marksync.js`:

```js
export class MarkSyncBackend {
  constructor({ apiUrl, token }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.token = token;
  }

  async request(path, opts = {}) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'API error');
    return data.data;
  }

  async pull() {
    return this.request('/sync/pull');
  }

  async push({ added, modified, removed }) {
    return this.request('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ added, modified, removed }),
    });
  }

  async force(bookmarks) {
    return this.request('/sync/force', {
      method: 'POST',
      body: JSON.stringify({ bookmarks }),
    });
  }

  async test() {
    // GET /auth/me 只是验证 token 有效性
    return this.request('/auth/me');
  }
}
```

### 数据格式转换

**Chrome 书签树 → API 扁平数组**（push 时）:
```
遍历 chrome.bookmarks.getTree()
  → 递归时生成 UUID 作为 id
  → 记录 parent_id, root（顶层 = bookmark_bar/other/mobile）
  → 计算 path（父路径 + name）
  → 输出扁平数组
```

**API 扁平数组 → Chrome 书签树**（pull 时）:
```
按 parent_id 建立 map
  → 从三个 root 开始遍历
  → chrome.bookmarks.create({ parentId, title, url })
  → 记录新旧 ID 映射（chrome API 会分配新 ID）
```

### 冲突处理

- 本地新增 → push 时后端去重（相同 url+path 跳过）
- 本地删除 → push removed → 后端软删除
- 云端新增 → pull 时本地去重（相同 url+path 跳过）
- 云端删除 → pull 带 `since` 参数取到 tombstone → 本地删除对应书签

### UI 变化

**options.html** 新增区域:
```
[后端类型] ○ Gitee Gist  ● 自建后端 MarkSync

--- Gitee Gist 配置 ---（仅当选 Gitee 时显示）
访问令牌: [____________]
代码片段描述: [MarkSync]
加密密钥: [____________]

--- MarkSync 配置 ---（仅当选自建后端时显示）
API URL: [https://bookmark.zcoolq.cn/api]
API Token: [mks_____________________]
[测试连接]

📖 如何获取 Token？
  1. 打开 https://bookmark.zcoolq.cn
  2. 登录后进入"API Token"页面
  3. 点击"创建新 Token"
```
