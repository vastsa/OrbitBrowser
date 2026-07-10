use crate::browser::cdp_client::{self, TargetInfo};
use crate::errors::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
static ACTIVE_WATCHERS: OnceLock<Mutex<HashMap<u16, u64>>> = OnceLock::new();
static NEXT_WATCHER_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq)]
pub struct GeolocationOverride {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserRuntimeOverrides {
    pub timezone_id: Option<String>,
    pub geolocation: Option<GeolocationOverride>,
    pub locale: Option<String>,
    pub user_agent: Option<String>,
    pub accept_language: Option<String>,
    pub platform: Option<String>,
    pub user_agent_metadata: Option<Value>,
    pub masked_fonts: Vec<String>,
}

impl BrowserRuntimeOverrides {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        timezone_id: Option<String>,
        geolocation: Option<GeolocationOverride>,
        locale: Option<String>,
        user_agent: Option<String>,
        accept_language: Option<String>,
        platform: Option<String>,
        user_agent_metadata: Option<Value>,
        masked_fonts: Vec<String>,
    ) -> Self {
        Self {
            timezone_id: normalize_timezone_id(timezone_id),
            geolocation,
            locale: normalize_optional_text(locale),
            user_agent: normalize_optional_text(user_agent),
            accept_language: normalize_optional_text(accept_language),
            platform: normalize_optional_text(platform),
            user_agent_metadata,
            masked_fonts: normalize_font_list(masked_fonts),
        }
    }

    fn is_empty(&self) -> bool {
        self.timezone_id.is_none()
            && self.geolocation.is_none()
            && self.locale.is_none()
            && self.user_agent.is_none()
            && self.accept_language.is_none()
            && self.platform.is_none()
            && self.user_agent_metadata.is_none()
            && self.masked_fonts.is_empty()
    }
}

pub async fn apply_and_watch(port: u16, overrides: BrowserRuntimeOverrides) -> AppResult<()> {
    if overrides.is_empty() {
        return Ok(());
    }

    cdp_client::wait_for_version(port, Duration::from_secs(5)).await?;
    let Some(watcher_token) = claim_watcher_port(port) else {
        return Ok(());
    };
    let (ready_tx, ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _watcher_guard = ActiveWatcherGuard {
            port,
            token: watcher_token,
        };
        if let Err(err) = watch_targets(port, watcher_token, overrides, Some(ready_tx)).await {
            tracing::warn!(
                cdp_port = port,
                error = %err,
                "Failed to apply browser runtime overrides"
            );
        }
    });
    ready_rx.await.map_err(|_| {
        AppError::new(
            "cdp_connect_failed",
            "Runtime override watcher stopped before initial setup",
        )
        .retryable(true)
    })?
}

pub fn stop_watcher(port: u16) {
    active_watchers()
        .lock()
        .expect("active watcher registry should not be poisoned")
        .remove(&port);
}

pub async fn grant_geolocation_permission(port: u16, target_url: &str) -> AppResult<()> {
    let mut browser_session = BrowserSession::connect(port).await?;
    browser_session
        .grant_geolocation_permission(target_url)
        .await?;
    Ok(())
}

struct TargetSession {
    socket: CdpSocket,
    next_id: u64,
}

struct BrowserSession {
    socket: CdpSocket,
    next_id: u64,
}

struct WatchedTargetSession {
    // Emulation 覆盖与 CDP 会话绑定，必须持有连接直到目标关闭。
    _session: TargetSession,
    permission_origin: Option<String>,
}

struct ActiveWatcherGuard {
    port: u16,
    token: u64,
}

impl Drop for ActiveWatcherGuard {
    fn drop(&mut self) {
        let mut active = active_watchers()
            .lock()
            .expect("active watcher registry should not be poisoned");
        if active.get(&self.port) == Some(&self.token) {
            active.remove(&self.port);
        }
    }
}

