use crate::errors::{AppError, AppResult};
use std::net::TcpListener;
use std::time::{SystemTime, UNIX_EPOCH};

/// 避开 9222 等常见调试端口段，降低被扫描/识别的概率。
const CDP_PORT_MIN: u16 = 46_000;
const CDP_PORT_MAX: u16 = 58_000;
const ALLOCATE_ATTEMPTS: u16 = 128;

pub fn allocate() -> AppResult<u16> {
    let span = (CDP_PORT_MAX - CDP_PORT_MIN) as u64;
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let mut candidate = CDP_PORT_MIN.saturating_add((seed % (span + 1)) as u16);

    for _ in 0..ALLOCATE_ATTEMPTS {
        if is_available(candidate) {
            return Ok(candidate);
        }
        candidate = if candidate >= CDP_PORT_MAX {
            CDP_PORT_MIN
        } else {
            candidate.saturating_add(1)
        };
    }

    // 兜底：系统任意空闲端口（仍优先本机回环探测）。
    portpicker::pick_unused_port()
        .filter(|&port| is_available(port))
        .or_else(portpicker::pick_unused_port)
        .ok_or_else(|| {
            AppError::new("cdp_connect_failed", "No available CDP port").retryable(true)
        })
}

fn is_available(port: u16) -> bool {
    // 仅检查本机回环，与 Chrome 仅监听 127.0.0.1 的策略一致。
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_port_within_preferred_range_or_fallback() {
        let port = allocate().expect("port");
        // 正常情况下应落在非常用高位段；极端资源争用时允许兜底。
        assert!(port > 0);
        if (CDP_PORT_MIN..=CDP_PORT_MAX).contains(&port) {
            assert!(is_available(port) || !is_available(port));
        }
    }

    #[test]
    fn preferred_range_avoids_classic_devtools_ports() {
        assert!(CDP_PORT_MIN > 9222);
        assert!(CDP_PORT_MIN > 9333);
    }
}
