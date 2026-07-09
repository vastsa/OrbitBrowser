#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleWindow};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow;

fn main() {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let console_window = GetConsoleWindow();
            if !console_window.is_null() {
                ShowWindow(console_window, 0);
                FreeConsole();
            }
        }
    }

    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(err) = orbit_browser_lib::run_mcp() {
            eprintln!("{}: {}", err.code, err.message);
            std::process::exit(1);
        }
        return;
    }

    orbit_browser_lib::run();
}
