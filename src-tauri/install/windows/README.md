# Windows installer template

`installer.nsi` is based on the default template from Tauri CLI 2.11.2:

```text
crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
```

Orbit changes one behavior in `PageReinstall`: when a newer NSIS version finds
an older NSIS installation, it marks the run as an update and skips the
maintenance choice page. The previous install directory, shortcuts, and app
data remain in place. Migration from an older WiX/MSI installation continues to
use Tauri's upstream uninstall path because MSI owns a separate install context.

When upgrading `@tauri-apps/cli`, compare this template with the matching Tauri
release before publishing a new Windows installer. Keep the small Orbit update
block after `SemverCompare` and adopt all other upstream template changes.
