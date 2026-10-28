# MarkSync · 飞牛 fnOS 应用中心上架包

## 目录

- `marksync/` — fpk 包源（manifest / compose / 生命周期脚本 / 图标）
- `gen_icons.py` — 图标生成脚本（纯 stdlib，与扩展 SVG logo 视觉一致）
- `screenshots/` — 应用中心提交用截图

## 构建

```bash
cd deploy/fnos/marksync
fnpack build          # 产出 marksync.fpk
```

图标变更后重新生成：

```bash
/usr/bin/python3 deploy/fnos/gen_icons.py
```

## 本机已验证清单（2026-10-25，fnOS + appcenter-cli 1.0.1）

- `install-fpk --env` 安装，安装向导收集管理员账号 → 注入容器环境变量
- 启动时 `ensureAdminUser` 创建 admin/is_admin=1，登录可用
- `/health` 返回 `version:"4.0"`，Web 200，`cmd/main status` 与容器状态一致
- 覆盖升级（9.9.9 → 9.9.10）数据保留（`${TRIM_PKGVAR}/data`）
- 卸载干净，无容器残留

## 版本与镜像对齐规则（必读）

- `manifest` 的 `version` 与 Docker Hub 镜像 tag **严格一致**（当前 4.0.0），
  不一致时报误导性 `manifest unknown`
- 同版本 fpk 应用中心拒绝覆盖安装——迭代验证用修订号 `x.y.z-<整数>`（如
  `4.0.0-2`，fnpack 强制格式），镜像 tag 仍用原版（compose 引用存在即可）
- 发版流程：①改 manifest version=4.0.1 ②构建镜像 `docker build -t zcoolq/marksync:4.0.1 .`
  并推送 ③`fnpack build` ④提交应用中心

## 上架提交

1. 打包 `marksync.fpk`
2. 加飞牛粉丝群 → 联系社区主理人 → 进「应用中心开发者先锋交流群」
3. 提交材料：fpk + 图标 + 截图 + 下方应用描述

### 应用描述（商店文案，与 manifest `desc` 富文本同步维护）

> MarkSync 是一套**自托管的浏览器书签多端双向同步系统**：NAS 上一个轻量服务 +
> Chrome / Edge / Firefox 浏览器扩展，让电脑、手机、平板的所有书签保持一致，
> 数据只存放在你自己的 NAS 上，不出家门。
>
> **核心能力**
> - **双向增量同步**：每台设备独立 UUID，只传输变更内容；默认每 5 分钟自动同步 + 书签变更实时监听
> - **可靠不丢数据**：删除墓碑传播到所有设备、字段级 LWW 冲突自动合并、推送失败自动回滚基线、分批推送与断网退避重试
> - **自动去重**：重复书签自动收敛，扩展内也可手动一键清理
> - **多用户与安全**：JWT 登录、API Token 管理、多账号数据隔离
> - **Web 管理台开箱即用**：仪表盘、书签管理、扩展下载、同步日志、备份恢复，并提供完整 REST API
> - **浏览器全覆盖**：扩展已上架 Chrome 应用商店与 Edge 加载项商店，Firefox 用 zip 安装
>
> **三步开始使用**
> 1. 本应用一键安装，安装向导中设置管理员账号（默认端口 8888）
> 2. 登录 Web 管理台 → Token 管理 → 创建 API Token
> 3. 各浏览器安装 MarkSync 扩展，填入 NAS 地址与 Token，即刻同步
>
> **界面预览**（`<img>` 托管于 Cloudflare Pages：https://img.zcoolq.cn/ ）
> - Web 管理台 · 仪表盘 / 扩展下载页（dashboard.png、extension-page.png）
> - 浏览器扩展 · 同步状态弹窗 / 设置页（popup.png、options.png）
>
> 开源免费，源码与文档见 GitHub / Gitee 仓库。

> 注：manifest 的 `desc` 字段为单行 HTML（官方支持），应用中心详情页经
> filterXSS 过滤后按 HTML 渲染（`<p>/<b>/<h3>/<ul>/<ol>/<li>/<img>` 均在默认白名单，
> img 支持 `src/alt/title/width/height/loading` 属性）。
> 图片必须是公网可访问的 https 绝对 URL。托管演进史（2026-10-28 定稿）：
> ① Gitee raw——外域 Referer 403 防盗链，不可用 ② 项目站点自托管——与应用
> 实例/镜像耦合（旧镜像缺文件时 SPA 回落 index.html 伪装成登录页，已另修
> 404）③ **现方案 Cloudflare Pages `img.zcoolq.cn`**——与 NAS/应用彻底解耦，
> 源文件在 `deploy/fnos/store-images/`，部署 `CLOUDFLARE_API_TOKEN=...
> CLOUDFLARE_ACCOUNT_ID=3b17ca3d537ec21b8f2eb31962a36614 ./deploy-store-images.sh`。
> 修改文案/图片后需 `fnpack build` 重新打包并递增修订号。

### 安装说明（给审核/用户）

- 安装时可设置管理员账号（也可留空，启动后开放注册，首个注册用户即管理员）
- 浏览器扩展安装后，在扩展设置页填入 `http://<NAS地址>:8888/api` 与 API Token
- Chrome / Edge 商店搜索「MarkSync 书签同步」可直接安装扩展

## 已知边界

- `platform=x86`：fnOS 第三方应用当前仅 x86_64；镜像为 amd64 单架构
- 默认端口 8888（manifest service_port），与其它应用冲突时飞牛会提示调整
- 官方商店上架需人工进群提交，开发者后台（developer.fnnas.com）上线前无自助通道
