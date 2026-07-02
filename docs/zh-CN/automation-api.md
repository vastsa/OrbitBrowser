# 自动化 API

任务脚本运行在受控 JavaScript runtime 中。默认提供以下全局对象：

- `page`：页面控制 API。
- `log`：运行日志 API。
- `run`：产物输出 API。
- `env`：当前环境只读信息。
- `sleep`：等待指定毫秒数。
- `orbit`：命名空间形式，包含 `page`、`log`、`run`、`env`、`sleep`。

## 页面控制

```js
await page.goto("https://example.com", { waitUntil: "load", timeout: 30000 });
await page.click("button[type=submit]");
await page.type("#email", "demo@example.com");
await page.wait("h1", { timeout: 10000 });
const title = await page.title();
const url = await page.url();
await page.screenshot("home");
```

## 日志和产物

```js
log.info("开始采集页面标题");
const title = await page.title();
await run.outputJson("title", { title });
await run.outputText("summary", `title=${title}`);
```

## 环境信息

```js
log.info(`当前环境: ${env.name}`);
log.info(`语言: ${env.locale}`);
log.info(`代理类型: ${env.proxy.kind}`);
```

## 注意事项

- 任务应设置合理超时，避免长时间占用浏览器。
- 产物名称会被清洗为便携文件名。
- 不要在脚本中输出密码、Cookie、Token 或代理凭据。
