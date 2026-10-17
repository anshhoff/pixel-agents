#!/usr/bin/env node
// Pixel Agents remote relay: the only process exposed to the internet (via
// Tailscale Funnel). It accepts Claude Code hook events from other computers and
// cloud sessions, authenticates them per source, strips them down, and forwards
// them to the Pixel Agents server on this machine over loopback. The server's own
// token never leaves this machine. See docs/remote/DESIGN.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PORT = 3199;
const MAX_INPUT_STRING = 300;
const MAX_INPUT_DEPTH = 4;
const FORWARD_TIMEOUT_MS = 2_000;
const MAX_QUEUED_FORWARDS = 500;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SOURCE_KINDS = new Set(['computer', 'cloud']);
const INGEST_PATHS = new Set(['/', '/ingest']);
// Fields that point at files on the sender's machine or carry bulky tool output.
const DROPPED_FIELDS = ['transcript_path', 'agent_transcript_path', 'tool_response'];

// ── Config ──────────────────────────────────────────────────────────────────

function configPath(home) {
  return path.join(home, '.pixel-agents', 'relay.json');
}

export function loadConfig(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf-8'));
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return {
      port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
      sources: sources.filter(
        (s) =>
          s &&
          SOURCE_ID.test(s.id) &&
          SOURCE_KINDS.has(s.kind) &&
          typeof s.label === 'string' &&
          /^[0-9a-f]{64}$/.test(s.keyHash),
      ),
    };
  } catch {
    return { port: DEFAULT_PORT, sources: [] };
  }
}

function saveConfig(home, config) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Create or replace a source. Returns its new key; only the hash is stored. */
export function addSource(home, { id, label = id, kind }) {
  if (!SOURCE_ID.test(id ?? '')) throw new Error(`invalid source id "${id}" (a-z, 0-9, -)`);
  if (!SOURCE_KINDS.has(kind)) throw new Error(`invalid kind "${kind}" (computer or cloud)`);
  if (typeof label !== 'string' || !label.trim() || label.length > 40) {
    throw new Error('label must be 1-40 characters');
  }
  const key = `pxr_${crypto.randomBytes(32).toString('base64url')}`;
  const config = loadConfig(home);
  const sources = config.sources.filter((s) => s.id !== id);
  sources.push({ id, label: label.trim(), kind, keyHash: hashKey(key) });
  saveConfig(home, { ...config, sources });
  return key;
}

export function removeSource(home, id) {
  const config = loadConfig(home);
  const sources = config.sources.filter((s) => s.id !== id);
  if (sources.length === config.sources.length) return false;
  saveConfig(home, { ...config, sources });
  return true;
}

/** The source a key belongs to, or null. Compares hashes in constant time. */
export function findSource(config, key) {
  if (typeof key !== 'string' || !key.startsWith('pxr_')) return null;
  const candidate = Buffer.from(hashKey(key), 'hex');
  let match = null;
  for (const s of config.sources) {
    if (crypto.timingSafeEqual(candidate, Buffer.from(s.keyHash, 'hex'))) match = s;
  }
  return match ? { id: match.id, label: match.label, kind: match.kind } : null;
}

// ── Events ──────────────────────────────────────────────────────────────────

function truncateStrings(value, depth) {
  if (typeof value === 'string') {
    return value.length > MAX_INPUT_STRING ? value.slice(0, MAX_INPUT_STRING) + '…' : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => truncateStrings(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, truncateStrings(v, depth + 1)]),
  );
}

/**
 * Turn a raw hook payload from a remote source into what the board receives, or
 * null when it isn't a hook event. The session id is namespaced by source so a
 * remote key can never address a session on this machine.
 */
export function transformEvent(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.session_id !== 'string' || !raw.session_id) return null;
  if (typeof raw.hook_event_name !== 'string' || !raw.hook_event_name) return null;
  const event = { ...raw };
  for (const field of DROPPED_FIELDS) delete event[field];
  if (event.tool_input !== undefined) event.tool_input = truncateStrings(event.tool_input, 0);
  event.session_id = `${source.id}:${raw.session_id}`;
  event.pixel_source = { id: source.id, label: source.label, kind: source.kind };
  return event;
}

// ── Forwarding ──────────────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Live Pixel Agents servers from ~/.pixel-agents/servers/*.json. */
export function discoverServers(home = os.homedir()) {
  const dir = path.join(home, '.pixel-agents', 'servers');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const servers = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (!Number.isInteger(entry.port) || !Number.isInteger(entry.pid)) continue;
      if (typeof entry.token !== 'string' || !entry.token) continue;
      if (isProcessAlive(entry.pid)) servers.push({ port: entry.port, token: entry.token });
    } catch {
      // malformed entry: skip
    }
  }
  return servers;
}

function postToServer(event, { port, token }) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/hooks/claude',
        timeout: FORWARD_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve());
    req.end(body);
  });
}

/** Deliver one event to every server. Never rejects. */
export async function forwardEvent(event, servers) {
  await Promise.all(servers.map((s) => postToServer(event, s)));
}

