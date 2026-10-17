# Remote sessions: design

Status: approved 2026-10-17 · Branch: `remote-ingest`

## Goal

Every Claude Code session on the account appears in the office — this PC, other
computers, and cloud sessions (claude.ai/code) — with a badge saying where it runs.
The board runs 24x7 on a second monitor.

Success:

- A remote session shows up within ~2 s of its first activity, with a 💻/☁ badge.
- Remote characters show tool activity, the permission bubble, Done/Waiting, and
  Subtask sub-characters; they come back by themselves after a server restart.
- Only a single `POST /ingest` route is reachable from the internet. A leaked remote
  key can post events and nothing else.

Out of scope: claude.ai chats (no hooks), the stage track and done-today shelf (later).

## Shape

```
local sessions ─ claude-hook.js (127.0.0.1) ───────────────────────────────┐
                                                                            ▼
other computer ─ async curl + source key ─┐                        Pixel Agents server
                                          ├─ Tailscale Funnel ─ relay ─► 127.0.0.1:3100 (private)
cloud sessions ─ async curl ──────────────┘   https://<pc>.ts.net/ingest
                 (key added by a cloud network secret)
```

### Relay (`remote/relay/`)

Zero-dependency Node, bound to 127.0.0.1. The only process Funnel exposes.

- `POST /ingest` (also `/` in case Funnel strips the mount path). `Authorization: Bearer <key>`
  picks the source. Keys are stored as SHA-256 hashes in `~/.pixel-agents/relay.json`.
- Body ≤ 2 MB, must have string `session_id` and `hook_event_name`.
- Rewrites before forwarding:
  - drops `tool_response` and `transcript_path` (the transcript lives on another machine)
  - truncates long strings inside `tool_input`
  - prefixes `session_id` with `<sourceId>:` so a remote key can never address a local session
  - adds `pixel_source: { id, label, kind }` (`kind` is `computer` or `cloud`)
- Replies `204` before forwarding, so a sender never waits on the board.
- Forwards to the live Pixel Agents server found in `~/.pixel-agents/servers/*.json`
  (`POST /api/hooks/claude`, server's own bearer token). The server token never
  leaves this PC.
- CLI: `serve`, `add-source <id> --label <l> --kind computer|cloud` (prints the key once),
  `remove-source <id>`, `list`.

### Fork changes (server + webview)

`pixel_source` is trusted only because it arrives on the token-authenticated loopback
route, which only local processes can call.

1. **Adoption** (`hookEventHandler.ts`, `agentRuntime.ts`): a remote session is adopted
   as a hooks-only agent (no transcript) regardless of Watch All Sessions. Any event
   for an unknown remote session adopts it, so remote characters return after a
   restart. SessionStart still waits for a confirming event, as it does locally.
2. **Tool ids** (`hookEventHandler.ts`): for hooks-only agents, the hook's
   `tool_use_id` is the tool id for start and done. This lets parallel tools finish
   correctly and lets Task/Agent tools create a Subtask sub-character that is cleared
   on the matching PostToolUse.
3. **Badge** (`asyncapi.yaml` → `agentCreated` / `existingAgents` gain `sourceLabel`
   and `sourceKind`; `ToolOverlay.tsx`): the overlay shows `☁ Cloud` / `💻 Laptop`.
   `directoryName` stays the repo name, so seating is unchanged.
4. **Expiry** (`agentRuntime.ts`): a remote agent with no event for 3 h is removed, because
   a sleeping laptop or killed cloud VM never sends SessionEnd.

### Senders (`remote/senders/`)

The hooks list is the same 12 events Pixel Agents installs locally. Every entry is
`"async": true` and uses `curl -m 5`, so a session never blocks, even when this PC is off.

- **Other computer**: user-level `~/.claude/settings.json`. Key read from
  `~/.pixel-agents/ingest-key`.
- **Cloud**: committed `.claude/settings.json` in each repo. Runs only when
  `CLAUDE_CODE_REMOTE=true`, so it is a no-op on local machines. It carries no key:
  the cloud environment's **network secret** (Bearer, host `<pc>.ts.net`) adds it, and
  that also lets the session reach the host without changing the network access level.

## Known limits

- Async hooks can arrive out of order. The worst case is a tool row that stays until
  the turn ends.
- Remote sessions have no context gauge and no team/teammate detection (both need the
  transcript).
- The board only updates while this PC is on. Senders fail silently when it's off.

## Tasks

- [ ] Relay: tests, implementation, CLI
- [ ] Fork 1: remote adoption + auto-adopt (tests)
- [ ] Fork 2: tool_use_id tool tracking + Subtask for hooks-only (tests)
- [ ] Fork 3: sourceLabel/sourceKind protocol + overlay badge
- [ ] Fork 4: remote expiry (tests)
- [ ] Sender templates + install scripts
- [ ] Full check suite green (`check-types`, `lint`, tests)
- [ ] Run on this PC: build, start on :3100, relay on :3199, auto-start at login
- [ ] Tailscale Funnel (needs user sign-in), end-to-end test with a fake remote event
- [ ] Other computer + cloud environment setup (needs user)
