# Remote sessions: setup

Shows every Claude Code session in the office: this PC, your other computers, and cloud sessions (claude.ai/code).
This PC runs the board and a small relay. Only the relay is reachable from the internet, through Tailscale Funnel.
Other machines send their hook events to it over HTTPS, each with its own key. Design: [docs/remote/DESIGN.md](../docs/remote/DESIGN.md).

```
this PC         Claude Code ── local hook ───────────────────► board 127.0.0.1:3100 (private)
                                                                   ▲
other computer ── curl + key ──┐                                   │ loopback + board token
                               ├─► Tailscale Funnel ──► relay 127.0.0.1:3199
cloud session ─── curl ────────┘   https://<host>/ingest
                  (key added by a network secret)
```

Run the commands on this PC from the root of the pixel-agents checkout. You need Node.js 20 or later.
Below, `<host>` is your Funnel name, `<machine>.<tailnet>.ts.net` (step 2 shows it).

## 1. This PC (board + relay + autostart)

1. Build the board:

   ```powershell
   npm ci
   npm run build
   ```

2. Start it once by hand:

   ```powershell
   node dist/cli.js --port 3100 --no-terminal
   ```

3. Open the printed URL that ends in `?token=...`. Treat it as a secret. In **Settings** turn on:
   - **Instant Detection (Hooks)**: installs the local hook into `~/.claude/settings.json` (asks for consent).
   - **Watch All Sessions**: shows every local project, not only this one.
   - **Always Show Labels**: keeps the ☁/💻 origin line visible on a wall display.

   The settings are saved. Stop the board with **Ctrl+C**.

4. Create one source per sender. Each command prints its key **once**. Copy it now.

   ```powershell
   node remote/relay/relay.mjs add-source laptop --kind computer --label "Laptop"
   node remote/relay/relay.mjs add-source cloud --kind cloud --label "Cloud"
   node remote/relay/relay.mjs list
   ```

   Only a SHA-256 hash of each key is stored, in `~/.pixel-agents/relay.json`.
   `node remote/relay/relay.mjs remove-source <id>` revokes a source immediately. The running relay picks up changes without a restart.
   Lost a key? Run `add-source` again with the same id. It gets a new key and the old one stops working.

5. Start the board and the relay at every logon:

   ```powershell
   powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Install
   powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Status
   ```

   `-Install` registers two logon Scheduled Tasks (board on :3100, relay on 127.0.0.1:3199). They run hidden and restart on failure.
   Logs go to `~/.pixel-agents/logs/`. `-Uninstall` removes both tasks.
   To run the relay by hand instead: `node remote/relay/relay.mjs serve`.

6. On the second monitor, open `http://127.0.0.1:3100` (no token) and press **F11**.
   A tab without the token is read-only, which is what a wall display wants.

## 2. Public address (Tailscale Funnel)

1. Install Tailscale on this PC and sign in:

   ```powershell
   winget install Tailscale.Tailscale
   ```

2. In the Tailscale admin console, enable **HTTPS certificates** and allow **Funnel** for this machine.
   If Funnel isn't allowed yet, the next command prints a link to fix it.

3. Publish only the relay's path:

   ```powershell
   tailscale funnel --bg --set-path /ingest http://127.0.0.1:3199
   tailscale funnel status
   ```

   `status` shows the public URL: `https://<machine>.<tailnet>.ts.net/ingest`.
   Only `/ingest` is public. The board on :3100 is never exposed.
   The relay accepts both `/ingest` and `/`, so it works whether or not Funnel strips the mount path.

4. Check from any network:

   ```bash
   curl -i -X POST https://<host>/ingest
   ```

   Expect `401` (no key). That means Funnel reaches the relay.

## 3. Another computer

Works from any network. Needs `bash` and `curl`: macOS, Linux, or Windows with Git Bash
(Claude Code runs hooks in bash when Git Bash is installed). Use one source per computer.