impl TargetSession {
    async fn connect(target: &TargetInfo) -> AppResult<Self> {
        let Some(ws_url) = target.web_socket_debugger_url.as_deref() else {
            return Err(AppError::new(
                "cdp_connect_failed",
                "Page target is missing a websocket debugger URL",
            ));
        };
        let (socket, _) = connect_async(ws_url).await.map_err(|err| {
            AppError::new(
                "cdp_connect_failed",
                format!("CDP websocket connection failed: {err}"),
            )
        })?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn set_timezone(&mut self, timezone_id: &str) -> AppResult<()> {
        self.call(
            "Emulation.setTimezoneOverride",
            json!({ "timezoneId": timezone_id }),
        )
        .await
        .map(|_| ())
    }

    async fn set_geolocation(&mut self, geolocation: &GeolocationOverride) -> AppResult<()> {
        self.call(
            "Emulation.setGeolocationOverride",
            json!({
                "latitude": geolocation.latitude,
                "longitude": geolocation.longitude,
                "accuracy": geolocation.accuracy
            }),
        )
        .await
        .map(|_| ())
    }

    async fn set_locale(&mut self, locale: &str) -> AppResult<()> {
        self.call("Emulation.setLocaleOverride", json!({ "locale": locale }))
            .await
            .map(|_| ())
    }

    async fn set_user_agent(&mut self, overrides: &BrowserRuntimeOverrides) -> AppResult<()> {
        let Some(user_agent) = overrides.user_agent.as_deref() else {
            return Ok(());
        };
        let mut params = json!({ "userAgent": user_agent });
        if let Some(accept_language) = overrides.accept_language.as_deref() {
            params["acceptLanguage"] = json!(accept_language);
        }
        if let Some(platform) = overrides.platform.as_deref() {
            params["platform"] = json!(platform);
        }
        if let Some(metadata) = overrides.user_agent_metadata.as_ref() {
            params["userAgentMetadata"] = metadata.clone();
        }

        self.call("Network.setUserAgentOverride", params)
            .await
            .map(|_| ())
    }

    async fn install_runtime_script(&mut self, source: &str) -> AppResult<()> {
        self.call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": source }),
        )
        .await?;
        self.call(
            "Runtime.evaluate",
            json!({
                "expression": source,
                "awaitPromise": false,
                "returnByValue": true
            }),
        )
        .await
        .map(|_| ())
    }

    async fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP send failed: {err}"))
            })?;

        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP read failed: {err}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::new(
                        "cdp_connect_failed",
                        format!("CDP method failed: {method}"),
                    )
                    .details(error.clone()));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        }

        Err(AppError::new(
            "cdp_connect_failed",
            "CDP connection is closed",
        ))
    }
}

impl BrowserSession {
    async fn connect(port: u16) -> AppResult<Self> {
        let version = cdp_client::wait_for_version(port, Duration::from_secs(5)).await?;
        let ws_url = version.websocket_debugger_url.ok_or_else(|| {
            AppError::new(
                "cdp_connect_failed",
                "Browser target is missing a websocket debugger URL",
            )
        })?;
        let (socket, _) = connect_async(ws_url).await.map_err(|err| {
            AppError::new(
                "cdp_connect_failed",
                format!("CDP browser websocket connection failed: {err}"),
            )
        })?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn grant_geolocation_permission(&mut self, target_url: &str) -> AppResult<()> {
        let mut params = json!({ "permissions": ["geolocation"] });
        if let Some(origin) = target_origin(target_url) {
            params["origin"] = json!(origin);
        }
        self.call("Browser.grantPermissions", params).await?;
        Ok(())
    }

    async fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP send failed: {err}"))
            })?;

        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP read failed: {err}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::new(
                        "cdp_connect_failed",
                        format!("CDP method failed: {method}"),
                    )
                    .details(error.clone()));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        }

        Err(AppError::new(
            "cdp_connect_failed",
            "CDP connection is closed",
        ))
    }
}

