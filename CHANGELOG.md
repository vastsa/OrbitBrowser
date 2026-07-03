# Changelog

## 0.1.1

- Added IP-adaptive locale, timezone, geolocation, and browser language handling for environments.
- Added runtime masks for Intl locale consistency and non-regional Chinese font detection.
- Delayed start URL navigation until runtime overrides are installed.
- Preserved Chrome's native UA and UA-CH by default; custom UA overrides are only applied when configured.
- Added environment controls for manual User-Agent, platform, and seed values.

## 0.1.0

- Initialized the Tauri 2 + React + Rust desktop application.
- Added browser environment management, Chrome path detection, profile isolation, and proxy configuration.
- Added automation tasks, batch runs, logs, artifacts, and diagnostics.
- Added a controlled JavaScript runtime with the initial `page`, `log`, and `run` APIs.
- Added GitHub Actions release automation, open-source collaboration docs, and pre-publication checks.
