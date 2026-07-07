# Orbit Browser

Language: English | [简体中文](README.zh-CN.md)

Orbit Browser is a local browser runtime orchestrator for isolated
Chrome/Chromium profiles, proxies, automation tasks, and run artifacts.

It is built with Tauri 2, React, TypeScript, and Rust for local workflows that
need a stable desktop control plane for browser environments, repeatable
automation scripts, and inspectable run history.

## Current Status

The project is in an early usable stage. The core workflow is already wired:

- Desktop app startup and local runtime orchestration.
- Environment, task, run history, settings, and diagnostics views.
- Automatic Chrome/Chromium/Edge detection, persisted global Chrome path, and
  per-environment path override.
- Isolated profiles, proxy configuration, proxy-auth extension generation, and artifact management.
- MCP stdio server for external agents and tools to inspect/manage
  environments, tasks, runs, and browser pages.
- GitHub Actions release packaging for macOS, Windows, and Linux on version tags.

The release workflow includes required macOS, Windows x64, and Linux x64
package jobs. Windows arm64 and Linux arm64 jobs are currently experimental and
may fail without blocking release publication.

## Features

- Multi-environment browser management: profile, locale, timezone, viewport, start URL, and tags.
- Proxy support: HTTP, HTTPS, SOCKS4, SOCKS5, and username/password proxy authentication.
- Local task queue: single or multi-environment runs, concurrency control, cancellation, retry, and failure records.
- Controlled JavaScript runtime: `deno_core` exposes `page`, `log`, `run`, `env`, and `sleep`.
- Run artifacts: screenshots, JSON, text files, and local artifact-folder access from the UI.
- Local storage: SQLite records environments, tasks, runs, logs, artifacts, settings, and diagnostics state.
- Recovery: restores queued batches on startup and cleans stale sessions and temporary files.
- Diagnostics: Chrome detection, CDP checks, runtime counters, data-size metrics,
  stale-session cleanup, temporary-file cleanup, and latest proxy-test status.
- MCP integration: run the app binary with `--mcp` to expose Orbit tools over
  stdio for local agent clients.

## Tech Stack

- Desktop: Tauri 2
- Frontend: React 18, TypeScript, Vite, Tailwind CSS
- Runtime: Rust, SQLite, Chrome DevTools Protocol, deno_core
- Package manager: pnpm

## Quick Start

### Requirements

- Node.js 20+
- pnpm 10+
- Rust stable
- Chrome, Chromium, or Edge
- Platform dependencies required by Tauri 2

Linux dependencies are listed in the `.github/workflows/ci.yml` apt step.

### Install Dependencies

```bash
pnpm install
```

### Run Locally

```bash
pnpm tauri:dev
```

### Build Frontend

```bash
pnpm build
```

### Run Tests

```bash
pnpm test:rust
```

The browser-launch smoke test is ignored by default and requires a local
Chrome/Chromium executable:

```bash
cargo test --manifest-path src-tauri/Cargo.toml browser_runtime_smoke_executes_js_task -- --ignored --nocapture
```

### Full Check

```bash
pnpm check
```

### MCP Server

The desktop binary can run as a local MCP stdio server:

```bash
orbit-browser --mcp
```

The server exposes tools for listing environments and tasks, starting/stopping
environments, saving/running tasks, reading runs/logs/artifacts, navigating
browser pages, reading page context, evaluating JavaScript, and capturing
screenshots. It uses the same local SQLite data directory as the desktop app.

See [MCP API](docs/mcp-api.md) for the full tool list.

## Project Structure

```text
├── src/                    React/Tailwind management UI
├── src-tauri/              Rust/Tauri local core, SQLite, Chrome lifecycle
├── docs/                   Architecture, script API, and release notes
├── public/                 Web static assets
├── .github/workflows/      GitHub Actions build, test, and release config
├── CHANGELOG.md            Release history
├── package.json            Frontend, Tauri, and verification commands
└── README.md               Project entry documentation
```

## Automation Script API

Task scripts run inside a controlled JavaScript runtime. The default globals are
`page`, `log`, `run`, `env`, and `sleep`. They are also available under the
`orbit` namespace.

```js
await page.goto("https://example.com", { waitUntil: "load" });
const title = await page.title();
log.info(`Page title: ${title}`);
await run.outputJson("title", { title });
```

See [Automation API](docs/automation-api.md) for details.

## GitHub Actions Release

Regular branches and pull requests run build and test verification. Pushing a
`vX.Y.Z` tag triggers a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The default pipeline:

1. Runs `pnpm build` and Rust tests.
2. Creates or updates a draft GitHub Release.
3. Builds Tauri bundles on macOS, Windows, and Linux runners.
4. Uploads release assets and matching workflow artifacts.
5. Publishes the draft Release after all required package jobs pass.

See [Release Process](docs/release.md) for the full flow.

## Data And Security

Orbit Browser runs locally and stores data in the system application-data
directory. Do not commit:

- Browser profiles
- Cookies and storage state
- Proxy credentials
- Task screenshots and run artifacts
- SQLite databases
- Local `.env` files

For open-source collaboration and security reporting, see:

- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Architecture](docs/architecture.md)

## Pre-Publication Checklist

Before making the repository public:

- `pnpm build` passes.
- `pnpm test:rust` passes.
- GitHub Actions has passed at least one verify job in the target repository.
- Versions in `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json` are aligned.
- A new Git remote is configured and old remote metadata is removed.

## License

MIT License. See [LICENSE](LICENSE).