async fn watch_targets(
    port: u16,
    watcher_token: u64,
    overrides: BrowserRuntimeOverrides,
    initial_ready: Option<oneshot::Sender<AppResult<()>>>,
) -> AppResult<()> {
    let mut target_sessions = HashMap::new();
    let mut consecutive_errors = 0;
    let initial_deadline = Instant::now() + Duration::from_secs(5);
    let mut initial_ready = initial_ready;
    loop {
        if !watcher_is_current(port, watcher_token) {
            let error = AppError::new(
                "cdp_connect_failed",
                "Runtime override watcher was stopped during initial setup",
            )
            .retryable(true);
            if let Some(initial_ready) = initial_ready.take() {
                let _ = initial_ready.send(Err(error.clone()));
            }
            return Err(error);
        }
        let initial_result = refresh_target_sessions(port, &overrides, &mut target_sessions).await;
        match initial_result {
            Ok(()) => {
                if let Some(initial_ready) = initial_ready.take() {
                    let _ = initial_ready.send(Ok(()));
                }
                break;
            }
            Err(err) if Instant::now() >= initial_deadline => {
                if let Some(initial_ready) = initial_ready.take() {
                    let _ = initial_ready.send(Err(err.clone()));
                }
                return Err(err);
            }
            Err(err) => {
                tracing::warn!(
                    cdp_port = port,
                    error = %err,
                    "Waiting to apply initial runtime overrides"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }

    loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if !watcher_is_current(port, watcher_token) {
            return Ok(());
        }
        match refresh_target_sessions(port, &overrides, &mut target_sessions).await {
            Ok(()) => {
                consecutive_errors = 0;
            }
            Err(err) => {
                consecutive_errors += 1;
                if consecutive_errors >= 5 || !cdp_client::ping(port).await {
                    return Err(err);
                }
                tracing::warn!(
                    cdp_port = port,
                    error = %err,
                    "Failed to refresh runtime override targets"
                );
            }
        }
    }
}

async fn refresh_target_sessions(
    port: u16,
    overrides: &BrowserRuntimeOverrides,
    target_sessions: &mut HashMap<String, WatchedTargetSession>,
) -> AppResult<()> {
    tokio::time::timeout(
        Duration::from_secs(5),
        apply_to_existing_targets(port, overrides, target_sessions),
    )
    .await
    .map_err(|_| {
        AppError::new(
            "cdp_timeout",
            "Timed out applying browser runtime overrides",
        )
        .retryable(true)
    })?
}

async fn apply_to_existing_targets(
    port: u16,
    overrides: &BrowserRuntimeOverrides,
    target_sessions: &mut HashMap<String, WatchedTargetSession>,
) -> AppResult<()> {
    let targets = cdp_client::list_targets(port).await?;
    retain_runtime_target_sessions(target_sessions, &targets);
    let supported_target_count = targets
        .iter()
        .filter(|target| supports_timezone_override(target))
        .count();
    let pending_target_ids = pending_runtime_targets(&targets, target_sessions)
        .into_iter()
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();

    let mut browser_session = None;
    for target in targets
        .iter()
        .filter(|target| supports_timezone_override(target))
    {
        let current_origin = target_origin(&target.url);
        if !pending_target_ids.contains(target.id.as_str()) {
            let Some(watched) = target_sessions.get_mut(&target.id) else {
                continue;
            };
            if overrides.geolocation.is_some() && watched.permission_origin != current_origin {
                if let Some(origin) = current_origin {
                    match grant_geolocation_permission_with_session(
                        port,
                        &target.url,
                        &mut browser_session,
                    )
                    .await
                    {
                        Ok(()) => watched.permission_origin = Some(origin),
                        Err(err) => {
                            tracing::warn!(
                                target_id = target.id,
                                target_url = target.url,
                                error = %err,
                                "Failed to update geolocation permission"
                            );
                        }
                    }
                } else {
                    watched.permission_origin = None;
                }
            }
            continue;
        }

        match TargetSession::connect(target).await {
            Ok(mut session) => {
                let mut keep_session = true;
                if let Some(source) = locale_mask_script(overrides)? {
                    if let Err(err) = session.install_runtime_script(&source).await {
                        keep_session = false;
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to install locale mask script"
                        );
                    }
                }
                if let Some(source) = font_mask_script(&overrides.masked_fonts)? {
                    if let Err(err) = session.install_runtime_script(&source).await {
                        keep_session = false;
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to install font mask script"
                        );
                    }
                }
                if let Err(err) = session.set_user_agent(overrides).await {
                    keep_session = false;
                    tracing::warn!(
                        target_id = target.id,
                        target_url = target.url,
                        error = %err,
                        "Failed to apply user-agent override"
                    );
                }
                if let Some(locale) = overrides.locale.as_deref() {
                    if let Err(err) = session.set_locale(locale).await {
                        keep_session = false;
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply locale override"
                        );
                    }
                }
                if let Some(timezone_id) = overrides.timezone_id.as_deref() {
                    if let Err(err) = session.set_timezone(timezone_id).await {
                        keep_session = false;
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply timezone override"
                        );
                    }
                }

                let mut permission_origin = None;
                if let Some(geolocation) = overrides.geolocation.as_ref() {
                    if let Some(origin) = current_origin {
                        match grant_geolocation_permission_with_session(
                            port,
                            &target.url,
                            &mut browser_session,
                        )
                        .await
                        {
                            Ok(()) => permission_origin = Some(origin),
                            Err(err) => {
                                keep_session = false;
                                tracing::warn!(
                                    target_id = target.id,
                                    target_url = target.url,
                                    error = %err,
                                    "Failed to grant geolocation permission"
                                );
                            }
                        }
                    }
                    if let Err(err) = session.set_geolocation(geolocation).await {
                        keep_session = false;
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply geolocation override"
                        );
                    }
                }
                if !keep_session {
                    continue;
                }
                target_sessions.insert(
                    target.id.clone(),
                    WatchedTargetSession {
                        _session: session,
                        permission_origin,
                    },
                );
            }
            Err(err) => {
                tracing::warn!(
                    target_id = target.id,
                    target_url = target.url,
                    error = %err,
                    "Failed to connect target for timezone override"
                );
            }
        }
    }

    if supported_target_count == 0 || target_sessions.is_empty() {
        return Err(AppError::new(
            "cdp_connect_failed",
            "No page target accepted the browser runtime overrides",
        )
        .retryable(true));
    }
    Ok(())
}

