use crate::browser::cdp_client::{self, TargetInfo};
use crate::errors::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

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

pub fn spawn(port: u16, overrides: BrowserRuntimeOverrides) {
    if overrides.is_empty() {
        return;
    }

    tokio::spawn(async move {
        if let Err(err) = watch_targets(port, overrides.clone()).await {
            tracing::warn!(
                cdp_port = port,
                error = %err,
                "Failed to apply browser runtime overrides"
            );
        }
    });
}

pub async fn apply_existing(port: u16, overrides: BrowserRuntimeOverrides) -> AppResult<()> {
    if overrides.is_empty() {
        return Ok(());
    }
    cdp_client::wait_for_version(port, Duration::from_secs(5)).await?;
    apply_to_existing_targets(port, &overrides, &mut HashSet::new()).await
}

pub async fn grant_geolocation_permission(port: u16, target_url: &str) -> AppResult<()> {
    let mut browser_session = BrowserSession::connect(port).await?;
    browser_session
        .grant_geolocation_permission(target_url)
        .await;
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

        self.call("Network.enable", json!({})).await?;
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

    async fn grant_geolocation_permission(&mut self, target_url: &str) {
        let mut params = json!({ "permissions": ["geolocation"] });
        if let Some(origin) = target_origin(target_url) {
            params["origin"] = json!(origin);
        }
        if let Err(err) = self.call("Browser.grantPermissions", params).await {
            tracing::warn!(
                target_url,
                error = %err,
                "Failed to grant geolocation permission"
            );
        }
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

async fn watch_targets(port: u16, overrides: BrowserRuntimeOverrides) -> AppResult<()> {
    let mut applied_target_ids = HashSet::new();
    let mut consecutive_errors = 0;

    loop {
        match apply_to_existing_targets(port, &overrides, &mut applied_target_ids).await {
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
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn apply_to_existing_targets(
    port: u16,
    overrides: &BrowserRuntimeOverrides,
    applied_target_ids: &mut HashSet<String>,
) -> AppResult<()> {
    let targets = cdp_client::list_targets(port).await?;
    let pending_targets = targets
        .iter()
        .filter(|target| supports_timezone_override(target))
        .filter(|target| {
            overrides.geolocation.is_some()
                || !applied_target_ids.contains(&target_apply_key(target))
        })
        .collect::<Vec<_>>();
    let mut browser_session = if overrides.geolocation.is_some() && !pending_targets.is_empty() {
        Some(BrowserSession::connect(port).await?)
    } else {
        None
    };
    for target in pending_targets {
        match TargetSession::connect(target).await {
            Ok(mut session) => {
                let apply_key = target_apply_key(target);
                let first_apply = !applied_target_ids.contains(&apply_key);
                if first_apply {
                    if let Some(source) = locale_mask_script(overrides)? {
                        if let Err(err) = session.install_runtime_script(&source).await {
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
                            tracing::warn!(
                                target_id = target.id,
                                target_url = target.url,
                                error = %err,
                                "Failed to install font mask script"
                            );
                        }
                    }
                    if let Err(err) = session.set_user_agent(overrides).await {
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply user-agent override"
                        );
                    }
                    if let Some(locale) = overrides.locale.as_deref() {
                        if let Err(err) = session.set_locale(locale).await {
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
                            tracing::warn!(
                                target_id = target.id,
                                target_url = target.url,
                                error = %err,
                                "Failed to apply timezone override"
                            );
                        }
                    }
                }
                if let Some(geolocation) = overrides.geolocation.as_ref() {
                    if let Some(browser_session) = browser_session.as_mut() {
                        browser_session
                            .grant_geolocation_permission(&target.url)
                            .await;
                    }
                    if let Err(err) = session.set_geolocation(geolocation).await {
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply geolocation override"
                        );
                    }
                }
                applied_target_ids.insert(apply_key);
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

    Ok(())
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

fn target_apply_key(target: &TargetInfo) -> String {
    format!("{}:{}", target.id, target.url)
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
        let page = TargetInfo {
            id: "page-1".to_string(),
            kind: "page".to_string(),
            title: String::new(),
            url: String::new(),
            web_socket_debugger_url: None,
        };
        let service_worker = TargetInfo {
            kind: "service_worker".to_string(),
            ..page.clone()
        };

        assert!(supports_timezone_override(&page));
        assert!(!supports_timezone_override(&service_worker));
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
