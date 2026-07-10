use crate::domain::environment::{
    BrowserKind, BrowserSessionRecord, Environment, EnvironmentMode, SaveEnvironmentInput,
};
use crate::domain::proxy::ProxyConfig;
use crate::errors::{AppError, AppResult};
use crate::storage::db::Db;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;

pub fn list(db: &Db) -> AppResult<Vec<Environment>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, name, group_id, tags_json, notes, browser_kind, chrome_path_override,
               profile_dir, proxy_config_json, locale, timezone_id, geolocation_latitude,
               geolocation_longitude, user_agent, platform, web_rtc_protection,
               viewport_width, viewport_height, device_scale_factor, environment_mode,
               seed, headless, start_url, created_at, updated_at, deleted_at
        FROM environments
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        "#,
    )?;
    let rows = stmt.query_map([], row_to_environment)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

pub fn get(db: &Db, id: &str) -> AppResult<Environment> {
    let conn = db.connect()?;
    conn.query_row(
        r#"
        SELECT id, name, group_id, tags_json, notes, browser_kind, chrome_path_override,
               profile_dir, proxy_config_json, locale, timezone_id, geolocation_latitude,
               geolocation_longitude, user_agent, platform, web_rtc_protection,
               viewport_width, viewport_height, device_scale_factor, environment_mode,
               seed, headless, start_url, created_at, updated_at, deleted_at
        FROM environments
        WHERE id = ?1 AND deleted_at IS NULL
        "#,
        params![id],
        row_to_environment,
    )
    .optional()?
    .ok_or_else(|| {
        AppError::new(
            "environment_not_found",
            "Environment does not exist or was deleted",
        )
    })
}

pub fn save(db: &Db, mut input: SaveEnvironmentInput) -> AppResult<Environment> {
    normalize_browser_specific_fields(&mut input);
    validate_input(&input)?;
    let conn = db.connect()?;
    let now = Utc::now().to_rfc3339();
    let id = input
        .id
        .unwrap_or_else(|| format!("env_{}", Uuid::new_v4()));
    let profile_dir = format!("profiles/{id}/chrome-user-data");
    let tags_json = serde_json::to_string(&input.tags)?;
    let proxy_json = serde_json::to_string(&input.proxy_config)?;
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM environments WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let created_at = existing_created_at.unwrap_or_else(|| now.clone());

    conn.execute(
        r#"
        INSERT INTO environments (
          id, name, group_id, tags_json, notes, browser_kind, chrome_path_override,
          profile_dir, proxy_config_json, locale, timezone_id, geolocation_latitude,
          geolocation_longitude, user_agent, platform, web_rtc_protection,
          viewport_width, viewport_height, device_scale_factor, environment_mode,
          seed, headless, start_url, created_at, updated_at, deleted_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          group_id = excluded.group_id,
          tags_json = excluded.tags_json,
          notes = excluded.notes,
          browser_kind = excluded.browser_kind,
          chrome_path_override = excluded.chrome_path_override,
          proxy_config_json = excluded.proxy_config_json,
          locale = excluded.locale,
          timezone_id = excluded.timezone_id,
          geolocation_latitude = excluded.geolocation_latitude,
          geolocation_longitude = excluded.geolocation_longitude,
          user_agent = excluded.user_agent,
          platform = excluded.platform,
          web_rtc_protection = excluded.web_rtc_protection,
          viewport_width = excluded.viewport_width,
          viewport_height = excluded.viewport_height,
          device_scale_factor = excluded.device_scale_factor,
          environment_mode = excluded.environment_mode,
          seed = excluded.seed,
          headless = excluded.headless,
          start_url = excluded.start_url,
          updated_at = excluded.updated_at,
          deleted_at = NULL
        "#,
        params![
            id,
            input.name.trim(),
            input.group_id.filter(|value| !value.trim().is_empty()),
            tags_json,
            input.notes.filter(|value| !value.trim().is_empty()),
            browser_kind_to_str(&input.browser_kind),
            input
                .chrome_path_override
                .filter(|value| !value.trim().is_empty()),
            profile_dir,
            proxy_json,
            input.locale,
            input.timezone_id.filter(|value| !value.trim().is_empty()),
            input.geolocation_latitude,
            input.geolocation_longitude,
            input.user_agent.filter(|value| !value.trim().is_empty()),
            input.platform.filter(|value| !value.trim().is_empty()),
            input.web_rtc_protection,
            input.viewport_width,
            input.viewport_height,
            input.device_scale_factor,
            environment_mode_to_str(&input.environment_mode),
            input.seed.filter(|value| !value.trim().is_empty()),
            input.headless,
            input.start_url.filter(|value| !value.trim().is_empty()),
            created_at,
            now
        ],
    )?;

    get(db, &id)
}

fn normalize_browser_specific_fields(input: &mut SaveEnvironmentInput) {
    if matches!(input.browser_kind, BrowserKind::Chrome) {
        // Chrome 保持原生浏览器身份；环境级配置只允许后续通过原生 CDP
        // 应用时区与定位，避免保存的旧指纹字段从 MCP/导入路径重新生效。
        input.locale = "auto".to_string();
        input.timezone_id = Some("auto".to_string());
        input.user_agent = None;
        input.platform = None;
        input.web_rtc_protection = false;
        input.device_scale_factor = 1.0;
        input.environment_mode = EnvironmentMode::Standard;
        input.seed = None;
    }
}

pub fn duplicate(db: &Db, id: &str) -> AppResult<Environment> {
    let source = get(db, id)?;
    let input = SaveEnvironmentInput {
        id: None,
        name: format!("{} Copy", source.name),
        group_id: source.group_id,
        tags: source.tags,
        notes: source.notes,
        browser_kind: source.browser_kind,
        chrome_path_override: source.chrome_path_override,
        proxy_config: source.proxy_config,
        locale: source.locale,
        timezone_id: source.timezone_id,
        geolocation_latitude: source.geolocation_latitude,
        geolocation_longitude: source.geolocation_longitude,
        user_agent: source.user_agent,
        platform: source.platform,
        web_rtc_protection: source.web_rtc_protection,
        viewport_width: source.viewport_width,
        viewport_height: source.viewport_height,
        device_scale_factor: source.device_scale_factor,
        environment_mode: source.environment_mode,
        seed: source.seed,
        headless: source.headless,
        start_url: source.start_url,
    };
    save(db, input)
}

pub fn hard_delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.connect()?;
    let affected = conn.execute("DELETE FROM environments WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::new(
            "environment_not_found",
            "Environment does not exist",
        ));
    }
    Ok(())
}