fn active_watchers() -> &'static Mutex<HashMap<u16, u64>> {
    ACTIVE_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn claim_watcher_port(port: u16) -> Option<u64> {
    let mut active = active_watchers()
        .lock()
        .expect("active watcher registry should not be poisoned");
    if active.contains_key(&port) {
        return None;
    }
    let token = NEXT_WATCHER_TOKEN.fetch_add(1, Ordering::Relaxed);
    active.insert(port, token);
    Some(token)
}

fn watcher_is_current(port: u16, token: u64) -> bool {
    active_watchers()
        .lock()
        .expect("active watcher registry should not be poisoned")
        .get(&port)
        == Some(&token)
}

async fn grant_geolocation_permission_with_session(
    port: u16,
    target_url: &str,
    browser_session: &mut Option<BrowserSession>,
) -> AppResult<()> {
    if browser_session.is_none() {
        *browser_session = Some(BrowserSession::connect(port).await?);
    }
    browser_session
        .as_mut()
        .expect("browser session must be initialized")
        .grant_geolocation_permission(target_url)
        .await
}

fn pending_runtime_targets<'a, T>(
    targets: &'a [TargetInfo],
    target_sessions: &HashMap<String, T>,
) -> Vec<&'a TargetInfo> {
    targets
        .iter()
        .filter(|target| supports_timezone_override(target))
        .filter(|target| !target_sessions.contains_key(&target.id))
        .collect()
}

fn retain_runtime_target_sessions<T>(
    target_sessions: &mut HashMap<String, T>,
    targets: &[TargetInfo],
) {
    let active_target_ids = targets
        .iter()
        .filter(|target| supports_timezone_override(target))
        .map(|target| target.id.as_str())
        .collect::<HashSet<_>>();
    target_sessions.retain(|target_id, _| active_target_ids.contains(target_id.as_str()));
}

fn normalize_timezone_id(timezone_id: Option<String>) -> Option<String> {
    normalize_optional_text(timezone_id)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_font_list(fonts: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for font in fonts {
        let font = font.trim().to_string();
        if font.is_empty() {
            continue;
        }
        if !normalized.iter().any(|item: &String| item == &font) {
            normalized.push(font);
        }
    }
    normalized
}

fn language_list(locale: Option<&str>, accept_language: Option<&str>) -> Vec<String> {
    let mut languages = Vec::new();
    if let Some(locale) = locale.map(str::trim).filter(|value| !value.is_empty()) {
        languages.push(locale.to_string());
    }
    if let Some(accept_language) = accept_language {
        for item in accept_language.split(',') {
            let language = item
                .split(';')
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(language) = language {
                if !languages
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case(language))
                {
                    languages.push(language.to_string());
                }
            }
        }
    }
    languages
}

