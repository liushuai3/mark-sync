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

### 应用描述（商店文案）

> 自托管浏览器书签多端双向同步服务。支持 Chrome / Edge 浏览器扩展
> （已上架应用商店），增量同步、删除墓碑、字段级冲突合并；数据保存在
> 本地 SQLite，自带 Web 管理后台、多用户与 REST API。

### 安装说明（给审核/用户）

- 安装时可设置管理员账号（也可留空，启动后开放注册，首个注册用户即管理员）
- 浏览器扩展安装后，在扩展设置页填入 `http://<NAS地址>:8888/api` 与 API Token
- Chrome / Edge 商店搜索「MarkSync 书签同步」可直接安装扩展

## 已知边界

- `platform=x86`：fnOS 第三方应用当前仅 x86_64；镜像为 amd64 单架构
- 默认端口 8888（manifest service_port），与其它应用冲突时飞牛会提示调整
- 官方商店上架需人工进群提交，开发者后台（developer.fnnas.com）上线前无自助通道
