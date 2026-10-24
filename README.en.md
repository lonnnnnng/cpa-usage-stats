# cpa-usage-stats

[中文](README.md)

CLIProxyAPI (CPA 8.0+) usage statistics plugin: collects request and token usage through the usage plugin API, persists it asynchronously to SQLite, and ships an embedded dashboard.

## Fork fixes

Forked from [tom2almighty/cpa-usage-stats](https://github.com/tom2almighty/cpa-usage-stats), preserving upstream attribution and the AGPL-3.0 license.

- Management requests are same-origin only and reject redirects. The `api_base` page parameter, which could send a management key to another server, is removed.
- Runtime statistics use per-instance snapshots, avoiding recursive read-lock deadlocks during concurrent statistics queries and reconfiguration/quiesce.
- Added frontend security and backend concurrency regression tests. The upstream store source and Releases below do not include these fork fixes; build this repository to use the fixed version.

## Overview

- Collects requests, tokens, latency and failures, then writes them to SQLite in asynchronous batches.
- Embedded dashboard with usage trends, breakdowns, token composition, an activity heatmap, request details and storage usage.
- Configurable retention, excluded models and batch-write parameters.

## Development

Requirements:

- Go 1.25+ with CGO (GCC or Clang)
- Node.js 24+ / pnpm 12+

```bash
./build.sh                              # build frontend and shared library
go test ./...                           # backend tests
cd web && pnpm install --frozen-lockfile && pnpm run dev  # frontend only
```

API requests always target the page origin; `?api_base=` is ignored. For development, open `http://127.0.0.1:5173`. Vite listens on loopback only and proxies plugin management requests to `http://127.0.0.1:8317` without following redirects. For remote CPA instances, forward their port to local port 8317 over SSH. Do not expose the development server publicly.

Run `pnpm test` in `web/` for security regressions and `go test -race ./internal/...` for backend regressions. Tests use synthetic keys and local HTTP servers, never a production CPA instance.

Frontend stack: React 19, TypeScript, Vite, Tailwind CSS v4, shadcn, Recharts, i18next.

## Build and deployment

### Install from the plugin store

Once listed in the official plugin store, search for `CPA Usage Stats` in the Management Center. Alternatively, add this repository's store source to CPA:

```yaml
plugins:
  enabled: true
  dir: "plugins"
  store-sources:
    - "https://raw.githubusercontent.com/tom2almighty/cpa-usage-stats/main/plugin-store/registry.json"
```

### Manual install

Download the archive for your platform from [Releases](https://github.com/tom2almighty/cpa-usage-stats/releases) and place `cpa-usage-stats.so` (Linux), `.dylib` (macOS) or `.dll` (Windows) into CPA's `plugins` directory. For Docker, place the shared library in the mounted plugin directory.

```bash
mkdir -p /path/to/cliproxyapi/plugins
cp cpa-usage-stats.so /path/to/cliproxyapi/plugins/
```

### Configuration

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    cpa-usage-stats:
      enabled: true
      priority: 10
      db_path: "plugins/cpa-usage-stats/usage.db" # SQLite path, relative to the CPA working directory
      batch_size: 100                             # batch write threshold
      flush_interval_ms: 1000                     # maximum buffering time in milliseconds
      channel_size: 10000                         # in-memory queue capacity; new records are dropped when full
      retention_days: 90                          # retention in days; 0 keeps data forever
      exclude_models: []                          # models or aliases that should not be recorded
      dashboard_path: "/dashboard"                # dashboard resource path
      dashboard_title: "Usage Stats"              # Management Center menu label
```

### Local packaging

```bash
./scripts/package-release.sh 0.1.7
```

Artifacts are written to `release-dist/` with platform archives and `checksums.txt`.

### Usage

Open `Usage Stats` from the Management Center plugin list, or visit:

```text
http://127.0.0.1:8317/v0/resource/plugins/cpa-usage-stats/dashboard
```

- The dashboard reads data through the plugin management API (`/v0/management/plugins/cpa-usage-stats/*`, management key required).
- The management key is resolved in this order: saved by this plugin (`localStorage`) → saved by cpa-dashboard → saved by the official Management Center.
- Without a key the dashboard still renders but sends no requests; use the "Management key" action in the top-right corner.
- CPA temporarily bans an IP for about 30 minutes after five consecutive authentication failures, so the dashboard never sends requests without a key.

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

Place the shared library in `./plugins` and restart the container.

## License

[AGPL-3.0](LICENSE)
