# cpa-usage-stats

[English](README.en.md)

CLIProxyAPI（CPA 8.0+）用量统计插件：通过 usage 插件接口采集请求与 Token 用量，异步写入 SQLite，并提供内嵌看板。

## Fork 修复说明

本仓库 fork 自 [tom2almighty/cpa-usage-stats](https://github.com/tom2almighty/cpa-usage-stats)，保留上游作者与 AGPL-3.0 许可证。

- 管理请求固定同源，并拒绝重定向，移除可能将管理密钥发送至外站的 `api_base` 页面参数。
- 运行时统计通过实例快照传递，修复统计查询与重配置/暂停并发时递归读锁可能造成的死锁。
- 增加前端安全与后端并发回归测试。本仓库的插件源与 Releases 指向 fork 修复版；原作者的上游源不包含本 fork 的独立修复。

## 项目简介

- 采集请求、Token、延迟、失败等用量数据，按批异步写入 SQLite。
- 内置看板：用量总览（走势、维度分布、Token 构成、活动热力图）、调用明细和空间占用。
- 支持数据保留天数、模型排除、批量写入参数等配置。

## 增强能力

当前实现兼容 CPA v8 的 `UsageRecord.SelectionID` 和 `request.complete` 回调：

- 调用明细保存调度选择 ID，并支持 Trace/Selection/Session 筛选与聚合；
- `/v0/management/plugins/cpa-usage-stats/lifecycle` 提供请求终态分页，区分 `succeeded`、`failed`、`rejected`、`canceled`；
- 旧 SQLite 数据库采用追加式迁移；Worker 停止幂等，批量写入失败会有限重试并报告 `write_errors`。

## 开发环境配置

前置要求：

- Go 1.25+（需 CGO，装有 GCC 或 Clang）
- Node.js 24+ / pnpm 12+

```bash
./build.sh                              # 打包前端并编译动态库
go test ./...                           # 后端测试
cd web && pnpm install --frozen-lockfile && pnpm run dev  # 单独调试前端
```

前端始终同源调用插件接口，`?api_base=` 不再生效。开发时访问 `http://127.0.0.1:5173`，Vite 仅监听本机，并将插件管理接口转发到 `http://127.0.0.1:8317`，不跟随上游重定向。远程 CPA 可先用 SSH 将其端口转发到本机 8317；不要将开发服务器暴露到公网。

安全回归：在 `web/` 中执行 `pnpm test`；后端执行 `go test -race ./internal/...`。测试仅使用合成密钥和本地 HTTP 服务，不连接生产 CPA。

前端技术栈：React 19、TypeScript、Vite、Tailwind CSS v4、shadcn、Recharts、i18next。

## 构建与部署

### 插件商店安装

在 CPA 中添加本仓库的插件源，然后在管理中心插件商店选择该来源的 `CPA Usage Stats` 安装。官方源可能也包含同名插件，不能用官方源替代此 fork 源：

```yaml
plugins:
  enabled: true
  dir: "plugins"
  store-sources:
    - "https://raw.githubusercontent.com/lonnnnnng/cpa-usage-stats/main/plugin-store/registry.json"
```

### 手动安装

从 [本 fork 的 Releases](https://github.com/lonnnnnng/cpa-usage-stats/releases) 下载对应平台的压缩包，先按 `checksums.txt` 校验，再解压得到 `cpa-usage-stats.so`（Linux）/ `.dylib`（macOS）/ `.dll`（Windows），放入 CPA 的 `plugins` 目录。Docker 部署时，把动态库放进映射的插件目录。手动安装不建立商店来源记录；需要以后在商店更新时，优先使用上面的插件源安装。

```bash
mkdir -p /path/to/cliproxyapi/plugins
cp cpa-usage-stats.so /path/to/cliproxyapi/plugins/
```

### 配置

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    cpa-usage-stats:
      enabled: true
      priority: 10
      db_path: "plugins/cpa-usage-stats/usage.db" # SQLite 数据库路径，相对 CPA 工作目录
      batch_size: 100                             # 批量写入条数阈值
      flush_interval_ms: 1000                     # 批量写入最长缓冲时间（毫秒）
      channel_size: 10000                         # 内存队列容量，写满会丢弃新记录
      retention_days: 90                          # 历史保留天数，0 为永久
      exclude_models: []                          # 不记录的模型或别名
      dashboard_path: "/dashboard"                # 看板资源路径
      dashboard_title: "用量统计"                  # 管理中心菜单名称
```

### 本地打包

```bash
./scripts/package-release.sh 0.5.4
```

产物写入 `release-dist/`，包含平台压缩包与 `checksums.txt`。

推送 `v*` 标签会运行 Release 工作流并发布各平台安装包。也可在 GitHub Actions 手动重跑 Release，但必须选择对应版本标签；CI 工作流支持手动运行。

### 使用

在管理中心插件列表点击「用量统计」，或直接访问：

```text
http://127.0.0.1:8317/v0/resource/plugins/cpa-usage-stats/dashboard
```

- 看板通过插件管理接口（`/v0/management/plugins/cpa-usage-stats/*`，需管理密钥）读取数据。
- 管理密钥按以下顺序解析：本插件保存的（`localStorage`）→ cpa-dashboard 面板保存的 → 官方管理中心保存的。
- 都读不到时看板照常渲染但不发请求，点击右上角「管理密钥」输入即可。
- CPA 对同一 IP 连续 5 次认证失败会临时封禁约 30 分钟，因此缺少密钥时看板不会尝试请求。

### Docker

```yaml
services:
  cli-proxy-api:
    image: ghcr.io/router-for-me/cliproxyapi:latest
    volumes:
      - ./plugins:/app/plugins
      - ./config.yaml:/app/config.yaml
    ports:
      - "8317:8317"
```

把动态库放到 `./plugins` 后重启容器即可。

## 开源许可证

[AGPL-3.0](LICENSE)
