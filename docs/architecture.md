# Architecture

Orbit Browser consists of a frontend management UI and a Rust local core.

```text
React UI
  └── Tauri commands
        ├── settings       App settings and Chrome detection
        ├── environments   Browser environment CRUD, start, stop, proxy test
        ├── tasks          Automation task persistence, validation, execution
        ├── runs           Run history, logs, artifacts
        └── diagnostics    Local diagnostics and cleanup

Rust core
  ├── domain      Domain models
  ├── storage     SQLite repositories and migrations
  ├── browser     Chrome path resolution, launch args, CDP, profile locks
  ├── automation  deno_core runtime, script API, permission model
  └── queue       Batch scheduling and background workers
```

## Data Directory

Application data is written to the system app-data directory. Main contents:

- `app.sqlite`: environment, task, run, log, and artifact indexes.
- `profiles/`: isolated browser profile per environment.
- `runs/`: task run artifacts.
- `temp/`: temporary files such as generated proxy-auth extensions.

These directories should never be committed to Git.

## Run Flow

1. The UI saves environments and tasks through Tauri commands.
2. When a task runs, Rust starts or reuses Chrome for the target environment.
3. CDP establishes the page-control connection.
4. Task scripts run in `deno_core` with only controlled APIs exposed.
5. Logs and artifacts are written to SQLite and the run directory, then emitted to the UI through Tauri events.
