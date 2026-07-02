# 架构说明

Orbit Browser 由前端管理界面和 Rust 本地核心组成。

```text
React UI
  └── Tauri commands
        ├── settings       应用设置、Chrome 检测
        ├── environments   浏览器环境 CRUD、启动、停止、代理测试
        ├── tasks          自动化任务保存、校验、运行
        ├── runs           运行记录、日志、产物
        └── diagnostics    本地诊断和清理

Rust core
  ├── domain      领域模型
  ├── storage     SQLite 仓储和 migrations
  ├── browser     Chrome 路径、启动参数、CDP、Profile lock
  ├── automation  deno_core runtime、脚本 API、权限模型
  └── queue       批量任务调度和后台 worker
```

## 数据目录

应用数据写入系统应用数据目录，主要包含：

- `app.sqlite`：环境、任务、运行记录、日志和产物索引。
- `profiles/`：每个环境独立的浏览器 Profile。
- `runs/`：任务运行产物。
- `temp/`：代理认证扩展等临时文件。

这些目录不应提交到 Git。

## 运行链路

1. UI 通过 Tauri command 保存环境和任务。
2. 运行任务时，Rust 根据环境启动或复用 Chrome。
3. 通过 CDP 建立页面控制连接。
4. 任务脚本在 `deno_core` 中执行，只暴露受控 API。
5. 日志和产物写入 SQLite 和运行目录，并通过 Tauri event 通知 UI。
