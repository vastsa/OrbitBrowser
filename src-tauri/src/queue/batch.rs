use crate::domain::run::RunOptions;

pub fn normalize_options(options: Option<RunOptions>) -> RunOptions {
    let mut options = options.unwrap_or_default();
    options.max_concurrency = options.max_concurrency.max(1);
    options
}
