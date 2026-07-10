<div align="center">
  <img src="docs/assets/orbit-browser-hero.svg" alt="Orbit Browser 产品预览" width="100%" />

  <h1>Orbit Browser</h1>

  <p>
    <strong>在一个本地驾驶舱里，管理你的隔离浏览器舰队。</strong>
  </p>

  <p>
    Profile、代理、JavaScript 自动化、运行产物和 MCP 工具，全部串联在一个快速桌面应用中。
  </p>

  <p>
    <a href="README.md">English</a>
    ·
    <a href="docs/zh-CN/architecture.md">架构设计</a>
    ·
    <a href="docs/zh-CN/automation-api.md">自动化 API</a>
    ·
    <a href="docs/zh-CN/mcp-api.md">MCP API</a>
  </p>

  <p>
    <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white" />
    <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=0F172A" />
    <img alt="Rust" src="https://img.shields.io/badge/Rust-Core-000000?style=for-the-badge&logo=rust&logoColor=white" />
    <img alt="SQLite" src="https://img.shields.io/badge/SQLite-Local-003B57?style=for-the-badge&logo=sqlite&logoColor=white" />
  </p>
</div>

---

## 为什么需要 Orbit Browser？

浏览器自动化很容易变成一堆难以维护的脚本、临时 Profile、代理参数、截图、过期状态和散落日志。

**Orbit Browser 把这些混乱收束成一个本地桌面控制台。**

你可以创建隔离浏览器环境，绑定代理和运行时指纹，执行可复用的 JavaScript 任务，查看日志与产物，并通过 MCP 将同一套能力开放给本地 Agent。

```text
[环境] → [Chrome Profile + 代理 + 语言地区 + 时区]
  │
  ├── 启动 / 停止 / 恢复
  ├── 执行自动化任务
  └── 收集日志、截图、JSON、文本产物
```

## 一眼看懂

<table>
  <tr>
    <td><strong>运行方式</strong></td>
    <td>本地 Tauri 桌面应用，底层由 Rust、SQLite 和 Chrome DevTools Protocol 驱动。</td>
  </tr>
  <tr>
    <td><strong>控制台</strong></td>
    <td>统一管理环境、任务、运行记录、诊断、设置和 MCP 入口。</td>
  </tr>
  <tr>
    <td><strong>自动化</strong></td>
    <td>通过受控 JavaScript Runtime 执行页面操作、日志记录、截图和产物输出。</td>
  </tr>
  <tr>
    <td><strong>适合场景</strong></td>
    <td>QA 浏览器池、代理工作流、采集流水线、监控任务、本地 AI Agent 浏览器执行。</td>
  </tr>
</table>

## 核心亮点

- **隔离浏览器集群**  
  管理 Chrome、Chromium 或 Edge Profile。每个环境都可以拥有独立存储、窗口尺寸、语言地区、时区、地理位置、标签、分组和启动参数。

- **代理优先的工作流**  
  支持 HTTP、HTTPS、SOCKS4、SOCKS5、代理认证、绕过列表，以及按环境执行代理连通性检查。

- **可复用任务编排**  
  保存 JavaScript 自动化任务，批量运行到多个环境，控制并发，失败重试，并可取消运行中的批次。

- **完整可追溯产物**  
  每次运行都会记录日志、截图、JSON、文本输出、状态、耗时和本地产物路径。

- **面向 Agent 的 MCP Server**  
  Orbit 可以作为本地 stdio MCP 服务运行，让 Agent 客户端管理环境、操作页面、执行任务、读取运行记录和产物。

- **Local-first 设计**  
  Profile、运行记录、日志、设置和产物都保存在本机。

## 适合用来做什么？

- 多账号 QA 与回归测试浏览器池
- 基于代理和地区的浏览工作流
- 可复用网页采集、监控和截图任务
- AI Agent 的本地浏览器执行底座
- 登录态检查、页面巡检、截图归档流水线
- 不想直接维护 Chrome 进程和 CDP 细节的桌面自动化

## 工作流

<img src="docs/assets/orbit-browser-workflow.svg" alt="Orbit Browser 工作流" width="100%" />

## 能力地图

```text
Orbit Browser
├── 浏览器环境
│   ├── 隔离 Chrome / Chromium / Edge Profile
│   ├── 代理、Locale、Timezone、Viewport、地理位置
│   └── 启动、停止、重启、恢复、诊断
├── 自动化任务
│   ├── 受控 JavaScript Runtime
│   ├── 多环境批量执行
│   └── 并发、超时、重试、取消
├── 运行证据
│   ├── 日志、状态、耗时、重试次数
│   ├── 截图、JSON 输出、文本文件
│   └── 本地产物目录
└── Agent 接口
    ├── MCP stdio server
    ├── 页面跳转、JS 执行、截图
    └── 环境 / 任务 / 运行记录读取
```