pub fn upsert_session_record(db: &Db, record: &BrowserSessionRecord) -> AppResult<()> {
    let conn = db.connect()?;
    conn.execute(
        r#"
        INSERT INTO browser_session_records (
          environment_id, pid, cdp_port, websocket_url, profile_dir, started_at, last_seen_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(environment_id) DO UPDATE SET
          pid = excluded.pid,
          cdp_port = excluded.cdp_port,
          websocket_url = excluded.websocket_url,
          profile_dir = excluded.profile_dir,
          last_seen_at = excluded.last_seen_at
        "#,
        params![
            record.environment_id,
            record.pid,
            record.cdp_port,
            record.websocket_url,
            record.profile_dir,
            record.started_at,
            record.last_seen_at
        ],
    )?;
    Ok(())
}

pub fn delete_session_record(db: &Db, environment_id: &str) -> AppResult<()> {
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM browser_session_records WHERE environment_id = ?1",
        params![environment_id],
    )?;
    Ok(())
}

pub fn list_session_records(db: &Db) -> AppResult<Vec<BrowserSessionRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT environment_id, pid, cdp_port, websocket_url, profile_dir, started_at, last_seen_at
        FROM browser_session_records
        "#,
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BrowserSessionRecord {
            environment_id: row.get(0)?,
            pid: row.get::<_, i64>(1)? as u32,
            cdp_port: row.get::<_, i64>(2)? as u16,
            websocket_url: row.get(3)?,
            profile_dir: row.get(4)?,
            started_at: row.get(5)?,
            last_seen_at: row.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

fn row_to_environment(row: &Row<'_>) -> rusqlite::Result<Environment> {
    let tags_json: String = row.get(3)?;
    let proxy_json: String = row.get(8)?;
    let tags = serde_json::from_str(&tags_json).unwrap_or_default();
    let proxy_config = serde_json::from_str(&proxy_json).unwrap_or_default();

    Ok(Environment {
        id: row.get(0)?,
        name: row.get(1)?,
        group_id: row.get(2)?,
        tags,
        notes: row.get(4)?,
        browser_kind: parse_browser_kind(row.get::<_, String>(5)?.as_str()),
        chrome_path_override: row.get(6)?,
        profile_dir: row.get(7)?,
        proxy_config,
        locale: row.get(9)?,
        timezone_id: row.get(10)?,
        geolocation_latitude: row.get(11)?,
        geolocation_longitude: row.get(12)?,
        user_agent: row.get(13)?,
        platform: row.get(14)?,
        web_rtc_protection: row.get(15)?,
        viewport_width: row.get(16)?,
        viewport_height: row.get(17)?,
        device_scale_factor: row.get(18)?,
        environment_mode: parse_environment_mode(row.get::<_, String>(19)?.as_str()),
        seed: row.get(20)?,
        headless: row.get(21)?,
        start_url: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
        deleted_at: row.get(25)?,
    })
}

fn validate_input(input: &SaveEnvironmentInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::new(
            "validation_error",
            "Environment name is required",
        ));
    }
    if input.viewport_width < 320 || input.viewport_height < 240 {
        return Err(AppError::new(
            "validation_error",
            "Viewport size cannot be smaller than 320x240",
        ));
    }
    if input.device_scale_factor <= 0.0 {
        return Err(AppError::new(
            "validation_error",
            "Device scale factor must be greater than 0",
        ));
    }
    if input
        .user_agent
        .as_deref()
        .is_some_and(|value| value.trim().len() > 512)
    {
        return Err(AppError::new(
            "validation_error",
            "User-Agent cannot exceed 512 characters",
        ));
    }
    if input
        .platform
        .as_deref()
        .is_some_and(|value| value.trim().len() > 64)
    {
        return Err(AppError::new(
            "validation_error",
            "Platform cannot exceed 64 characters",
        ));
    }
    match (input.geolocation_latitude, input.geolocation_longitude) {
        (Some(latitude), Some(longitude)) => {
            if !(-90.0..=90.0).contains(&latitude) {
                return Err(AppError::new(
                    "validation_error",
                    "Latitude must be between -90 and 90",
                ));
            }
            if !(-180.0..=180.0).contains(&longitude) {
                return Err(AppError::new(
                    "validation_error",
                    "Longitude must be between -180 and 180",
                ));
            }
        }
        (None, None) => {}
        _ => {
            return Err(AppError::new(
                "validation_error",
                "Latitude and longitude must be provided together",
            ));
        }
    }
    Ok(())
}