fn locale_mask_script(overrides: &BrowserRuntimeOverrides) -> AppResult<Option<String>> {
    let Some(locale) = overrides.locale.as_deref() else {
        return Ok(None);
    };
    let locale_json = serde_json::to_string(locale)?;
    let languages_json = serde_json::to_string(&language_list(
        overrides.locale.as_deref(),
        overrides.accept_language.as_deref(),
    ))?;
    let source = r#"
(() => {
  const locale = __ORBIT_LOCALE__;
  const languages = __ORBIT_LANGUAGES__;

  if (globalThis.__orbitLocaleMaskInstalled || !locale) return;
  Object.defineProperty(globalThis, "__orbitLocaleMaskInstalled", { value: true });

  const defineGetter = (target, key, getter) => {
    try {
      Object.defineProperty(target, key, { configurable: true, get: getter });
    } catch (_) {}
  };

  const navProto = Navigator.prototype;
  defineGetter(navProto, "language", () => locale);
  defineGetter(navProto, "languages", () => languages.slice());

  const patchResolvedOptions = (instance) => {
    try {
      const originalResolvedOptions = instance.resolvedOptions;
      if (typeof originalResolvedOptions !== "function") return instance;
      Object.defineProperty(instance, "resolvedOptions", {
        configurable: true,
        value() {
          const options = originalResolvedOptions.call(this);
          return { ...options, locale };
        }
      });
    } catch (_) {}
    return instance;
  };

  const wrapIntlConstructor = (name) => {
    const Original = Intl?.[name];
    if (typeof Original !== "function") return;
    const normalizeArgs = (args) => {
      const values = Array.from(args || []);
      if (values.length === 0 || values[0] == null) {
        return [locale, ...values.slice(1)];
      }
      return values;
    };
    try {
      Intl[name] = new Proxy(Original, {
        construct(target, args, newTarget) {
          const instance = Reflect.construct(target, normalizeArgs(args), newTarget);
          return patchResolvedOptions(instance);
        },
        apply(target, thisArg, args) {
          const instance = Reflect.construct(target, normalizeArgs(args));
          return patchResolvedOptions(instance);
        }
      });
    } catch (_) {}
  };

  [
    "DateTimeFormat",
    "NumberFormat",
    "Collator",
    "PluralRules",
    "RelativeTimeFormat",
    "ListFormat",
    "DisplayNames",
    "Segmenter"
  ].forEach(wrapIntlConstructor);

  const wrapLocaleMethod = (prototype, key) => {
    const original = prototype?.[key];
    if (typeof original !== "function") return;
    try {
      Object.defineProperty(prototype, key, {
        configurable: true,
        value(locales, options) {
          return original.call(this, locales == null ? locale : locales, options);
        }
      });
    } catch (_) {}
  };

  wrapLocaleMethod(Date.prototype, "toLocaleString");
  wrapLocaleMethod(Date.prototype, "toLocaleDateString");
  wrapLocaleMethod(Date.prototype, "toLocaleTimeString");
  wrapLocaleMethod(Number.prototype, "toLocaleString");
  wrapLocaleMethod(BigInt.prototype, "toLocaleString");
})();
"#
    .replace("__ORBIT_LOCALE__", &locale_json)
    .replace("__ORBIT_LANGUAGES__", &languages_json);
    Ok(Some(source))
}

fn font_mask_script(fonts: &[String]) -> AppResult<Option<String>> {
    if fonts.is_empty() {
        return Ok(None);
    }
    let fonts_json = serde_json::to_string(fonts)?;
    let source = r#"
(() => {
  const blockedFonts = new Set(__ORBIT_BLOCKED_FONTS__.map((font) => String(font).toLowerCase()));
  const fallbackFamily = "Arial";
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasBlockedFont = (fontText) => {
    const text = String(fontText || "").toLowerCase();
    return Array.from(blockedFonts).some((font) => text.includes(font));
  };
  const maskFontText = (fontText) => {
    if (!hasBlockedFont(fontText)) return fontText;
    let masked = String(fontText);
    for (const font of blockedFonts) {
      masked = masked.replace(new RegExp(escapeRegExp(font), "gi"), fallbackFamily);
    }
    return masked;
  };

  if (!globalThis.__orbitFontMaskInstalled) {
    Object.defineProperty(globalThis, "__orbitFontMaskInstalled", { value: true });
    const canvasProto = globalThis.CanvasRenderingContext2D?.prototype;
    if (canvasProto) {
      const originalMeasureText = canvasProto.measureText;
      Object.defineProperty(canvasProto, "measureText", {
        configurable: true,
        value(text) {
          if (!hasBlockedFont(this.font)) {
            return originalMeasureText.call(this, text);
          }
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) return originalMeasureText.call(this, text);
          context.font = maskFontText(this.font);
          context.direction = this.direction;
          context.fontKerning = this.fontKerning;
          context.fontStretch = this.fontStretch;
          context.fontVariantCaps = this.fontVariantCaps;
          context.letterSpacing = this.letterSpacing;
          context.textRendering = this.textRendering;
          context.wordSpacing = this.wordSpacing;
          return originalMeasureText.call(context, text);
        }
      });
    }

    const fontFaceSetProto = globalThis.FontFaceSet?.prototype;
    if (fontFaceSetProto) {
      const originalCheck = fontFaceSetProto.check;
      if (originalCheck) {
        Object.defineProperty(fontFaceSetProto, "check", {
          configurable: true,
          value(font, text) {
            if (hasBlockedFont(font)) return false;
            return originalCheck.call(this, font, text);
          }
        });
      }
      const originalLoad = fontFaceSetProto.load;
      if (originalLoad) {
        Object.defineProperty(fontFaceSetProto, "load", {
          configurable: true,
          value(font, text) {
            if (hasBlockedFont(font)) return Promise.resolve([]);
            return originalLoad.call(this, font, text);
          }
        });
      }
    }

    const originalQueryLocalFonts = navigator.queryLocalFonts;
    if (typeof originalQueryLocalFonts === "function") {
      Object.defineProperty(navigator, "queryLocalFonts", {
        configurable: true,
        value: async (...args) => {
          const fonts = await originalQueryLocalFonts.apply(navigator, args);
          return fonts.filter((font) => !hasBlockedFont(font.family) && !hasBlockedFont(font.fullName));
        }
      });
    }
  }
})();
"#
    .replace("__ORBIT_BLOCKED_FONTS__", &fonts_json);
    Ok(Some(source))
}