## 产品使用路径

### 1. 创建浏览器环境

为不同账号、地区、项目或任务创建独立环境。每个环境都可以配置 Profile、代理、Locale、Timezone、Viewport、启动地址和运行参数。

### 2. 编写并运行自动化任务

任务脚本运行在受控 JavaScript Runtime 中，默认提供 `page`、`log`、`run`、`env` 和 `sleep` 等全局对象。

```js
await page.goto("https://example.com", { waitUntil: "load" });
const title = await page.title();
log.info(`页面标题：${title}`);
await page.screenshot("home");
await run.outputJson("page-title", { title });
```

### 3. 查看每一次运行

运行记录包含状态、时间、日志、截图、JSON 输出、文本输出和产物目录。失败后可重试，同时保留历史执行轨迹。

### 4. 接入本地 Agent

将桌面二进制作为 MCP stdio server 启动：

```bash
orbit-browser --mcp
```

Agent 客户端即可调用 Orbit 工具，完成环境列表读取、浏览器启动、页面跳转、JS 执行、截图、任务运行和产物读取。

## 技术栈

- **桌面容器**：Tauri 2
- **前端**：React 18、TypeScript、Vite、Tailwind CSS
- **本地核心**：Rust、SQLite、Chrome DevTools Protocol、`deno_core`
- **自动化接口**：受控 JavaScript Runtime + MCP stdio server
- **包管理器**：pnpm

## 30 秒启动

```bash
pnpm install
pnpm tauri:dev
```

然后创建环境、保存任务、选择目标环境并运行。

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Chrome、Chromium 或 Edge
- Tauri 2 所需平台依赖

Linux 依赖可参考 GitHub Actions workflow。

### 安装依赖

```bash
pnpm install
```

### 启动桌面应用

```bash
pnpm tauri:dev
```

### 构建

```bash
pnpm build
pnpm tauri:build
```

### 测试

```bash
pnpm test:rust
```

修改 Chrome 启动或 CDP 行为时，建议执行被忽略的浏览器运行时冒烟测试：

```bash
cargo test --manifest-path src-tauri/Cargo.toml browser_runtime_smoke_executes_js_task -- --ignored --nocapture
```

### 完整校验

```bash
pnpm check
```

## 项目结构

```text
├── src/                    React/Tailwind 桌面 UI
├── src-tauri/              Rust/Tauri 核心、SQLite、Chrome 生命周期、队列
├── docs/                   架构、自动化、MCP 和发布文档
├── public/                 Web 静态资源
├── .github/workflows/      CI、校验和发布打包
├── CHANGELOG.md            版本记录
└── README.md               项目介绍
```

## 文档入口

- [架构设计](docs/zh-CN/architecture.md)
- [自动化 API](docs/zh-CN/automation-api.md)
- [MCP API](docs/zh-CN/mcp-api.md)
- [发布流程](docs/zh-CN/release.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [安全策略](SECURITY.zh-CN.md)

## 数据与安全

Orbit Browser 会把本地应用数据写入系统 app-data 目录。请不要提交以下运行时文件：

- 浏览器 Profile
- Cookies 与 storage state
- 代理账号和密钥
- 任务截图和运行产物
- SQLite 数据库
- 本地 `.env` 文件

## 发布说明

推送版本标签后，Release workflow 会构建 macOS、Windows 和 Linux 桌面安装包。

- Windows 下载 `-setup.exe`，升级时直接运行新版安装程序，无需手动卸载。
- macOS 下载对应芯片的 `.dmg`，将应用拖到 Applications。
- Linux 根据发行版选择 AppImage、deb 或 rpm；deb/rpm 支持包管理器覆盖升级。

正常升级会保留环境、任务、浏览器 Profile 和运行记录。

```bash
git tag v0.3.2
git push origin v0.3.2
```

完整流程见 [发布流程](docs/zh-CN/release.md)。

## 当前状态

Orbit Browser 处于早期可用阶段，但核心产品闭环已经可用：创建环境、启动浏览器、执行任务、查看运行证据，并通过 MCP 暴露给本地 Agent。

桌面主流程、本地存储、Chrome 生命周期、任务队列、运行产物、诊断中心和 MCP Server 已完成串联。

## License

MIT License. See [LICENSE](LICENSE).
