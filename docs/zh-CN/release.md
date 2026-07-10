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

具体 bundle 类型由平台配置固定为：

- macOS：`.dmg`。打开后将应用拖到 Applications，升级时直接替换。
- Windows：NSIS `-setup.exe`。同为 NSIS 的旧版本会直接覆盖升级，不需要先
  手动卸载；历史 MSI 用户首次切换时会完成一次迁移。
- Linux：AppImage、deb 和 rpm。AppImage 通过替换文件升级，deb 使用
  `apt install ./<package>.deb`，rpm 使用 `rpm -U <package>.rpm`。

Windows 面向普通用户只发布 NSIS，避免 `.msi` 与 `.exe` 混用产生重复安装项。
安装范围为当前用户，不需要管理员权限。安装器会跟随系统语言显示简体中文或
英文，并阻止旧版本覆盖新版本。

应用数据保存在系统数据目录下的 `com.orbit.browser` 中，与应用安装目录分离。
正常覆盖升级会保留环境、任务、Profile 和运行记录。

实验性矩阵项允许失败，不会阻塞最终 Release 发布。必需矩阵项必须通过，
draft Release 才会被正式发布。

## 发布前检查

发布前确认：

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本一致。
- `pnpm check:version` 通过，且发布 tag 与应用版本一致。
- `CHANGELOG.md` 已更新。
- 本地或 CI 中 `pnpm build`、`pnpm test:rust` 通过。
- 不提交 Profile、Cookie、截图、数据库、代理凭据或运行产物。
