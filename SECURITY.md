# Security Policy

Language: English | [简体中文](SECURITY.zh-CN.md)

Orbit Browser is a local browser automation tool. Its security model focuses on
protecting local profiles, cookies, proxy credentials, and task artifacts.

## Supported Versions

The currently maintained public version line is `0.1.x`.

## Reporting A Security Issue

Do not disclose exploitable details in public issues. Contact the maintainers
through a private channel and include:

- Affected version or commit
- Reproduction steps
- Impact scope
- Suggested remediation

## Security Boundaries

- Task scripts run inside a controlled JavaScript runtime, but they can still drive a local browser.
- Proxy accounts, cookies, profiles, screenshots, and run artifacts should be treated as sensitive data.
- Do not put production accounts, production proxies, or real user data in examples, tests, or public logs.