1. On that computer, save its source key (`laptop` above):

   ```bash
   mkdir -p ~/.pixel-agents
   cat > ~/.pixel-agents/ingest-key       # paste the key, press Enter, then Ctrl+D
   chmod 600 ~/.pixel-agents/ingest-key   # macOS/Linux
   ```

2. On **this PC**, print the hooks block:

   ```powershell
   node remote/relay/relay.mjs sender-config --url https://<host>/ingest
   ```

3. Merge the printed `{"hooks": {...}}` block into `~/.claude/settings.json` on the other computer.
   Merge per event: add to existing hook lists, don't replace them.
   Easiest: paste the block into a Claude Code session on that machine and ask it to merge it into `~/.claude/settings.json`.

4. Check the key. The empty body is rejected on purpose, so no test character appears:

   ```bash
   curl -i -X POST -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)" -d '{}' https://<host>/ingest
   ```

   Expect `400`. `401` means the key is wrong.

5. Start a new Claude Code session there. A 💻 character appears on the board.

Every hook is `async: true` and uses `curl -m 5`, so sessions never wait, even when this PC is off.

## 4. Cloud sessions

Covers claude.ai/code sessions, including ones started from the phone or the desktop app.
Cloud sessions read only the repo's committed `.claude/settings.json`, not user settings, so this is per repo.

1. On this PC, print the cloud hooks block:

   ```powershell
   node remote/relay/relay.mjs sender-config --url https://<host>/ingest --cloud
   ```

2. For each repo you use in the cloud: merge the block into that repo's `.claude/settings.json`
   (per event, as above), then commit and push it.
   These hooks exit at once unless `CLAUDE_CODE_REMOTE=true`, so they are a no-op on local machines. They carry no key.

3. In claude.ai/code, open the environment's settings → **Network secrets** → **Add secret**:
   - Type: **Bearer**
   - Allowed website: `<machine>.<tailnet>.ts.net`
   - Header: `Authorization`, prefix: `Bearer`
   - Value: the `cloud` source key

   The agent proxy attaches the key outside the VM, so the key never enters the session.
   A host listed on a network secret is reachable even at the default **Trusted** network level.
   On a Team plan without the admin role the form is shorter: one Host and a Token.

4. Start a cloud session in that repo. A ☁ character appears.

## What you'll see

- Remote sessions appear within about 2 s of activity, labeled like `☁ Cloud · repo` or `💻 Laptop · repo`.
- Tool activity, the permission bubble, Done/Waiting, and Subtask mini-characters work.
- No context gauge and no team detection. Both need the transcript, which stays on the other machine.
- A remote session with no events for 3 h is removed. A sleeping laptop or a stopped cloud VM never sends SessionEnd.
- Async hooks can arrive out of order. Worst case, a tool row lingers until the turn ends.
- The board updates only while this PC is on. Senders fail silently when it's off.
- claude.ai chats don't appear. They have no hooks.

## Security

- Only `POST /ingest` is public. The board and its own token never leave this PC.
- Each source has its own key. A key can only post events. `remove-source <id>` revokes it at once.
- Session ids are prefixed with the source id, so a remote key can't touch local sessions.
- The relay drops tool output and transcript paths and truncates tool inputs.
- Events still contain file paths and commands (truncated). They travel over HTTPS to your own PC.
- Keep the `?token=` URL private. Whoever holds it can install hooks on this PC.

## Troubleshooting

- Check the tasks: `powershell -ExecutionPolicy Bypass -File remote\windows\autostart.ps1 -Status`. Logs are in `~/.pixel-agents/logs/`.
- `curl` gets `401`: the key is wrong or missing.
- `curl` gets `404`: wrong path, or not a `POST`.
- The relay answers `204` but nothing shows: the board isn't running. Check `-Status` and the logs.
  Watch All Sessions is irrelevant here; remote sessions don't need it.
- A cloud session shows nothing: check the network secret's host matches `<host>` exactly, and that the hooks are
  committed in `.claude/settings.json` on the branch the session starts from.
- `sender-config` rejects the URL: it must be a plain `https://` URL with no quotes or spaces.
- Lost or leaked key: run `add-source <id>` again with the same id and update that sender.
