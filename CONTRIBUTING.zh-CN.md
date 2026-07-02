# 贡献指南

语言：[English](CONTRIBUTING.md) | 简体中文

感谢关注 Orbit Browser。这个项目优先保证本地运行稳定性、数据安全和可维护性。

## 开发流程

1. Fork 或新建分支。
2. 安装依赖并确认本地环境可运行：

```bash
pnpm install
pnpm tauri:dev
```

3. 修改完成后运行检查：

```bash
pnpm build
pnpm test:rust
```

4. 提交 PR 时说明变更范围、验证命令和已知限制。

## 代码约定

- UI 使用 TypeScript、React 和 Tailwind CSS。
- 本地核心使用 Rust，并保持 command、storage、domain、browser、queue 等边界清晰。
- 不提交运行时数据、浏览器 Profile、Cookie、截图、任务产物或代理凭据。
- 涉及 Chrome 启动、CDP、代理和任务运行的改动，需要补充对应测试或 smoke 验证说明。

## 提交信息

提交信息保持简短、明确、面向动作，例如：

```text
fix: clean up proxy-auth extension files
feat: add run diagnostics metadata
docs: add automation API examples
```
