#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[derive(Clone, Default)]
pub struct CancellationRegistry {
    inner: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, CancellationToken>>>,
}

impl CancellationRegistry {
    pub fn register(&self, run_id: &str) -> CancellationToken {
        let token = CancellationToken::default();
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(run_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(run_id).cloned())
            .map(|token| {
                token.cancel();
                true
            })
            .unwrap_or(false)
    }

    pub fn remove(&self, run_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.remove(run_id);
        }
    }
}
