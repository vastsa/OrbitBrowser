# Release Process

The project uses GitHub Actions to verify changes, package Linux builds, and
create GitHub Releases on version tags.

## Trigger

Push a tag matching `vX.Y.Z`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions runs:

1. `verify`: runs the frontend build and Rust tests.
2. `package-linux`: runs `pnpm tauri:build` and packages Linux artifacts.
3. `Publish GitHub Release`: creates or updates a GitHub Release and uploads
   the Linux artifact.

## Default Artifacts

The default Linux job keeps:

- `release/orbit-browser-linux-<tag>.tar.gz`
- `src-tauri/target/release/bundle/`

The exact bundle types are produced by Tauri on the Linux runner and commonly
include one or more of AppImage, deb, or rpm.

## macOS And Windows

Tauri desktop packages cannot be fully cross-built for macOS or Windows from a
generic Linux runner. Multi-platform releases require GitHub hosted or
self-hosted runners on the target operating systems:

- macOS runner: builds `.dmg`, `.app`, signing, and notarization outputs.
- Windows runner: builds `.msi`, `.exe`, and signing outputs.

Use the `package-linux` job structure in `.github/workflows/ci.yml` as the
template for `package-macos` and `package-windows`, then constrain them with
the corresponding `runs-on` labels.

## Pre-Release Checklist

Before releasing:

- Versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` match.
- `CHANGELOG.md` is updated.
- `pnpm build` and `pnpm test:rust` pass locally or in CI.
- Profiles, cookies, screenshots, databases, proxy credentials, and run artifacts are not committed.
