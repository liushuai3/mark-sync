# 扩展手动测试指南

## 加载扩展
1. Chrome → chrome://extensions/
2. 打开右上角"开发者模式"
3. 点"加载已解压的扩展程序"
4. 选择 `/vol2/1000/important-folders/it-projects/MarkSync/extension/` 目录

## 测试 MarkSync 自建后端模式

前提：后端已启动（`cd backend && npm run dev`），Web 端已注册用户并生成了 API Token。

1. 打开扩展设置（右键扩展图标 → 选项）
2. 选择"自建后端 (MarkSync)"
3. 填入：
   - API URL: `http://localhost:3000/api`
   - API Token: `mks_xxx...`（从 Web 管理台生成）
4. 点击"测试连接" → 应显示 ✅ + 用户名
5. 点击"保存设置"

## 测试 Gitee Gist 模式（回归）

1. 打开扩展设置
2. 选择"Gitee Gist"
3. 填入你的 Gitee 访问令牌
4. 保存

## 测试同步功能

1. 点击扩展图标打开 popup
2. 顶部应显示"当前后端: MarkSync 自建后端"
3. 点击"本地同步到云端" → 状态显示新增数量
4. 点击"云端同步到本地" → 状态显示完成
5. 打开 Web 管理台 → 书签页 → 应看到刚同步的书签

## 已知限制

- 首次 push 会把全部本地书签当增量发送，服务端去重
- 删除同步：需要通过 Web 管理台或 `chrome://bookmarks` 删除后手动同步
- 移动书签目前作为增量 push 处理，不会自动移动云端旧位置
