import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVERS_DIR,
} from '../../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

// ── Payload size ──────────────────────────────────────────────────────────
//
// The server rejects a body over MAX_HOOK_BODY_SIZE (64 KB) with 413, and a
// rejected event is lost: a tool row that never finishes, a push or PR the
// progress tracker never sees. Claude Code's payloads routinely exceed that:
// PostToolUse carries the tool's whole output (a large Read, long Bash output)
// and PreToolUse its whole input (a Write's content, an Edit's strings). So the
// payload is cut down before it is posted, keeping what the server reads.

/** Body budget: the server's limit less headroom. */
const MAX_BODY_BYTES = MAX_HOOK_BODY_SIZE - 4 * 1024; // 60 KB
/** tool_response: the server only searches it for the PR url `gh pr create`
 *  prints, so a few KB of text is all it needs. */
const MAX_RESPONSE_CHARS = 4 * 1024;
/** Of MAX_RESPONSE_CHARS, how much comes from the END of the output, where a
 *  chained `… && gh pr create` prints its url. The rest is the start. */
const RESPONSE_TAIL_CHARS = 1024;
/** Any one string in tool_input (or, as a last resort, elsewhere). Keys like
 *  file_path, command, pattern and url stay whole unless longer than this. */
const MAX_INPUT_STRING_CHARS = 2 * 1024;
/** Nesting walked inside tool_input; a deeper value too big to keep whole
 *  becomes truncated JSON text. */
const MAX_INPUT_DEPTH = 8;
const MAX_INPUT_ARRAY_ITEMS = 100;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function cutMarker(chars: number): string {
  return `…[${chars} chars truncated]…`;
}

/** The first `cap` chars of `text` (never half a surrogate pair), and a marker. */
function clipHead(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const end = isHighSurrogate(text.charCodeAt(cap - 1)) ? cap - 1 : cap;
  return text.slice(0, end) + cutMarker(text.length - end);
}

/** The start and the last `tail` chars of `text`, `cap` chars in all, with a
 *  marker between them. */
function clipHeadAndTail(text: string, cap: number, tail: number): string {
  if (text.length <= cap) return text;
  let end = cap - tail;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  let start = text.length - tail;
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  return text.slice(0, end) + cutMarker(start - end) + text.slice(start);
}

/** tool_response unchanged when its text fits MAX_RESPONSE_CHARS, else that
 *  text (the string, or the value as JSON) cut to MAX_RESPONSE_CHARS. */
function shrinkResponse(response: unknown): unknown {
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  if (text === undefined || text.length <= MAX_RESPONSE_CHARS) return response;
  return clipHeadAndTail(text, MAX_RESPONSE_CHARS, RESPONSE_TAIL_CHARS);
}

/** A copy of `value` with every string over MAX_INPUT_STRING_CHARS cut down
 *  (head only: a command's tail without its start can parse as a different
 *  command), arrays capped at MAX_INPUT_ARRAY_ITEMS and nesting at
 *  MAX_INPUT_DEPTH. Values within those bounds are kept as they are. */
function shrinkValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clipHead(value, MAX_INPUT_STRING_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) {
    const text = JSON.stringify(value);
    return text.length <= MAX_INPUT_STRING_CHARS ? value : clipHead(text, MAX_INPUT_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_INPUT_ARRAY_ITEMS).map((item) => shrinkValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, shrinkValue(item, depth + 1)]),
  );
}

function fitsInBody(payload: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(payload)) <= MAX_BODY_BYTES;
}

/**
 * The hook payload to POST, cut down to fit the server's body limit while
 * keeping what the server reads. Pure: `data` is not modified.
 *  1. tool_response becomes at most MAX_RESPONSE_CHARS of text (its start and
 *     end), and each long string in tool_input is cut to its start. Every
 *     other field is untouched, and a payload already within these bounds
 *     comes back unchanged.
 *  2. Still too big (an input of very many strings): tool_input and
 *     tool_response are dropped. Delivering the event matters more.
 *  3. Still too big: another field no consumer reads (a failed tool's error
 *     output, say) is oversized, so every long string left is cut too.
 */
export function shrinkHookPayload(data: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...data };
  if (payload.tool_response !== undefined) {
    payload.tool_response = shrinkResponse(payload.tool_response);
  }
  if (payload.tool_input !== undefined) payload.tool_input = shrinkValue(payload.tool_input, 1);
  if (fitsInBody(payload)) return payload;

  delete payload.tool_response;
  delete payload.tool_input;
  if (fitsInBody(payload)) return payload;

  return shrinkValue(payload, 0) as Record<string, unknown>;
}

/** True if a process with this PID is alive. Best-effort: a false positive on
 *  PID reuse just costs one extra, harmless, failed POST -- never a crash. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every live registry entry under ~/.pixel-agents/servers/, so the
 * event can fan out to each running server (VS Code embedded + a standalone
 * `npx pixel-agents`, or several of either, all at once). Entries whose owning
 * PID is no longer alive are skipped (the owning server prunes its own stale
 * file on next start; this script only needs to not POST to it). Returns an
 * empty array when the directory is absent/empty/unreadable -- the caller
 * falls back to the legacy single-target server.json (forward-compat with a
 * server that predates the registry).
 */
function readRegistry(): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const live: ServerConfig[] = [];
  for (const file of files) {
    const filePath = path.join(SERVERS_REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isServerConfig(entry)) {
        hookDebug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        hookDebug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      hookDebug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/**
 * POST one hook event to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code.
 */
function postToServer(
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<void> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/claude`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve();
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry.
  // Falls back to the single legacy server.json when the registry has no live
  // entries -- e.g. a server on disk that predates the registry (A1/A2).
  let servers: ServerTarget[] = readRegistry();
  if (servers.length === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
      if (!isServerTarget(legacy)) {
        throw new Error('invalid legacy server config');
      }
      servers = [legacy];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(0);
    }
  }

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  const body = JSON.stringify(shrinkHookPayload(data));
  if (Buffer.byteLength(input) > MAX_BODY_BYTES) {
    hookDebug(
      `shrunk event=${eventName} sid=${sid} bytes=${Buffer.byteLength(input)}->${Buffer.byteLength(body)}`,
    );
  }
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));
}

// Run only as the hook script itself (the bundled CJS entry), not when a test
// imports this module for shrinkHookPayload.
if (require.main === module) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
