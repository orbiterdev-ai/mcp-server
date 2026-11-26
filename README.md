# Orbiter Dev MCP Server & Hooks CLI

> **One-tap human sign-off when AI agents take real-world action - built for engineers and business teams alike.**

**Mobile apps:** iOS live on App Store and Android Early Access on Google Play (with Face ID & Android biometrics).  
**Plans:** Free `€0` (50 approvals/week) · Pro `€19.99/mo` (`€219.99/yr` annual). Requires the free Orbiter Dev mobile app.

> **Distribution status:** Hosted Remote MCP (`https://mcp.orbiterdev.ai/mcp`) is live for zero-install OAuth 2.1 connections. For local native lifecycle hooks and local stdio MCP, build from this GitHub repository using the verified source commands below. Publication of `@orbiterdev/mcp-server@0.1.14` to npmjs.org is queued pending npm registry publishing.

## Enforce vs. Request: Two Complementary Surfaces

Native lifecycle hooks enforce approval automatically before an action runs in supported local agents, while Orbiter's MCP connector lets cloud and business workflows request the same one-tap iOS & Android biometric sign-off where hooks are unavailable.

| Surface | Best For | Enforcement Model | Entry Point |
|---|---|---|---|
| **Hosted Remote MCP (Recommended)** | Claude.ai, n8n, LangGraph, CrewAI, business teams | OAuth 2.1 Streamable HTTP (zero local install) | `https://mcp.orbiterdev.ai/mcp` |
| **Native Lifecycle Hooks CLI (Source Build)** | Claude Code, Codex, Antigravity, Gemini CLI | Deterministic, fail-closed (`PreToolUse`, `BeforeTool`, `PermissionRequest`) | `node /path/to/mcp-server/dist/index.js <provider> setup` |
| **Local Stdio MCP Server (Source Build)** | Cursor, Windsurf, and any stdio MCP client | Model-facing approval, pairing, and alert tools | `node /path/to/mcp-server/dist/index.js` |

## Quickstart

### Option A: Hosted Remote MCP (Recommended - Zero Local Install)

Connect directly to `https://mcp.orbiterdev.ai/mcp` using Streamable HTTP + OAuth 2.1 (PKCE). No local Node.js runtime or static tokens required.

