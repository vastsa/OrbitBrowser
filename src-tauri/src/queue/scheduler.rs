#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub max_concurrency: i64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self { max_concurrency: 2 }
    }
}
