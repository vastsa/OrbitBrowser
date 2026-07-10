# Changelog

## 0.4.0

- Added Camoufox environments with managed installation, browser runtime
  downloads, launch controls, and Orbit automation support.
- Added visible Camoufox installation stages, persisted Python path detection,
  automatic validation, and global runtime path fallback.
- Kept IP-derived timezone, locale, and geolocation overrides alive across
  navigation and CDP reconnects, with watcher lifecycle cleanup on shutdown.
- Preserved Chrome's native User-Agent, Client Hints, platform metadata, and
  reduced version format by default to improve fingerprint consistency.
- Added task search, pagination, table navigation, and refined desktop context
  menu behavior.
- Refined the desktop interface, startup splash, theme guidance, and Windows
  Chrome detection behavior.

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
