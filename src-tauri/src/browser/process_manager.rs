use sysinfo::{Pid, System};

pub fn pid_alive(pid: u32) -> bool {
    let system = System::new_all();
    system.process(Pid::from_u32(pid)).is_some()
}

pub fn pid_command_contains(pid: u32, needle: &str) -> bool {
    let system = System::new_all();
    system
        .process(Pid::from_u32(pid))
        .map(|process| {
            process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
                .contains(needle)
        })
        .unwrap_or(false)
}

pub fn kill_pid(pid: u32) -> bool {
    let system = System::new_all();
    system
        .process(Pid::from_u32(pid))
        .map(|process| process.kill())
        .unwrap_or(false)
}
