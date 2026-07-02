# Orbit Browser

Language: English | [简体中文](README.zh-CN.md)

Orbit Browser is a local browser runtime orchestrator for isolated
Chrome/Chromium profiles, proxies, automation tasks, and run artifacts.

It is built with Tauri 2, React, TypeScript, and Rust for teams that need a
stable desktop control plane for local browser automation.

## Current Status

The project is in an early usable stage. The core workflow is already wired:

- Desktop app startup and local runtime orchestration.
- Environment, task, run history, settings, and diagnostics views.
- Automatic Chrome/Chromium/Edge detection with manual path override.
- Isolated profiles, proxy configuration, proxy-auth extension generation, and artifact management.
- GitHub Actions release packaging for Linux on version tags.

macOS and Windows installers require GitHub hosted or self-hosted runners on
the corresponding operating systems before they can be fully automated.

## Features

- Multi-environment browser management: profile, locale, timezone, viewport, start URL, and tags.
- Proxy support: HTTP, HTTPS, SOCKS4, SOCKS5, and username/password proxy authentication.
- Local task queue: single or multi-environment runs, concurrency control, cancellation, retry, and failure records.
- Controlled JavaScript runtime: `deno_core` exposes `page`, `log`, `run`, `env`, and `sleep`.
- AI Agent: OpenAI-compatible models can inspect pages, use screenshots, generate scripts, validate drafts, and save tasks.
- Run artifacts: screenshots, JSON, text files, and local artifact-folder access from the UI.
- Local storage: SQLite records environments, tasks, runs, logs, artifacts, settings, and diagnostics state.
- Recovery: restores queued batches on startup and cleans stale sessions and temporary files.

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

## Project Structure

```text
├── src/                    React/Tailwind management UI
├── src-tauri/              Rust/Tauri local core, SQLite, Chrome lifecycle
├── docs/                   Architecture, script API, and release notes
├── public/                 Web static assets
├── .github/workflows/      GitHub Actions build, test, and release config
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

## AI Agent

AI Agent turns a natural-language goal into a normal reusable task script. It
can inspect the selected browser environment, read page context, analyze
screenshots, call controlled browser tools, and save the final script back into
the task library.

API keys are encrypted before being stored in SQLite. Page context excludes
cookies, storage values, authorization headers, request bodies, and response
bodies.

See [AI Agent Tasks](docs/ai-agent.md) for details.

## GitHub Actions Release

Regular branches and pull requests run build and test verification. Pushing a
`vX.Y.Z` tag triggers a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The default pipeline:

1. Runs `pnpm build` and Rust tests.
2. Runs `pnpm tauri:build` on a Linux runner.
3. Uploads Linux package artifacts.
4. Creates or updates a GitHub Release with Linux package artifacts.

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
