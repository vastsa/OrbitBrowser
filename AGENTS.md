# Repository Guidelines

## Project Structure & Module Organization

This repository is a Tauri desktop browser runtime orchestrator focused on
isolated Chrome/Chromium profiles, proxies, task execution, and local storage.

- `src/`: React, TypeScript, and Tailwind desktop UI.
- `src-tauri/`: Rust/Tauri core, SQLite storage, Chrome lifecycle, and task queue.
- `docs/`: architecture notes and automation API documentation.

## Build, Test, and Development Commands

Install dependencies and run the desktop app:

```bash
pnpm install
pnpm tauri:dev
```

Build the frontend and Tauri app assets:

```bash
pnpm build
```

Run Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Or use the package script:

```bash
pnpm test:rust
```

Run the ignored browser runtime smoke when browser launch behavior changes:

```bash
cargo test --manifest-path src-tauri/Cargo.toml browser_runtime_smoke_executes_js_task -- --ignored --nocapture
```

## Coding Style & Naming Conventions

Use TypeScript for UI code and Rust for local runtime code. Prefer clear
component, command, and repository boundaries. Use `PascalCase` for React
components, `camelCase` for TypeScript variables/functions, and `snake_case`
for Rust modules/functions. Keep CLI flags lowercase with hyphens, for example
`--user-data-dir`.

## Testing Guidelines

For UI changes, run `pnpm build`. For storage, queue, browser lifecycle, proxy,
or automation changes, run the relevant Rust tests under `src-tauri/`. Browser
launch and CDP behavior should also run the ignored runtime smoke when feasible.

## Commit & Pull Request Guidelines

Use English Conventional Commits by default. Keep messages concise,
action-oriented, and scoped, for example `fix: chrome launch flags` or
`refactor: task run history`. Pull requests should include a brief change
summary and manual verification commands.

## Security & Configuration Tips

Store local credentials and proxy secrets in `.env` or shell environment
variables, and never commit them. Do not commit generated browser profiles,
cookies, storage states, screenshots, or runtime output directories.
