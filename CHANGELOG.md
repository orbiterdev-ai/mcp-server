# Changelog - `@orbiterdev/mcp-server`

All notable changes to the npm package. Dates are release-prep dates; actual
publish to npm is a separate, gated step.

## 0.1.14 - 2026-07-22

### Added - `ORBITER_MIN_RISK`: one approval threshold across every supported host
- **Problem.** Each surface implemented its own gate, so the same risk level meant
  different things: Codex/Gemini hardcoded `high`+`critical` only; Antigravity gated on
  *tool identity* (a low-risk `run_command` still routed); and **Claude Code had no risk
  gate at all** (matcher `*`, with `risk_level` attached as metadata only), so every
  permissioned call became a phone push.
- **Now.** A single `ORBITER_MIN_RISK` (`low`|`medium`|`high`|`critical`) is honored by the
  Claude `permission-check` hook, the Codex and Gemini hooks, and the Antigravity gate.
  Anything below the threshold is allowed **locally** and never reaches the backend or the
  phone.
- **Backward compatible by construction.** Each surface passes its own historical default,
  so an unset variable changes nothing: Claude `low` (escalate everything, as before),
  Codex/Gemini `high` (as before). Antigravity keeps its tool-identity rules and gains the
  threshold only as an additional floor (default `low`).
- **Fail-safe.** `critical` always escalates regardless of threshold, and an unparseable
  value falls back to the surface default rather than silently loosening the gate.
