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

pub fn build(
    data_dir: &Path,
    env: &Environment,
    profile_dir: &Path,
    cdp_port: u16,
    accept_languages: Option<&str>,
) -> AppResult<ChromeLaunchPlan> {
    migrate_legacy_orbit_profile_preferences(profile_dir)?;
    if let Some(accept_languages) = accept_languages {
        write_accept_languages_preference(profile_dir, accept_languages)?;
    }

    let mut args = vec![
        format!("--user-data-dir={}", profile_dir.to_string_lossy()),
        // 使用非常用高位端口，并仅绑定本机回环，降低 CDP 端口被外网/页面侧探测的风险。
        format!("--remote-debugging-port={cdp_port}"),
        "--remote-debugging-address=127.0.0.1".to_string(),
        // Chrome 111+ 需要显式放行本地 CDP 客户端来源。
        "--remote-allow-origins=*".to_string(),
        // 关闭 AutomationControlled，避免 navigator.webdriver / 自动化横幅暴露。
        "--disable-blink-features=AutomationControlled".to_string(),
        "--exclude-switches=enable-automation".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-popup-blocking".to_string(),
        "--disable-search-engine-choice-screen".to_string(),
    ];

    if env.headless {
        args.push("--headless=new".to_string());
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

fn write_accept_languages_preference(profile_dir: &Path, accept_languages: &str) -> AppResult<()> {
    let default_dir = profile_dir.join("Default");
    std::fs::create_dir_all(&default_dir)?;
    let preferences_path = default_dir.join("Preferences");
    let mut preferences = if preferences_path.exists() {
        std::fs::read_to_string(&preferences_path)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    if !preferences
        .get("intl")
        .is_some_and(|value| value.is_object())
    {
        preferences["intl"] = json!({});
    }
    preferences["intl"]["accept_languages"] = json!(accept_languages);
    std::fs::write(
        preferences_path,
        serde_json::to_string_pretty(&preferences)?,
    )?;
    Ok(())
}

fn migrate_legacy_orbit_profile_preferences(profile_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(profile_dir)?;
    let migration_marker = profile_dir.join(".orbit-native-profile-v1");
    if migration_marker.exists() {
        return Ok(());
    }

    let preferences_path = profile_dir.join("Default").join("Preferences");
    if !preferences_path.exists() {
        std::fs::write(migration_marker, b"1")?;
        return Ok(());
    }

    let content = std::fs::read_to_string(&preferences_path)?;
    let mut preferences = match serde_json::from_str::<Value>(&content) {
        Ok(Value::Object(preferences)) => preferences,
        _ => {
            std::fs::write(migration_marker, b"1")?;
            return Ok(());
        }
    };
    let legacy_accept_languages = preferences
        .get("intl")
        .and_then(|value| value.get("accept_languages"))
        .and_then(Value::as_str)
        .is_some_and(is_legacy_orbit_accept_languages);
    let legacy_geolocation_permission = preferences
        .get("profile")
        .and_then(|value| value.get("default_content_setting_values"))
        .and_then(|value| value.get("geolocation"))
        .and_then(Value::as_i64)
        == Some(1);
    let changed = legacy_accept_languages && legacy_geolocation_permission;

    if changed {
        if let Some(Value::Object(intl)) = preferences.get_mut("intl") {
            intl.remove("accept_languages");
            if intl.is_empty() {
                preferences.remove("intl");
            }
        }
        if let Some(Value::Object(profile)) = preferences.get_mut("profile") {
            if let Some(Value::Object(defaults)) = profile.get_mut("default_content_setting_values")
            {
                defaults.remove("geolocation");
                if defaults.is_empty() {
                    profile.remove("default_content_setting_values");
                }
            }
            if profile.is_empty() {
                preferences.remove("profile");
            }
        }
        std::fs::write(
            preferences_path,
            serde_json::to_string_pretty(&Value::Object(preferences))?,
        )?;
    }
    std::fs::write(migration_marker, b"1")?;
    Ok(())
}

fn is_legacy_orbit_accept_languages(value: &str) -> bool {
    matches!(
        value,
        "zh-CN,zh,en"
            | "zh-HK,zh,en"
            | "zh-MO,zh,en"
            | "zh-TW,zh,en"
            | "ja-JP,ja,en"
            | "ko-KR,ko,en"
            | "en-GB,en"
            | "en-US,en"
            | "en-IN,en"
            | "en-SG,en"
            | "de-DE,de,en"
            | "fr-FR,fr,en"
            | "es-ES,es,en"
            | "it-IT,it,en"
            | "pt-BR,pt,en"
            | "ru-RU,ru,en"
    )
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

        let plan = build(&root, &env, &profile_dir, 9222, None).unwrap();

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

        let plan = build(&root, &env, &profile_dir, 9222, None).unwrap();

        assert!(plan.args.iter().any(|arg| arg == "--headless=new"));
    }

    #[test]
    fn chrome_cdp_listens_on_loopback_only() {
        let root = std::env::temp_dir().join(format!("orbit-cdp-bind-{}", uuid::Uuid::new_v4()));
        let env = test_environment();
        let profile_dir = root.join("profiles").join("env_cdp");

        let plan = build(&root, &env, &profile_dir, 47_123, None).unwrap();

        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--remote-debugging-port=47123"));
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--remote-debugging-address=127.0.0.1"));
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--remote-allow-origins=*"));
        assert!(plan.args.iter().any(|arg| {
            arg == "--disable-blink-features=AutomationControlled"
        }));
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--exclude-switches=enable-automation"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn chrome_launch_keeps_native_identity_and_window_fingerprint() {
        let root = std::env::temp_dir().join(format!("orbit-lang-test-{}", uuid::Uuid::new_v4()));
        let mut env = test_environment();
        env.user_agent = Some("OrbitTestAgent/1.0".to_string());
        env.web_rtc_protection = true;
        let profile_dir = root.join("profiles").join("env_lang");

        let plan = build(&root, &env, &profile_dir, 9222, None).unwrap();

        assert!(!plan.args.iter().any(|arg| arg.starts_with("--lang=")));
        assert!(!plan.args.iter().any(|arg| arg.starts_with("--user-agent=")));
        assert!(!plan
            .args
            .iter()
            .any(|arg| arg.starts_with("--window-size=")));
        assert!(!plan
            .args
            .iter()
            .any(|arg| arg.starts_with("--force-webrtc-ip-handling-policy=")));
        assert!(!profile_dir.join("Default").join("Preferences").exists());

        if root.exists() {
            std::fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn chrome_launch_writes_ip_matched_native_language_preference() {
        let root =
            std::env::temp_dir().join(format!("orbit-language-test-{}", uuid::Uuid::new_v4()));
        let env = test_environment();
        let profile_dir = root.join("profiles").join("env_language");

        build(&root, &env, &profile_dir, 9222, Some("en-US,en")).unwrap();

        let preferences: Value = serde_json::from_str(
            &std::fs::read_to_string(profile_dir.join("Default").join("Preferences")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            preferences.pointer("/intl/accept_languages"),
            Some(&json!("en-US,en"))
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn chrome_launch_migrates_legacy_orbit_profile_preferences_once() {
        let root = std::env::temp_dir().join(format!("orbit-prefs-test-{}", uuid::Uuid::new_v4()));
        let env = test_environment();
        let profile_dir = root.join("profiles").join("env_prefs");
        let default_dir = profile_dir.join("Default");
        std::fs::create_dir_all(&default_dir).unwrap();
        std::fs::write(
            default_dir.join("Preferences"),
            serde_json::to_string_pretty(&json!({
                "intl": { "accept_languages": "zh-CN,zh,en", "charset_default": "UTF-8" },
                "profile": {
                    "default_content_setting_values": { "geolocation": 1, "notifications": 2 },
                    "name": "Person 1"
                },
                "browser": { "check_default_browser": false }
            }))
            .unwrap(),
        )
        .unwrap();

        build(&root, &env, &profile_dir, 9222, None).unwrap();

        let preferences: Value = serde_json::from_str(
            &std::fs::read_to_string(default_dir.join("Preferences")).unwrap(),
        )
        .unwrap();
        assert!(preferences.pointer("/intl/accept_languages").is_none());
        assert!(preferences
            .pointer("/profile/default_content_setting_values/geolocation")
            .is_none());
        assert_eq!(
            preferences.pointer("/intl/charset_default"),
            Some(&json!("UTF-8"))
        );
        assert_eq!(
            preferences.pointer("/profile/default_content_setting_values/notifications"),
            Some(&json!(2))
        );
        assert_eq!(
            preferences.pointer("/profile/name"),
            Some(&json!("Person 1"))
        );
        assert!(profile_dir.join(".orbit-native-profile-v1").exists());

        let mut user_preferences = preferences;
        user_preferences["intl"]["accept_languages"] = json!("fr-CA,fr,en");
        user_preferences["profile"]["default_content_setting_values"]["geolocation"] = json!(2);
        std::fs::write(
            default_dir.join("Preferences"),
            serde_json::to_string_pretty(&user_preferences).unwrap(),
        )
        .unwrap();

        build(&root, &env, &profile_dir, 9222, None).unwrap();

        let preserved: Value = serde_json::from_str(
            &std::fs::read_to_string(default_dir.join("Preferences")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            preserved.pointer("/intl/accept_languages"),
            Some(&json!("fr-CA,fr,en"))
        );
        assert_eq!(
            preserved.pointer("/profile/default_content_setting_values/geolocation"),
            Some(&json!(2))
        );

        std::fs::remove_dir_all(&root).unwrap();
    }
}
