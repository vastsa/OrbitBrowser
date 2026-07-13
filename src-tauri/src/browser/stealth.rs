//! Chrome CDP 自动化痕迹收敛。
//!
//! 目标不是伪造完整浏览器画像，而是在保留 Chrome 原生 UA / 平台特征的前提下，
//! 去掉常见 automation / CDP 探测点。

use serde_json::{json, Value};

/// 在每个新文档创建前注入的隐匿脚本。
///
/// 保持幂等，且不写入可被站点枚举的 Orbit 标记字段。
pub fn init_script() -> &'static str {
    r#"(() => {
  try {
    const navigatorProto = Navigator.prototype;
    if (navigatorProto) {
      Object.defineProperty(navigatorProto, "webdriver", {
        configurable: true,
        enumerable: true,
        get: () => undefined,
        set: () => undefined,
      });
    }
  } catch {}

  try {
    const suspicious =
      /^(cdc_|\$cdc_|\$chrome_asyncScriptInfo|__puppeteer|__playwright|__webdriver|__selenium|domAutomation|domAutomationController)/i;
    for (const key of Reflect.ownKeys(globalThis)) {
      if (typeof key === "string" && suspicious.test(key)) {
        try {
          delete globalThis[key];
        } catch {}
      }
    }
  } catch {}

  try {
    const chromeObject = globalThis.chrome;
    if (chromeObject && typeof chromeObject === "object") {
      if (!("runtime" in chromeObject)) {
        Object.defineProperty(chromeObject, "runtime", {
          configurable: true,
          enumerable: true,
          value: {},
          writable: true,
        });
      }
    }
  } catch {}

  try {
    const permissions = globalThis.Permissions && globalThis.Permissions.prototype;
    const originalQuery = permissions && permissions.query;
    if (typeof originalQuery === "function") {
      permissions.query = function query(permissionDesc) {
        const name =
          permissionDesc && typeof permissionDesc === "object"
            ? permissionDesc.name
            : undefined;
        if (name === "notifications") {
          const state =
            globalThis.Notification && typeof Notification.permission === "string"
              ? Notification.permission
              : "default";
          return Promise.resolve({ state, onchange: null });
        }
        return originalQuery.call(this, permissionDesc);
      };
    }
  } catch {}
})();"#
}

pub fn add_script_params() -> Value {
    json!({ "source": init_script() })
}

pub fn evaluate_params() -> Value {
    json!({
        "expression": init_script(),
        "returnByValue": true,
        "awaitPromise": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stealth_script_covers_common_automation_probes() {
        let script = init_script();
        assert!(script.contains("webdriver"));
        assert!(script.contains("cdc_"));
        assert!(script.contains("runtime"));
        assert!(script.contains("notifications"));
        assert!(!script.contains("__orbitStealthInstalled"));
        assert!(!script.contains("__orbitLocaleMaskInstalled"));
        assert!(!script.contains("__orbitPatched"));
    }

    #[test]
    fn stealth_cdp_payloads_embed_script_source() {
        assert_eq!(
            add_script_params().get("source").and_then(Value::as_str),
            Some(init_script())
        );
        assert_eq!(
            evaluate_params()
                .get("expression")
                .and_then(Value::as_str),
            Some(init_script())
        );
    }
}
