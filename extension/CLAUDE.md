# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

书签同步助手 — Chrome 浏览器扩展（Manifest V3），通过 Gitee 代码片段（Gist）API 在不同设备间同步浏览器书签。纯前端项目，无构建工具，使用 ES Modules 原生加载。

## 开发方式

此项目作为"未打包的扩展程序"直接在 Chrome 中加载：

1. 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择项目根目录
4. 修改代码后，在扩展管理页面点击刷新图标重新加载

没有构建、打包、lint 或测试命令。所有 JS 文件直接编辑，浏览器原生执行。

## 架构

```
manifest.json          # 扩展入口：权限声明、Service Worker 注册、popup/options 页面注册
background/
  background.js        # Service Worker：监听书签变更事件、自动同步调度、防抖处理
popup/
  popup.html/js/css    # 扩展弹窗主界面：手动同步按钮、强制上传、清除本地书签
  options.html/js/css  # 设置页：Gitee 访问令牌、自动同步开关、加密密钥、代码片段描述
  help.html/js/css     # 帮助页：从 docs/README.md 拉取内容，简单 Markdown→HTML 转换
  remote-bookmark.html/js  # 远程书签管理页：搜索/筛选/分页/批量删除/编辑云端书签
utils/
  bookmarkManager.js   # 核心业务逻辑类（全静态方法）：书签 CRUD、Gitee API 通信、加密、去重合并
docs/
  README.md            # 用户使用说明（中文 Markdown）
bookmark-format-sample.json  # 云端书签 JSON 数据格式示例
```

## 核心数据流

1. **书签存储格式**：`bookmark-format-sample.json` 定义了 v2.0 格式 — 三个根文件夹 `{ bookmark_bar, other, mobile }`，每个包含文件夹和 URL 节点的递归树
2. **Gitee Gist API**：私有代码片段存储，通过 Personal Access Token（gists 权限）认证。`BookmarkManager` 通过 `description` 字段匹配书签 Gist
3. **加密**：XOR 加密 + Base64 编码，密钥通过 `chrome.storage.sync` 存储（默认 `bookmark-sync-key`，用户可在设置中自定义）
4. **同步策略**：增量同步（URL+标题+路径 三元组去重），不会覆盖已有书签；强制上传为全量覆盖

## 关键约束

- **没有构建工具**：所有 JS 通过 `<script type="module">` 原生加载，import 路径使用 `../utils/bookmarkManager.js` 相对路径
- **浏览器兼容**：`background.js` 通过检测全局 `browser` vs `chrome` 对象兼容 Firefox/Chrome
- **chrome.storage.sync**：存储访问令牌、自动同步开关、Gist 描述、加密密钥；注意 `QUOTA_BYTES` 限制
- **Service Worker 生命周期**：`background.js` 在空闲时会被浏览器终止，状态靠 `chrome.storage` 和定时器重建
- **自动同步**：书签变化后防抖 3 秒执行，两次同步至少间隔 5 分钟，另设 30 分钟定期检查作为兜底