- Usage: set `ORBITER_MIN_RISK=high` to make Claude Code as quiet as Codex.
  See [https://orbiterdev.ai/docs](https://orbiterdev.ai/docs).

### Changed - hook determinism pass
- **Claude Code surfaces now use the shared policy ruleset.** The `permission-check` hook
  and the MCP permission relay previously carried two separate ad-hoc keyword classifiers,
  so the same command could get a different risk label on Claude than on Codex/Gemini
  (e.g. `git push` was *medium* on Claude, *high* everywhere else; the relay had no
  *critical* tier at all). Both now call a shared `computeToolRisk()` backed by the same
  `DEFAULT_RISK_RULESET` the Codex and Gemini hooks interpret, with the command extracted
  from tool input the same way Codex builds its action string.
  **Rollback:** `ORBITER_HOOK_POLICY=legacy` restores the previous Claude heuristic.
- **Risk is classified over the full redacted input, not the 1800-char display preview**
  (Codex + Gemini normalizers). Previously a risky token that serialized past the preview
  truncation point was invisible to the classifier, making risk depend on input size.
  The preview remains display-only.
- **Polling fallback timeout aligned with SSE (300s).** When SSE failed and the hook fell
  back to polling, the approval window silently shrank from 5 minutes to 2. Both
  transports now honor the same 5-minute contract.

### Removed
- Stale compiled artifacts (`sse.js`, `poll.js`, `auth.js` + `.d.ts`/`.js.map` strays)
  deleted from `src/utils/`. They were outdated copies (the stray `sse.js` still had the
  pre-timeout-parameter signature) and a silent-shadowing hazard next to their `.ts`
  sources; runtime code always came from `dist/`.

### Added
- `tests/policy-cross-surface.test.js`: proves the same command yields the same risk on
  the Claude, Codex, and Gemini surfaces; that classification is input-size independent;
  and that the legacy escape hatch still works.

### Changed - decision-semantics unification
- **Critical risk now routes to the phone by default** on Codex PreToolUse, Gemini
  BeforeTool, and Antigravity PreToolUse (previously: silent local auto-deny the phone
  never saw). `--critical deny` (hook and setup flag) restores the old local hard-deny.
  Antigravity's `observe` profile is now truly log-only - it no longer denies critical.
- **Uniform `--fallback` flag** (`deny` default = fail-closed; `allow` = configured
  fail-open) on the Codex and Gemini hooks + setups, alongside Antigravity's existing
  `deny|force_ask`. An explicit user rejection is never overridden by fallback, and an
  adapter FAILURE now reports as `timeout` (it used to masquerade as `rejected`).
- **Ruleset v2 convergence (Tier-1.5):** Claude, Codex, and Gemini now classify via one
  shared v2 rule table with per-host extract configs (`policy/genericRulesetV2.ts`) - the
  same engine Antigravity uses. `ORBITER_HOOK_POLICY=v1` selects the flat v1 ruleset;
  `legacy` the original hardcoded classifiers.
- **Decision options flow as explicit parameters** through
  `createCodexApprovalAdapter(name, options)`; hook handlers no longer mutate
  `process.env` (hidden global state).

### Fixed
- **Idempotency cache poisoning:** `timeout`/`pending` decisions are no longer cached, so
  one transient network failure can't permanently deny a repeated tool call without ever
  re-asking the phone. Poisoned caches heal on read.
- **Phantom "Session Ended" notifications (orbiter-bridge):** `SessionEnd` now parses the
  Claude Code `reason` field and pushes only for real exits (`logout`,
  `prompt_input_exit`); `clear`/`other` rollovers (e.g. starting a new chat) keep the
  silent heartbeat but never notify.
- **Claude surfaces now redact tool input before it leaves the machine** (matching the
  other surfaces): bearer tokens, API keys, PEM blocks, and credential paths are scrubbed
  from `diff_summary`/`tool_input_json` in both the permission-check hook and the MCP
  permission relay. Risk is still classified on the raw input.
- **Claude PermissionRequest allow output** no longer includes the deny-only `message`
  field (contract compliance).
- New `claude doctor` check `no_stray_hooks_in_settings_local` flags legacy Orbiter hooks
  in `.claude/settings.local.json` (they run in addition to the managed hook and cause
  double gating / phantom notifications).

## 0.1.13 - 2026-06-26

### Added
- **Claude Code adapter.** `npx @orbiterdev/mcp-server claude setup|doctor|uninstall`
  installs a `PermissionRequest` hook into `.claude/settings.json` that routes every
  tool-permission request to your phone, and registers the `orbiter-dev` MCP server.
  - Fail-open: if the Orbiter backend is unreachable the hook exits non-blocking and
    Claude shows its native permission prompt (you are never locked out).
  - Orbiter's own MCP tools are passed through (no phantom self-approval cards).
  - `--scope project|global|both`, `--server-url`, `--dry-run`, `--check-backend`.
- **Stable-edge hook runner.** The Claude hook command now points at a stable
  `.claude/orbiter-claude-hook.cjs` runner; the volatile npm package path lives only
  inside that runner (regenerated on every `setup`). An `npm update` no longer rewrites
  the trusted hook command, so Claude Code won't re-prompt you to review hooks after each
  upgrade. (Matches the runner pattern already used by the Antigravity and Gemini adapters.)

### Changed
- **Policy-as-data is now the default risk gate** for the Codex, Gemini, and Antigravity
  hooks. Risk is classified by a versioned, serializable ruleset instead of hardcoded
  per-IDE logic.
  - The ruleset is a proven **superset** of the previous classifiers - never less strict
    (it now also catches `format c:`, `*.key` / `*.sql` files, `git clean`, and more), and
    stricter on multi-signal commands. Safety is the fail-safe direction for a gate.
  - **Rollback:** set `ORBITER_HOOK_POLICY=legacy` (or `code`) to restore the previous
    hardcoded classifiers. The legacy classifiers are retained, not deleted.

### Fixed
- `permission-check` now flushes its JSON decision to stdout before exiting, preventing a
  truncated/empty decision under async (piped) stdout that could drop Claude through to the
  native prompt.

### Internal
- New Antigravity risk ruleset **v2** (tool-name / path / workspace-aware, structured
  `{level, reasons, flags}`) with level-parity against the legacy classifier proven across a
  test corpus. Codex/Gemini broadened-superset proven by `policy-superset.test.js`.
- npm test suite: 82 passing.