/** Serialize forwards so the board sees events in arrival order. */
function createForwardQueue(send) {
  let tail = Promise.resolve();
  let queued = 0;
  return (event) => {
    if (queued >= MAX_QUEUED_FORWARDS) return;
    queued++;
    tail = tail.then(() => send(event)).finally(() => queued--);
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function bearer(req) {
  const match = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : undefined;
}

/** HTTP server with a single route: POST /ingest. */
export function createRelayServer({ getConfig, forward, maxBodyBytes = MAX_BODY_BYTES }) {
  const server = http.createServer((req, res) => {
    const reply = (status) => {
      if (!res.headersSent) res.writeHead(status).end();
    };
    const pathname = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || !INGEST_PATHS.has(pathname)) {
      req.resume();
      return reply(404);
    }
    const source = findSource(getConfig(), bearer(req));
    if (!source) {
      req.resume();
      return reply(401);
    }

    const chunks = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length']) > maxBodyBytes;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('error', () => reply(400));
    req.on('end', () => {
      if (tooLarge) return reply(413);
      let raw;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return reply(400);
      }
      const event = transformEvent(raw, source);
      if (!event) return reply(400);
      reply(204);
      try {
        Promise.resolve(forward(event)).catch(() => {});
      } catch {
        // the board being down is not the sender's problem
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

// ── Senders ─────────────────────────────────────────────────────────────────

/** The events Pixel Agents installs locally (server/src/providers/hook/claude/constants.ts). */
export const SENDER_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
];

/**
 * The settings.json `hooks` block that sends a machine's events to the relay.
 * Every hook is async, so a session never waits on the network.
 * - computer: user-level settings; the key is read from ~/.pixel-agents/ingest-key.
 * - cloud: committed to a repo's .claude/settings.json; exits at once unless
 *   CLAUDE_CODE_REMOTE=true, and carries no key -- the cloud environment's
 *   network secret adds the Authorization header on the way out.
 */
export function senderHooks({ url, cloud }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'https:' || /['"\s\\`$]/.test(url)) {
    throw new Error('the ingest URL must be a plain https:// URL');
  }
  const auth = cloud ? '' : ` -H "Authorization: Bearer $(cat ~/.pixel-agents/ingest-key)"`;
  const post =
    `curl -s -m 5 -X POST -H 'Content-Type: application/json'${auth}` +
    ` --data-binary @- '${url}' >/dev/null 2>&1`;
  const command = cloud
    ? `[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0; ${post}; exit 0`
    : `${post}; exit 0`;
  return Object.fromEntries(
    SENDER_EVENTS.map((event) => [
      event,
      [{ matcher: '', hooks: [{ type: 'command', command, async: true, timeout: 10 }] }],
    ]),
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** loadConfig, re-read only when relay.json changes, so revoking a key needs no restart. */
function watchedConfig(home) {
  let cached;
  let mtime = -1;
  return () => {
    let current = 0;
    try {
      current = fs.statSync(configPath(home)).mtimeMs;
    } catch {
      // missing file: no sources
    }
    if (current !== mtime) {
      cached = loadConfig(home);
      mtime = current;
    }
    return cached;
  };
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  const [command, ...args] = argv;
  const home = os.homedir();
  switch (command) {
    case 'serve': {
      const getConfig = watchedConfig(home);
      const port = Number(flag(args, 'port') ?? getConfig().port);
      const forward = createForwardQueue((event) => forwardEvent(event, discoverServers(home)));
      const server = createRelayServer({ getConfig, forward });
      server.listen(port, '127.0.0.1', () => {
        console.log(`[relay] listening on http://127.0.0.1:${port}/ingest`);
        console.log(
          `[relay] sources: ${
            getConfig()
              .sources.map((s) => s.id)
              .join(', ') || 'none'
          }`,
        );
      });
      return;
    }
    case 'add-source': {
      const [id] = args;
      const key = addSource(home, {
        id,
        label: flag(args, 'label') ?? id,
        kind: flag(args, 'kind'),
      });
      console.log(`Source "${id}" ready. Its key (shown once):\n\n${key}\n`);
      return;
    }
    case 'remove-source': {
      const removed = removeSource(home, args[0]);
      console.log(removed ? `Removed "${args[0]}".` : `No source "${args[0]}".`);
      process.exitCode = removed ? 0 : 1;
      return;
    }
    case 'list': {
      for (const s of loadConfig(home).sources) console.log(`${s.id}\t${s.kind}\t${s.label}`);
      return;
    }
    case 'sender-config': {
      const hooks = senderHooks({ url: flag(args, 'url'), cloud: args.includes('--cloud') });
      console.log(JSON.stringify({ hooks }, null, 2));
      return;
    }
    default:
      console.log(
        'Usage: relay.mjs serve [--port N]\n' +
          '       relay.mjs add-source <id> --kind computer|cloud [--label L]\n' +
          '       relay.mjs remove-source <id>\n' +
          '       relay.mjs list\n' +
          '       relay.mjs sender-config --url https://<host>/ingest [--cloud]',
      );
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[relay] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
