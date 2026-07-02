# Automation API

Task scripts run inside a controlled JavaScript runtime. The following globals
are available by default:

- `page`: page-control API.
- `log`: run-log API.
- `run`: artifact output API.
- `env`: read-only current environment information.
- `sleep`: wait for a specified number of milliseconds.
- `orbit`: namespace containing `page`, `log`, `run`, `env`, and `sleep`.

## Page Control

```js
await page.goto("https://example.com", { waitUntil: "load", timeout: 30000 });
await page.click("button[type=submit]");
await page.type("#email", "demo@example.com");
await page.wait("h1", { timeout: 10000 });
const title = await page.title();
const url = await page.url();
await page.screenshot("home");
```

## Logs And Artifacts

```js
log.info("Capturing page title");
const title = await page.title();
await run.outputJson("title", { title });
await run.outputText("summary", `title=${title}`);
```

## Environment Info

```js
log.info(`Current environment: ${env.name}`);
log.info(`Locale: ${env.locale}`);
log.info(`Proxy kind: ${env.proxy.kind}`);
```

## Notes

- Set reasonable task timeouts to avoid holding a browser indefinitely.
- Artifact names are sanitized into portable file names.
- Do not output passwords, cookies, tokens, or proxy credentials from scripts.
