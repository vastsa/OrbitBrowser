fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(err) = orbit_browser_lib::run_mcp() {
            eprintln!("{}: {}", err.code, err.message);
            std::process::exit(1);
        }
        return;
    }

    orbit_browser_lib::run();
}
