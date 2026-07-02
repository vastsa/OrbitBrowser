# Contributing Guide

Language: English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in Orbit Browser. The project prioritizes local
runtime stability, data safety, and maintainable boundaries.

## Development Workflow

1. Fork the repository or create a feature branch.
2. Install dependencies and confirm the local app can run:

```bash
pnpm install
pnpm tauri:dev
```

3. Run verification after your changes:

```bash
pnpm build
pnpm test:rust
```

4. In pull requests, describe the change scope, verification commands, and any known limitations.

## Coding Conventions

- Use TypeScript, React, and Tailwind CSS for the UI.
- Use Rust for the local core and keep command, storage, domain, browser, and queue boundaries clear.
- Do not commit runtime data, browser profiles, cookies, screenshots, task artifacts, or proxy credentials.
- Changes that touch Chrome launch, CDP, proxies, or task execution should include relevant tests or smoke-test notes.

## Commit Messages

Keep commit messages short, explicit, and action-oriented. Examples:

```text
fix: clean up proxy-auth extension files
feat: add run diagnostics metadata
docs: add automation API examples
```
