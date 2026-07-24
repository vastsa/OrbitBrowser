# Changelog

## Unreleased

## 0.5.1

- Hardened Chrome detection on macOS: resolve `.app` bundles, read Info.plist versions without launching Chrome, expand Canary/Beta/Edge/Brave/Homebrew candidates, and treat launchable binaries as found even when `--version` is flaky.
- Auto-persist a detected Chrome path when settings are empty, normalize blank paths to unset, and stop environment health from reporting missing Chrome when auto-detection succeeds.
- Hardened Chrome CDP stealth: uncommon loopback ports, exclude automation switches, and Page-level webdriver/CDP residue patches on every target.
- Avoid Chrome's unsupported-flag infobar by not launching with --disable-blink-features=AutomationControlled.
- Optimized the AI Agent composer input path and made Enter send messages by default.
- Completed the AI Agent browser event recording flow with live status polling, environment-aware sync, richer side-panel controls, and attach-to-chat references.
- Removed the browser context side card from the AI Agent workspace.
- Added recording event filters/clear, and made history/recording side panels half-height by default with drag resize and scroll.
- Kept the latest recording summary after stop/crash so status queries and the UI can still review captured network and navigation events.
- Fixed macOS app icon sizing by adding Dock/Launchpad-safe transparent padding (~10% margins) and regenerating icon bundles.

## 0.5.0

- Aligned Chrome native language preferences, Intl locale, CDP timezone, and
  geolocation with the proxy exit IP while preserving native UA, platform, and
  font characteristics.
- Removed Chrome locale, User-Agent, viewport, WebRTC, font, and JavaScript
  geolocation patching paths; retained the extended profile controls for
  Camoufox environments.
- Added Camoufox target platform selection for environment-specific runtime
  profiles.
- Improved the agent message composer with context references, keyboard
  navigation, automatic sizing, accessible states, and refined light/dark
  styling.
- Refined desktop window controls, environment actions, tables, form states,
  and cross-platform installer packaging.
- Added a real macOS application screenshot to the English and Chinese README.

## 0.4.1

- Fixed Windows builds by using the correct file version API feature and
  import path for Chrome executable detection.

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
