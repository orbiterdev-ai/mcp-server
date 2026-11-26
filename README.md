# Orbiter Dev MCP Server & Hooks CLI

> **One-tap human sign-off when AI agents take real-world action - built for engineers and business teams alike.**

[![npm version](https://img.shields.io/npm/v/@orbiterdev/mcp-server)](https://www.npmjs.com/package/@orbiterdev/mcp-server)

**Mobile apps:** iOS live on App Store and Android Early Access on Google Play (with Face ID & Android biometrics).  
**Plans:** Free `€0` (50 approvals/week) · Pro `€19.99/mo` (`€219.99/yr` annual). Requires the free Orbiter Dev mobile app.

## Enforce vs. Request: Two Complementary Surfaces

Native lifecycle hooks enforce approval automatically before an action runs in supported local agents, while Orbiter's MCP connector lets cloud and business workflows request the same one-tap iOS & Android biometric sign-off where hooks are unavailable.

| Surface | Best For | Enforcement Model | Entry Point |
|---|---|---|---|
| **Native Lifecycle Hooks CLI** | Claude Code, Codex, Antigravity, Gemini CLI | Deterministic, fail-closed (`PreToolUse`, `BeforeTool`, `PermissionRequest`) | `npx -y @orbiterdev/mcp-server@0.1.14 <provider> setup` |
| **Hosted Remote MCP** | Claude.ai, n8n, LangGraph, CrewAI, business teams | OAuth 2.1 Streamable HTTP (zero local install) | `https://mcp.orbiterdev.ai/mcp` |
| **Local Stdio MCP Server** | Cursor, Windsurf, and any stdio MCP client | Model-facing approval, pairing, and alert tools | `npx -y @orbiterdev/mcp-server@0.1.14` |

## Supported Local Hook Providers

Minimum npm package for the hook CLIs below: `@orbiterdev/mcp-server@0.1.14`.

| Provider | Hook Gate | Setup Command | Verify Command |
|---|---|---|---|
| **Codex** | `PermissionRequest`, `PreToolUse` | `npx -y @orbiterdev/mcp-server@0.1.14 codex setup --adapter http --server-url https://api.orbiterdev.ai --hook-profile full` | `npx -y @orbiterdev/mcp-server@0.1.14 codex doctor --check-backend` |
| **Antigravity** | `PreToolUse` (fail-closed) | `npx -y @orbiterdev/mcp-server@0.1.14 antigravity setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile blocking --fallback deny --approval-timeout 300 --configure-native-command-policy` | `npx -y @orbiterdev/mcp-server@0.1.14 antigravity doctor --workspace <workspace> --check-backend` |
| **Claude Code** | `PermissionRequest` | `npx -y @orbiterdev/mcp-server@0.1.14 claude setup --scope project --server-url https://api.orbiterdev.ai` | `npx -y @orbiterdev/mcp-server@0.1.14 claude doctor --scope project --check-backend` |
| **Gemini CLI** | `BeforeTool` | `npx -y @orbiterdev/mcp-server@0.1.14 gemini setup --adapter http --server-url https://api.orbiterdev.ai --profile guarded` | `npx -y @orbiterdev/mcp-server@0.1.14 gemini doctor --check-backend` |

## Installation

We recommend running via `npx` so your agents always use a pinned, hardened release.

**Prerequisites:** Node.js 18+ and the Orbiter Dev mobile app (iOS or Android).

## MCP Configuration

### Option A: Hosted Remote MCP (Recommended for Cloud & Business Workflows)

Connect directly to `https://mcp.orbiterdev.ai/mcp` using Streamable HTTP + OAuth 2.1 (PKCE). No local Node.js runtime or static tokens required.

### Option B: Local Stdio MCP Server

Add the following to your MCP configuration file:

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "orbiter-dev": {
      "command": "npx",
      "args": ["-y", "@orbiterdev/mcp-server@0.1.14"],
      "env": {
        "ORBITER_API_URL": "https://api.orbiterdev.ai"
      }
    }
  }
}
```

**Cursor / Windsurf** (MCP settings):
```json
{
  "orbiter-dev": {
    "command": "npx",
    "args": ["-y", "@orbiterdev/mcp-server@0.1.14"],
    "env": {
      "ORBITER_API_URL": "https://api.orbiterdev.ai"
    }
  }
}
```

## How It Works

1. **Agent Action Triggered** - Your AI agent attempts a risky or external action (deploy, delete, database change, external send).
2. **Gate & Redact** - Native hooks intercept before execution (or the agent calls `request_approval` over MCP), redacting credential patterns before sending a concise summary to your phone.
3. **Biometric Sign-Off** - You review the risk level on the Orbiter Dev mobile app (iOS or Android) and approve or deny with Face ID or Android biometrics.
4. **Resume with Receipt** - The agent continues or halts immediately based on your decision, and every outcome is recorded in your audit trail.

## Tools Exposed to Agents

By default, `@orbiterdev/mcp-server` exposes a minimal, annotated set of **5 core tools** to keep LLM context lean and focused on human sign-off:

### Core Approval, Pairing & Safety Tools (Enabled by Default)

| Tool | Description |
|------|-------------|
| `request_approval` | Pause execution, send an action summary and risk analysis to your phone (iOS & Android), and wait for explicit approval or denial |
| `orbiter_auth` | Pair your local workspace to the Orbiter Dev mobile app using a short-lived pairing code |
| `orbiter_auth_verify` | Verify that pairing confirmation was completed on your mobile device |
| `notify_user` | Send push notifications to your phone for completed runs, alerts, or questions |
| `kill_agent` | Immediately terminate a stuck or runaway agent session |

### Legacy Telemetry & Memory Tools (Opt-In Only)

Eight legacy telemetry and memory tools (`agent_heartbeat`, `checkpoint_post`, `context_health`, `report_tool_result`, `session_memory`, `report_usage`, `get_project_instincts`, `add_project_instinct`) are disabled by default to avoid schema bloat. To enable them for backward compatibility, pass `--legacy-tools` or set `ORBITER_ENABLE_LEGACY_TOOLS=1`:

```bash
npx -y @orbiterdev/mcp-server@0.1.14 --legacy-tools
```

## Device Pairing

Pair your local workspace to the Orbiter Dev mobile app (iOS & Android) using short-lived pairing codes instead of static plaintext tokens:

```text
Agent -> orbiter_auth -> Backend generates pairing code -> User confirms on phone -> Verified
```

## CLI Commands

### Push Notifications

Send background push updates when long-running agent tasks finish:

```bash
export ORBITER_TOKEN="your-app-token"
npx -y @orbiterdev/mcp-server@0.1.14 notify --event "Test Suite" --message "Tests passed successfully"
```

### Permission Check (Hook Mode)

Route Claude Code permission checks through Orbiter for mobile approval:

```bash
npx -y @orbiterdev/mcp-server@0.1.14 permission-check --command "npm publish" --risk high
```

### Codex Hooks

Codex uses workspace-scoped hook trust. After running `codex setup`, trust and enable each workspace under **Settings -> Hooks**.

```bash
npx -y @orbiterdev/mcp-server@0.1.14 codex setup --adapter http --server-url https://api.orbiterdev.ai --hook-profile full
npx -y @orbiterdev/mcp-server@0.1.14 codex doctor --check-backend
```

### Antigravity Hooks

Antigravity installs a workspace-scoped `.agents/hooks.json` entry that routes `PreToolUse` events through Orbiter before risky tools run. The default setup is fail-closed: approved actions return `allow`, rejected or timed-out actions return `deny` unless `--fallback force_ask` is explicitly configured.

```bash
npx -y @orbiterdev/mcp-server@0.1.14 antigravity setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile blocking --fallback deny --approval-timeout 300 --configure-native-command-policy
npx -y @orbiterdev/mcp-server@0.1.14 antigravity doctor --workspace <workspace> --check-backend
```

### Gemini CLI Hooks

Gemini CLI writes workspace-scoped `.gemini/settings.json` entries for `BeforeTool`, `AfterTool`, `Notification`, and `SessionStart`:

```bash
npx -y @orbiterdev/mcp-server@0.1.14 gemini setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile guarded
npx -y @orbiterdev/mcp-server@0.1.14 gemini doctor --workspace <workspace> --check-backend
```

### Offline Hook Capture

Test hook payloads locally without contacting the backend:

```bash
npx -y @orbiterdev/mcp-server@0.1.14 codex setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
npx -y @orbiterdev/mcp-server@0.1.14 antigravity setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
npx -y @orbiterdev/mcp-server@0.1.14 gemini setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
```

### Troubleshooting Missing Mobile Approvals

1. Confirm `doctor` reports `backendMode: live-http` (not `offline-capture` or `mock`).
2. Confirm the hook points to `https://api.orbiterdev.ai`.
3. Run `<provider> doctor --check-backend`.
4. Confirm the workspace credential profile is paired with the same account signed into the Orbiter Dev mobile app (iOS or Android).
5. Open the Orbiter Dev app and pull to refresh; pending approvals remain visible over REST even if push notifications are muted.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORBITER_API_URL` | `https://api.orbiterdev.ai` | Backend API URL |
| `ORBITER_SERVER_URL` | `https://api.orbiterdev.ai` | Legacy alias for `ORBITER_API_URL` |
| `ORBITER_TOKEN` | (none) | Auth token (auto-managed after pairing) |
| `ORBITER_MIN_RISK` | surface default | Minimum risk level (`low`, `medium`, `high`, `critical`) escalated to mobile |
| `ORBITER_ENABLE_LEGACY_TOOLS` | `0` | Set to `1` to expose the 8 legacy telemetry and memory MCP tools |
| `ORBITER_CREDENTIAL_PROFILE` | (none) | Optional per-client credential slot, for example `codex` or `gemini-cli` |
| `ORBITER_CREDENTIAL_PATH` | (none) | Optional explicit credential file path; overrides profile resolution |

## Security

- All API traffic encrypted via TLS
- Biometric confirmation (Face ID & Android biometrics) for high-risk approvals
- Automatic secret redaction and input hashing before hook payloads leave your machine
- Short-lived pairing codes (5-minute expiry) and rotating JWT sessions

---

[Website](https://orbiterdev.ai) · [Documentation](https://orbiterdev.ai/docs) · [Setup](https://orbiterdev.ai/setup) · [Privacy](https://orbiterdev.ai/legal/privacy) · [Terms](https://orbiterdev.ai/legal/terms) · [Support](mailto:support@orbiterdev.ai)

Copyright (c) 2026 Orbiter Dev. MIT License.
