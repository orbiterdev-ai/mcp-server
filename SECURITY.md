# Security Policy

## Supported Versions

Security updates are provided for the latest release line of `@orbiterdev/mcp-server`:

| Version | Supported |
|---------|-----------|
| `0.1.x` | Yes |
| `< 0.1.13` | No |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Report suspected security issues privately by emailing **[support@orbiterdev.ai](mailto:support@orbiterdev.ai)** with the subject line `[SECURITY] mcp-server: <short summary>`.

Include as much of the following as possible:

- Affected version, AI agent host (Claude Code, Codex, Antigravity, Gemini CLI, Cursor, Windsurf, or MCP client), and OS
- Reproduction steps or minimal sanitized payload
- Potential impact and any suggested remediation

## Response SLA

- **Initial acknowledgment:** within 24 business hours
- **Triage and severity confirmation:** within 72 hours
- **Target remediation timelines:**
  - Critical severity: within 7 days
  - High severity: within 14 days
  - Moderate severity: within 30 days
- **Coordinated disclosure:** we coordinate public advisories and credit researchers once a fix is released (unless anonymity is requested).

## Security Architecture & Trust Boundary

`@orbiterdev/mcp-server` separates AI agent execution from human authorization:

- **Out-of-band biometric boundary:** high-risk actions require explicit sign-off on the user's mobile device (iOS Face ID or Android biometrics) via the Orbiter Dev mobile app over TLS, outside the LLM context window.
- **Deterministic lifecycle hooks:** native hooks (`PreToolUse`, `BeforeTool`, `PermissionRequest`) enforce fail-closed blocking policies on supported hosts regardless of model prompt injection.
- **Client-side secret redaction:** bearer tokens, API keys, PEM private keys, and sensitive credential paths are redacted locally before tool input summaries are transmitted to `https://api.orbiterdev.ai`.
- **Short-lived pairing & minimal tool exposure:** workspace pairing uses 5-minute single-use pairing codes instead of static plaintext tokens, and only 5 core approval/safety MCP tools are exposed by default.

## Scope Exclusions

- Attacks requiring prior local code execution or write access to `~/.orbiter/` by the same OS user
- Prompt-injection behaviors in third-party LLM hosts where deterministic native lifecycle hooks are not enabled
