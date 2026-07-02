use crate::errors::{AppError, AppResult};

pub fn allocate() -> AppResult<u16> {
    portpicker::pick_unused_port()
        .ok_or_else(|| AppError::new("cdp_connect_failed", "No available CDP port").retryable(true))
}
