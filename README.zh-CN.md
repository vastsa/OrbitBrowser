# Orbit Browser

语言：[English](README.md) | 简体中文

Orbit Browser 是一个本地浏览器运行时编排器，用于管理隔离的
Chrome/Chromium Profile、代理、自动化任务和运行产物。

它基于 Tauri 2、React、TypeScript 和 Rust 构建，适合需要在本机多环境中
稳定运行浏览器任务、保存日志和管理产物的场景。

## 当前状态

项目处于早期可用阶段，核心链路已经打通：

- 本地桌面端可运行。
- 支持环境、任务、运行记录、设置和诊断中心。
- 支持 Chrome/Chromium/Edge 自动检测和手动路径配置。
- 支持隔离 Profile、代理配置、代理认证扩展和运行产物管理。
- 支持 GitHub Actions 在 tag 上自动打包 Linux release。

macOS 和 Windows 安装包需要对应系统的 GitHub hosted 或 self-hosted runner
才能完整自动化打包。

## 功能特性

- 多浏览器环境管理：Profile、语言、时区、窗口尺寸、启动页和标签。
- 代理支持：HTTP、HTTPS、SOCKS4、SOCKS5，以及带账号密码的代理认证。
- 本地任务队列：单环境/多环境运行、并发控制、取消、重试和失败记录。
- 受控脚本运行时：通过 `deno_core` 暴露 `page`、`log`、`run`、`env`、`sleep`。
- 运行产物：保存截图、JSON、文本产物，并在 UI 中查看和打开目录。
- 本地存储：SQLite 保存环境、任务、运行记录、日志和诊断状态。
- 恢复能力：启动时恢复 queued batch，清理失效 session 和临时文件。

## 技术栈

- Desktop：Tauri 2
- Frontend：React 18、TypeScript、Vite、Tailwind CSS
- Runtime：Rust、SQLite、Chrome DevTools Protocol、deno_core
- Package manager：pnpm

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Chrome、Chromium 或 Edge
- Tauri 2 对应平台依赖

Linux 依赖可参考 `.github/workflows/ci.yml` 中的 apt 安装步骤。

### 安装依赖

```bash
pnpm install
```

### 本地开发

```bash
pnpm tauri:dev
```

### 构建前端

```bash
pnpm build
```

### 运行测试

```bash
pnpm test:rust
```

浏览器真实启动 smoke 默认被标记为 ignored，需要本机存在可启动的
Chrome/Chromium：

```bash
cargo test --manifest-path src-tauri/Cargo.toml browser_runtime_smoke_executes_js_task -- --ignored --nocapture
```

### 完整检查

```bash
pnpm check
```

## 项目结构

```text
├── src/                    React/Tailwind 管理界面
├── src-tauri/              Rust/Tauri 本地核心、SQLite、Chrome 生命周期
├── docs/                   架构、脚本 API 和 release 文档
├── public/                 Web 静态资源
├── .github/workflows/      GitHub Actions 构建、测试和 release 配置
├── package.json            前端、Tauri 和检查命令
└── README.md               项目入口文档
```

## 自动化脚本 API

任务脚本运行在受控 JavaScript runtime 中，默认暴露 `page`、`log`、`run`、
`env` 和 `sleep`。也可以通过 `orbit.page`、`orbit.log` 等命名空间访问。

```js
await page.goto("https://example.com", { waitUntil: "load" });
const title = await page.title();
log.info(`页面标题: ${title}`);
await run.outputJson("title", { title });
```

更多细节见 [自动化 API](docs/zh-CN/automation-api.md)。

## GitHub Actions Release

普通分支和 PR 会自动运行构建与测试。推送 `vX.Y.Z` tag 时会触发 release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

默认 pipeline 会：

1. 运行 `pnpm build` 和 Rust 测试。
2. 在 Linux runner 中执行 `pnpm tauri:build`。
3. 上传 Linux 打包产物。
4. 创建或更新 GitHub Release，并上传 Linux 打包产物。

完整说明见 [Release 流程](docs/zh-CN/release.md)。

## 数据与安全

Orbit Browser 只在本机运行，数据默认写入系统应用数据目录。不要提交：

- 浏览器 Profile
- Cookie 和 storage state
- 代理账号密码
- 任务截图和运行产物
- SQLite 数据库
- 本地 `.env` 文件

更多说明：

- [贡献指南](CONTRIBUTING.zh-CN.md)
- [安全策略](SECURITY.zh-CN.md)
- [架构说明](docs/zh-CN/architecture.md)

## License

MIT License. See [LICENSE](LICENSE).
