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

## UI Styling & Theme Tokens

All UI styling must use the shared theme system and work in both light and dark
color schemes. These rules apply to React components, CSS, HTML, startup
screens, and native Tauri window styling.

- Do not add raw hex, `rgb()`, `rgba()`, or `hsl()` theme colors in components.
  Use the existing Tailwind theme utilities or named semantic CSS variables.
- New reusable surfaces, foregrounds, borders, focus states, controls, and
  status styles should use semantic tokens. Existing palette utilities are
  acceptable only when they already have verified light and dark mappings.
- Every new semantic color token must define both a light value under `:root`
  and a dark value under `@media (prefers-color-scheme: dark)`.
- Prefer the standard Tailwind spacing, sizing, typography, radius, shadow, and
  duration scales. Move repeated or page-specific arbitrary geometry into
  named CSS variables or component classes instead of scattering literals.
- Runtime-derived geometry, such as a progress percentage, may use a dynamic
  inline style when the value comes from application state.
- When touching legacy UI, migrate relevant raw theme values toward the shared
  token system without forcing unrelated large-scale rewrites.
- Verify every UI change with both light and dark system preferences. Check
  default, hover, focus, selected, disabled, loading, success, warning, and
  error states for readable contrast and visible boundaries, then run
  `pnpm build`.

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
