use crate::domain::environment::Environment;
use crate::domain::proxy::ProxyKind;
use crate::errors::AppResult;
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ChromeLaunchPlan {
    pub args: Vec<String>,
    #[allow(dead_code)]
    pub proxy_extension_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct ChromeRuntimeOptions {
    pub locale: String,
    pub accept_language: String,
    pub user_agent: Option<String>,
}

pub fn build(
    data_dir: &Path,
    env: &Environment,
    profile_dir: &Path,
    cdp_port: u16,
    runtime: &ChromeRuntimeOptions,
) -> AppResult<ChromeLaunchPlan> {
    write_profile_preferences(profile_dir, &runtime.accept_language)?;

    let mut args = vec![
        format!("--user-data-dir={}", profile_dir.to_string_lossy()),
        format!("--remote-debugging-port={cdp_port}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-popup-blocking".to_string(),
        "--disable-search-engine-choice-screen".to_string(),
        format!("--lang={}", runtime.locale),
        format!(
            "--window-size={},{}",
            env.viewport_width, env.viewport_height
        ),
    ];

    if env.headless {
        args.push("--headless=new".to_string());
    }

    if let Some(user_agent) = runtime
        .user_agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push(format!("--user-agent={user_agent}"));
    }

    if env.web_rtc_protection {
        args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string());
    }

    let proxy_extension_dir = if env.proxy_config.has_auth() {
        Some(create_proxy_auth_extension(data_dir, env)?)
    } else {
        None
    };

    if let Some(server) = env.proxy_config.chrome_server() {
        args.push(format!("--proxy-server={server}"));
    }

    if let Some(extension_dir) = &proxy_extension_dir {
        args.push(format!(
            "--load-extension={}",
            extension_dir.to_string_lossy()
        ));
    }

    args.push("about:blank".to_string());

    Ok(ChromeLaunchPlan {
        args,
        proxy_extension_dir,
    })
}