fn browser_kind_to_str(value: &BrowserKind) -> &'static str {
    match value {
        BrowserKind::Chrome => "chrome",
        BrowserKind::Camoufox => "camoufox",
    }
}

fn parse_browser_kind(value: &str) -> BrowserKind {
    match value {
        "camoufox" => BrowserKind::Camoufox,
        _ => BrowserKind::Chrome,
    }
}

fn environment_mode_to_str(value: &EnvironmentMode) -> &'static str {
    match value {
        EnvironmentMode::Standard => "standard",
        EnvironmentMode::Custom => "custom",
    }
}

fn parse_environment_mode(value: &str) -> EnvironmentMode {
    match value {
        "custom" => EnvironmentMode::Custom,
        _ => EnvironmentMode::Standard,
    }
}

#[allow(dead_code)]
fn _default_proxy() -> ProxyConfig {
    ProxyConfig::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_save_policy_removes_identity_overrides() {
        let mut input = SaveEnvironmentInput {
            id: None,
            name: "Chrome".to_string(),
            group_id: None,
            tags: Vec::new(),
            notes: None,
            browser_kind: BrowserKind::Chrome,
            chrome_path_override: None,
            proxy_config: ProxyConfig::default(),
            locale: "zh-CN".to_string(),
            timezone_id: Some("Asia/Shanghai".to_string()),
            geolocation_latitude: Some(31.2304),
            geolocation_longitude: Some(121.4737),
            user_agent: Some("custom-agent".to_string()),
            platform: Some("Win32".to_string()),
            web_rtc_protection: true,
            viewport_width: 1440,
            viewport_height: 900,
            device_scale_factor: 2.0,
            environment_mode: EnvironmentMode::Custom,
            seed: Some("seed".to_string()),
            headless: false,
            start_url: Some("about:blank".to_string()),
        };

        normalize_browser_specific_fields(&mut input);

        assert_eq!(input.locale, "auto");
        assert!(input.user_agent.is_none());
        assert!(input.platform.is_none());
        assert!(!input.web_rtc_protection);
        assert_eq!(input.device_scale_factor, 1.0);
        assert!(matches!(input.environment_mode, EnvironmentMode::Standard));
        assert!(input.seed.is_none());
        assert_eq!(input.timezone_id.as_deref(), Some("auto"));
        assert_eq!(input.geolocation_latitude, Some(31.2304));
        assert_eq!(input.geolocation_longitude, Some(121.4737));
    }
}