fn supports_timezone_override(target: &TargetInfo) -> bool {
    matches!(target.kind.as_str(), "page" | "iframe")
}

fn target_origin(target_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(target_url).ok()?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{}{}", url.scheme(), host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, kind: &str, url: &str) -> TargetInfo {
        TargetInfo {
            id: id.to_string(),
            kind: kind.to_string(),
            title: String::new(),
            url: url.to_string(),
            web_socket_debugger_url: None,
        }
    }

    #[test]
    fn blank_timezone_is_ignored() {
        assert_eq!(normalize_timezone_id(None), None);
        assert_eq!(normalize_timezone_id(Some("  ".to_string())), None);
    }

    #[test]
    fn timezone_is_trimmed() {
        assert_eq!(
            normalize_timezone_id(Some(" Asia/Tokyo ".to_string())),
            Some("Asia/Tokyo".to_string())
        );
    }

    #[test]
    fn only_page_like_targets_receive_timezone_override() {
        let page = target("page-1", "page", "about:blank");
        let service_worker = target(
            "worker-1",
            "service_worker",
            "https://example.com/worker.js",
        );

        assert!(supports_timezone_override(&page));
        assert!(!supports_timezone_override(&service_worker));
    }

    #[test]
    fn pending_targets_select_new_page_and_iframe_sessions() {
        let targets = vec![
            target("page-existing", "page", "https://example.com"),
            target("page-new", "page", "https://example.org"),
            target("frame-new", "iframe", "https://example.net/frame"),
            target(
                "worker-new",
                "service_worker",
                "https://example.net/worker.js",
            ),
        ];
        let target_sessions = HashMap::from([("page-existing".to_string(), ())]);

        let pending_ids = pending_runtime_targets(&targets, &target_sessions)
            .into_iter()
            .map(|target| target.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(pending_ids, vec!["page-new", "frame-new"]);
    }

    #[test]
    fn target_session_cleanup_removes_closed_and_unsupported_targets() {
        let targets = vec![
            target("page-active", "page", "https://example.com"),
            target(
                "worker-active",
                "service_worker",
                "https://example.com/worker.js",
            ),
        ];
        let mut target_sessions = HashMap::from([
            ("page-active".to_string(), 1),
            ("page-closed".to_string(), 2),
            ("worker-active".to_string(), 3),
        ]);

        retain_runtime_target_sessions(&mut target_sessions, &targets);

        assert_eq!(
            target_sessions,
            HashMap::from([("page-active".to_string(), 1)])
        );
    }

    #[test]
    fn watcher_registry_prevents_duplicate_port_watchers() {
        let port = 65_001;
        let first_token = claim_watcher_port(port).expect("first watcher should register");
        assert_eq!(claim_watcher_port(port), None);
        assert!(watcher_is_current(port, first_token));

        stop_watcher(port);
        assert!(!watcher_is_current(port, first_token));
        let second_token = claim_watcher_port(port).expect("stopped port should register again");
        assert_ne!(first_token, second_token);
        drop(ActiveWatcherGuard {
            port,
            token: second_token,
        });
    }

    #[test]
    fn extracts_http_origin_for_permission_grant() {
        assert_eq!(
            target_origin("https://www.browserscan.net/zh"),
            Some("https://www.browserscan.net".to_string())
        );
        assert_eq!(target_origin("about:blank"), None);
    }
}