pub fn cleanup_proxy_extension(data_dir: &Path, environment_id: &str) -> AppResult<()> {
    let root = data_dir.join("temp").join("proxy-extensions");
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(environment_id)
        {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

fn create_proxy_auth_extension(data_dir: &Path, env: &Environment) -> AppResult<PathBuf> {
    let proxy = &env.proxy_config;
    let Some(host) = proxy.host.as_deref() else {
        return Ok(data_dir.join("temp").join("proxy-extensions").join(&env.id));
    };
    let Some(port) = proxy.port else {
        return Ok(data_dir.join("temp").join("proxy-extensions").join(&env.id));
    };
    let scheme = match proxy.kind {
        ProxyKind::Http => "http",
        ProxyKind::Https => "https",
        ProxyKind::Socks4 => "socks4",
        ProxyKind::Socks5 => "socks5",
        ProxyKind::None => "http",
    };
    let username = proxy.username.clone().unwrap_or_default();
    let password = proxy.password.clone().unwrap_or_default();
    let hash = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{scheme}:{host}:{port}:{username}"))
        .chars()
        .take(16)
        .collect::<String>();
    let extension_dir = data_dir
        .join("temp")
        .join("proxy-extensions")
        .join(format!("{}-{hash}", env.id));
    std::fs::create_dir_all(&extension_dir)?;

    let manifest = json!({
        "manifest_version": 3,
        "name": "orbit browser proxy auth",
        "version": "0.1.0",
        "permissions": ["proxy", "webRequest", "webRequestAuthProvider"],
        "host_permissions": ["<all_urls>"],
        "background": { "service_worker": "background.js" }
    });
    std::fs::write(
        extension_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let bypass = proxy.bypass_list.join(",");
    let background = format!(
        r#"
chrome.proxy.settings.set({{
  value: {{
    mode: "fixed_servers",
    rules: {{
      singleProxy: {{ scheme: "{scheme}", host: "{host}", port: {port} }},
      bypassList: {bypass:?}
    }}
  }},
  scope: "regular"
}});

chrome.webRequest.onAuthRequired.addListener(
  () => ({{ authCredentials: {{ username: {username:?}, password: {password:?} }} }}),
  {{ urls: ["<all_urls>"] }},
  ["blocking"]
);
"#
    );
    std::fs::write(extension_dir.join("background.js"), background)?;
    Ok(extension_dir)
}

fn write_profile_preferences(profile_dir: &Path, accept_language: &str) -> AppResult<()> {
    let default_profile_dir = profile_dir.join("Default");
    std::fs::create_dir_all(&default_profile_dir)?;
    let preferences_path = default_profile_dir.join("Preferences");
    let mut preferences = if preferences_path.exists() {
        std::fs::read_to_string(&preferences_path)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };

    let accept_language = accept_language
        .split(',')
        .filter_map(|item| item.split(';').next())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    if !preferences
        .get("intl")
        .is_some_and(|value| value.is_object())
    {
        preferences["intl"] = json!({});
    }
    preferences["intl"]["accept_languages"] = json!(accept_language);
    if !preferences
        .get("profile")
        .is_some_and(|value| value.is_object())
    {
        preferences["profile"] = json!({});
    }
    if !preferences["profile"]
        .get("default_content_setting_values")
        .is_some_and(|value| value.is_object())
    {
        preferences["profile"]["default_content_setting_values"] = json!({});
    }
    preferences["profile"]["default_content_setting_values"]["geolocation"] = json!(1);
    std::fs::write(
        preferences_path,
        serde_json::to_string_pretty(&preferences)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::environment::{BrowserKind, EnvironmentMode};
    use crate::domain::proxy::{ProxyConfig, ProxyKind};

    fn test_environment() -> Environment {
        Environment {
            id: "env_proxy_auth".to_string(),
            name: "Proxy Auth".to_string(),
            group_id: None,
            tags: Vec::new(),
            notes: None,
            browser_kind: BrowserKind::Chrome,
            chrome_path_override: None,
            profile_dir: "profiles/env_proxy_auth/chrome-user-data".to_string(),
            proxy_config: ProxyConfig {
                kind: ProxyKind::Http,
                host: Some("127.0.0.1".to_string()),
                port: Some(18888),
                username: Some("demo-user".to_string()),
                password: Some("demo-password".to_string()),
                bypass_list: vec!["localhost".to_string(), "127.0.0.1".to_string()],
            },
            locale: "en-US".to_string(),
            timezone_id: Some("UTC".to_string()),
            geolocation_latitude: None,
            geolocation_longitude: None,
            user_agent: None,
            platform: None,
            web_rtc_protection: true,
            viewport_width: 1280,
            viewport_height: 800,
            device_scale_factor: 1.0,
            environment_mode: EnvironmentMode::Standard,
            seed: None,
            headless: false,
            start_url: Some("about:blank".to_string()),
            created_at: "2026-06-17T00:00:00Z".to_string(),
            updated_at: "2026-06-17T00:00:00Z".to_string(),
            deleted_at: None,
        }
    }

    fn runtime_options() -> ChromeRuntimeOptions {
        ChromeRuntimeOptions {
            locale: "zh-CN".to_string(),
            accept_language: "zh-CN,zh;q=0.9,en;q=0.8".to_string(),
            user_agent: Some("OrbitTestAgent/1.0".to_string()),
        }
    }

    #[test]
    fn authenticated_proxy_generates_extension_files() {
        let root = std::env::temp_dir().join(format!("orbit-proxy-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let env = test_environment();

        let extension_dir = create_proxy_auth_extension(&root, &env).unwrap();
        let manifest = std::fs::read_to_string(extension_dir.join("manifest.json")).unwrap();
        let background = std::fs::read_to_string(extension_dir.join("background.js")).unwrap();

        assert!(extension_dir.starts_with(root.join("temp").join("proxy-extensions")));
        assert!(!extension_dir.to_string_lossy().contains("demo-password"));
        assert!(manifest.contains(r#""manifest_version": 3"#));
        assert!(manifest.contains("orbit browser proxy auth"));
        assert!(manifest.contains("webRequestAuthProvider"));
        assert!(background.contains(r#"scheme: "http""#));
        assert!(background.contains(r#"host: "127.0.0.1""#));
        assert!(background.contains("port: 18888"));
        assert!(background.contains(r#"username: "demo-user""#));
        assert!(background.contains(r#"password: "demo-password""#));
        assert!(background.contains(r#""localhost,127.0.0.1""#));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unauthenticated_proxy_does_not_create_extension() {
        let root = std::env::temp_dir().join(format!("orbit-proxy-test-{}", uuid::Uuid::new_v4()));
        let mut env = test_environment();
        env.proxy_config.username = None;
        env.proxy_config.password = None;
        let profile_dir = root.join("profiles").join("env_proxy_auth");

        let plan = build(&root, &env, &profile_dir, 9222, &runtime_options()).unwrap();

        assert!(plan.proxy_extension_dir.is_none());
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--proxy-server=http://127.0.0.1:18888"));
        assert!(!root.join("temp").join("proxy-extensions").exists());
    }

    #[test]
    fn headless_environment_uses_new_headless_mode() {
        let root =
            std::env::temp_dir().join(format!("orbit-headless-test-{}", uuid::Uuid::new_v4()));
        let mut env = test_environment();
        env.headless = true;
        let profile_dir = root.join("profiles").join("env_headless");

        let plan = build(&root, &env, &profile_dir, 9222, &runtime_options()).unwrap();

        assert!(plan.args.iter().any(|arg| arg == "--headless=new"));
    }

    #[test]
    fn runtime_languages_are_written_to_profile_preferences() {
        let root = std::env::temp_dir().join(format!("orbit-lang-test-{}", uuid::Uuid::new_v4()));
        let env = test_environment();
        let profile_dir = root.join("profiles").join("env_lang");

        let plan = build(&root, &env, &profile_dir, 9222, &runtime_options()).unwrap();
        let preferences =
            std::fs::read_to_string(profile_dir.join("Default").join("Preferences")).unwrap();

        assert!(plan.args.iter().any(|arg| arg == "--lang=zh-CN"));
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--user-agent=OrbitTestAgent/1.0"));
        assert!(preferences.contains(r#""accept_languages": "zh-CN,zh,en""#));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
