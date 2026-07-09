#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleWindow};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow;

fn main() {
    let is_mcp = std::env::args().any(|arg| arg == "--mcp");

    if is_mcp {
        if let Err(err) = orbit_browser_lib::run_mcp() {
            eprintln!("{}: {}", err.code, err.message);
            std::process::exit(1);
        }
        return;
    }

    #[cfg(target_os = "windows")]
    hide_console_window();

    orbit_browser_lib::run();
}

#[cfg(target_os = "windows")]
fn hide_console_window() {
    unsafe {
        let console_window = GetConsoleWindow();
        if !console_window.is_null() {
            ShowWindow(console_window, 0);
            FreeConsole();
        }
    }
}
