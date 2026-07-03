# Release 流程

项目使用 GitHub Actions 校验变更、打包桌面安装包，并在版本 tag 上自动发布
GitHub Release。

## 触发方式

推送符合 `vX.Y.Z` 格式的 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会执行：

1. `frontend-build`：运行 TypeScript 和 Vite 构建。
2. `rust-tests`：运行 Rust 测试。
3. `create-release`：创建或更新 draft GitHub Release。
4. `package-release`：构建 macOS、Windows 和 Linux 安装包，并上传到 draft Release。
5. `publish-release`：所有必需打包任务完成后，自动发布 Release。

## 默认产物

发布工作流会把 Tauri bundle 直接上传到 GitHub Release，同时保留匹配的
workflow artifact，便于排查失败或部分完成的发布任务。

Release asset 命名规则：

```text
orbit-browser-<tag>-<platform>-<arch><setup><ext>
```

具体 bundle 类型由 Tauri 在各平台 runner 上生成，通常包含：

- macOS：`.dmg` 和 `.app` 产物。
- Windows：`.msi` 和 `.exe` 产物。
- Linux：AppImage、deb 或 rpm 产物。

实验性矩阵项允许失败，不会阻塞最终 Release 发布。必需矩阵项必须通过，
draft Release 才会被正式发布。

## 发布前检查

发布前确认：

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本一致。
- `CHANGELOG.md` 已更新。
- 本地或 CI 中 `pnpm build`、`pnpm test:rust` 通过。
- 不提交 Profile、Cookie、截图、数据库、代理凭据或运行产物。