See the live provider setup guide at [https://orbiterdev.ai/setup](https://orbiterdev.ai/setup).

### Option B: Verified Source Build from GitHub (Hooks CLI & Local Stdio MCP)

**Prerequisites:** Node.js 18+, Git, and the Orbiter Dev mobile app (iOS or Android).

```bash
git clone https://github.com/orbiterdev-ai/mcp-server.git
cd mcp-server
npm ci
npm run build
```

After building, the CLI and stdio MCP entry point is `dist/index.js` (referred to below as `/path/to/mcp-server/dist/index.js`).

## Supported Local Hook Providers

Run these commands from your built `mcp-server` checkout (or replace `dist/index.js` with `/path/to/mcp-server/dist/index.js`):

| Provider | Hook Gate | Setup Command | Verify Command |
|---|---|---|---|
| **Codex** | `PermissionRequest`, `PreToolUse` | `node dist/index.js codex setup --adapter http --server-url https://api.orbiterdev.ai --hook-profile full` | `node dist/index.js codex doctor --check-backend` |
| **Antigravity** | `PreToolUse` (fail-closed) | `node dist/index.js antigravity setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile blocking --fallback deny --approval-timeout 300 --configure-native-command-policy` | `node dist/index.js antigravity doctor --workspace <workspace> --check-backend` |
| **Claude Code** | `PermissionRequest` | `node dist/index.js claude setup --scope project --server-url https://api.orbiterdev.ai` | `node dist/index.js claude doctor --scope project --check-backend` |
| **Gemini CLI** | `BeforeTool` | `node dist/index.js gemini setup --adapter http --server-url https://api.orbiterdev.ai --profile guarded` | `node dist/index.js gemini doctor --check-backend` |

## Local Stdio MCP Configuration

After building from source (`npm ci && npm run build`), point your MCP client to the compiled `dist/index.js`:

**Claude Code** (`.mcp.json` in your project root, or `~/.claude.json`):
```json
{
  "mcpServers": {
    "orbiter-dev": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
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
  "mcpServers": {
    "orbiter-dev": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "ORBITER_API_URL": "https://api.orbiterdev.ai"
      }
    }
  }
}
```

## How It Works

1. **Agent Action Triggered** - Your AI agent attempts a risky or external action (deploy, delete, database change, external send).
2. **Gate & Redact** - Native hooks intercept before execution (or the agent calls `request_approval` over MCP), redacting credential patterns before sending a concise summary to your phone.
3. **Biometric Sign-Off** - You review the risk level on the Orbiter Dev mobile app (iOS or Android) and approve or deny with Face ID or Android biometrics.
4. **Authoritative Verdict** - The client waits for the server's recorded terminal decision for the tracked approval ID and continues or halts immediately. Every outcome is recorded in your audit trail.

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
node dist/index.js --legacy-tools
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
node dist/index.js notify --event "Test Suite" --message "Tests passed successfully"
```

### Permission Check (Hook Mode)

Route Claude Code permission checks through Orbiter for mobile approval:

```bash
node dist/index.js permission-check --command "npm publish" --risk high
```

### Codex Hooks

Codex uses workspace-scoped hook trust. After running `codex setup`, trust and enable each workspace under **Settings -> Hooks**.

```bash
node dist/index.js codex setup --adapter http --server-url https://api.orbiterdev.ai --hook-profile full
node dist/index.js codex doctor --check-backend
```

### Antigravity Hooks

Antigravity installs a workspace-scoped `.agents/hooks.json` entry that routes `PreToolUse` events through Orbiter before risky tools run. The default setup is fail-closed: approved actions return `allow`, rejected or timed-out actions return `deny` unless `--fallback force_ask` is explicitly configured.

```bash
node dist/index.js antigravity setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile blocking --fallback deny --approval-timeout 300 --configure-native-command-policy
node dist/index.js antigravity doctor --workspace <workspace> --check-backend
```

### Gemini CLI Hooks

Gemini CLI writes workspace-scoped `.gemini/settings.json` entries for `BeforeTool`, `AfterTool`, `Notification`, and `SessionStart`:

```bash
node dist/index.js gemini setup --workspace <workspace> --adapter http --server-url https://api.orbiterdev.ai --profile guarded
node dist/index.js gemini doctor --check-backend
```

### Offline Hook Capture

Test hook payloads locally without contacting the backend:

```bash
node dist/index.js codex setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
node dist/index.js antigravity setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
node dist/index.js gemini setup --offline-capture --capture-dir .tmp_hook_captures --adapter mock --mock-decision approved
```

### Troubleshooting Missing Mobile Approvals

1. Confirm `doctor` reports `backendMode: live-http` (not `offline-capture` or `mock`).
2. Confirm the hook points to `https://api.orbiterdev.ai`.
3. Run `node dist/index.js <provider> doctor --check-backend`.
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
- Server-recorded terminal approval verdicts are strictly authoritative (local rules cannot self-approve a pending request, and repository configs cannot loosen user policy without explicit user opt-in)
- Strict tool-name allowlist for internal Orbiter loop prevention (caller-controlled tool arguments and descriptions are never consulted)
- Biometric confirmation (Face ID & Android biometrics) for high-risk approvals
- Automatic secret redaction and input hashing before hook payloads leave your machine
- Short-lived pairing codes (5-minute expiry) and rotating JWT sessions

---

[Website](https://orbiterdev.ai) · [Documentation](https://orbiterdev.ai/docs) · [Setup](https://orbiterdev.ai/setup) · [Privacy](https://orbiterdev.ai/legal/privacy) · [Terms](https://orbiterdev.ai/legal/terms) · [Support](mailto:support@orbiterdev.ai)

Copyright (c) 2026 Orbiter Dev. MIT License.
