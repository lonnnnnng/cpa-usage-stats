# cpa-usage-stats

[English](README.en.md)

CLIProxyAPI（CPA 8.0+）用量统计插件：通过 usage 插件接口采集请求与 Token 用量，异步写入 SQLite，并提供内嵌看板。

## Fork 修复说明

本仓库 fork 自 [tom2almighty/cpa-usage-stats](https://github.com/tom2almighty/cpa-usage-stats)，保留上游作者与 AGPL-3.0 许可证。

- 管理请求固定同源，并拒绝重定向，移除可能将管理密钥发送至外站的 `api_base` 页面参数。
- 运行时统计通过实例快照传递，修复统计查询与重配置/暂停并发时递归读锁可能造成的死锁。
- 汇总改为一次窄列扫描，保留原分组、缓存计费和百分位口径；请求终态增加时间索引，空间统计分别走计数与时间端点查询。
- 首页、明细、筛选选项独立加载，翻页不重新计算汇总；定时刷新复用在途请求，避免慢请求叠加。
- 增加前端安全与后端并发回归测试。本仓库的插件源与 Releases 指向 fork 修复版；原作者的上游源不包含本 fork 的独立修复。

### 已同步的上游改进

- 管理中心 v2 保存凭据兼容（`a8ee040`）：只读取同主机、明确选择记住密码的 v2 状态，保留本插件和面板密钥优先级。
- Kimi/Moonshot 定价映射（`ca686b3`）与 Google RPC 错误原因分类（`136d895`）。错误分类用于新写入记录，历史记录不回填。
- 多模态 Token（`a1a1c70`）与缓存写入 5 分钟/1 小时 TTL 明细（`ace0ed1`）：在调用明细中记录并展示可选细分；未报告的字段省略，明确的零值显示为 0。

这些改进来自 [tom2almighty/cpa-usage-stats](https://github.com/tom2almighty/cpa-usage-stats)，已适配本 fork 的汇总优化、时间处理和安全测试。数据库仅追加 13 个可空列，旧记录保留；细分是否存在取决于宿主和模型上游是否报告，不能从历史总量恢复。细分用于查看原始用量，费用仍沿用现有总量计价。

## 项目简介

- 采集请求、Token、延迟、失败等用量数据，按批异步写入 SQLite。
- 内置看板：用量总览（走势、维度分布、Token 构成、活动热力图）、调用明细和空间占用。
- 支持数据保留天数、模型排除、批量写入参数等配置。

## 增强能力

当前实现兼容 CPA v8 的 `UsageRecord.SelectionID` 和 `request.complete` 回调：

- 调用明细保存调度选择 ID，并支持 Trace/Selection/Session 筛选与聚合；
- `/v0/management/plugins/cpa-usage-stats/lifecycle` 提供请求终态分页，区分 `succeeded`、`failed`、`rejected`、`canceled`；
- 旧 SQLite 数据库采用追加式迁移；Worker 停止幂等，批量写入失败会有限重试并报告 `write_errors`。

### 请求终态与统计可靠性

看板增加“请求终态”页签，可按时间范围、终态 Request ID、Trace ID、模型和成功/失败/拒绝/取消筛选。它展示 CPA 已上报的事件，也包括没有 Token 用量的请求，不代表覆盖全部 HTTP 请求。终态 ID 和用量执行 ID 属于不同层级，同一 Trace 可有多个事件，不进行一对一关联。没有事件不能推断请求仍在运行；取消事件未提供 HTTP 状态时显示为未提供。

页面使用 `/lifecycle?view=events` 的固定字段投影，不传输任意 Metadata；省略 `view` 的原始管理接口保留兼容。终态缺少完成时间时，查询和保留策略使用接收时间。用量和终态共享 `retention_days`；手工清理在同一事务删除选定范围的两类记录，响应分别提供 `deleted_records`、`deleted_lifecycle_records`，空间统计增加 `lifecycle_record_count`。

CPA 的非空 Request ID 表示唯一执行实例。插件在保留窗口内忽略重复 ID 的后续用量投递，采用首次写入值；保留历史重复数据，也兼容没有 ID 的旧记录。队列满或插件暂停时返回明确拒收错误，支持重试的宿主路径可据此重投；普通本地宿主不保证重试，成功回执只表示接受异步队列，不代表已经持久化。终态回调保持实例锁直至落盘，避免重配置关闭正在写入的库。

### 调用明细筛选

模型、提供商、客户端 Key、凭据与执行结果按实际存储值匹配。Trace、会话、Selection ID 精确条件收纳到“高级筛选”；Selection ID 只在调度器提供时存在。关键字按原文子串匹配请求/追踪/调度/会话 ID、模型、别名、客户端 Key 和失败正文，`%`、`_` 不作为通配符。空格归一化和组合防抖避免页码反复回到第一页；筛选只作用于调用明细，概览使用独立的全局时间范围。停留明细页时下拉选项每60秒更新，认证失败后停止自动探测。

### 汇总接口

`GET /v0/management/plugins/cpa-usage-stats/summary` 保持完整响应，原有 `range` 和筛选参数继续生效。

首页使用 `summary?range=all&view=overview`（其他范围同样支持），返回全部概览指标、趋势及模型、供应商、客户端 Key、凭据、会话五个维度。这个视图不计算或返回 `trace_stats`、`selection_stats`、`unique_traces`、`unique_sessions`、`lifecycle`、`failure_stats`，避免为首页未展示的关联明细生成和传输大量数据；省略 `view` 仍返回这些字段。

上述接口仍需原管理密钥。概览不会截断五个维度的结果，费用和维度切换沿用原始完整分组。

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

当前 Release 流水线仅构建 Linux ARM64 安装包。请从 [本 fork 的 Releases](https://github.com/lonnnnnng/cpa-usage-stats/releases) 下载 `cpa-usage-stats_<版本>_linux_arm64.zip`，先按 `checksums.txt` 校验，再解压得到 `cpa-usage-stats.so`，放入 CPA 的 `plugins` 目录。Docker 部署时，把动态库放进映射的插件目录。手动安装不建立商店来源记录；需要以后在商店更新时，优先使用上面的插件源安装。

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

推送 `v*` 标签会运行 Release 工作流并发布 Linux ARM64 安装包。也可在 GitHub Actions 手动重跑 Release，但必须选择对应版本标签；CI 工作流支持手动运行。

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
