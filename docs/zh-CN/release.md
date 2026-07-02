# Release 流程

项目使用 GitHub Actions 校验变更、打包 Linux 版本，并在 tag 上创建
GitHub Release。

## 触发方式

推送符合 `vX.Y.Z` 格式的 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会执行：

1. `verify`：运行前端构建和 Rust 测试。
2. `package-linux`：执行 `pnpm tauri:build`，打包 Linux 产物。
3. `Publish GitHub Release`：创建或更新 GitHub Release，并上传 Linux 产物。

## 默认产物

默认 Linux job 会保留：

- `release/orbit-browser-linux-<tag>.tar.gz`
- `src-tauri/target/release/bundle/`

具体 bundle 类型由 Tauri 在 Linux runner 上生成，通常包含 AppImage、deb
或 rpm 中的一种或多种。

## macOS 和 Windows

Tauri 桌面包不能在普通 Linux runner 上交叉完整构建 macOS 或 Windows
安装包。要增加多平台 release，需要配置对应系统的 GitHub hosted 或
self-hosted runner：

- macOS runner：用于 `.dmg`、`.app`、签名和 notarization。
- Windows runner：用于 `.msi`、`.exe` 和签名。

建议复制 `.github/workflows/ci.yml` 中的 `package-linux` 结构，新增
`package-macos` 和 `package-windows`，并用对应 `runs-on` 标签限定系统。

## 发布前检查

发布前确认：

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本一致。
- `CHANGELOG.md` 已更新。
- 本地或 CI 中 `pnpm build`、`pnpm test:rust` 通过。
- 不提交 Profile、Cookie、截图、数据库、代理凭据或运行产物。
