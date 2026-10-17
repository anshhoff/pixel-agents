import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  LOCAL_SESSIONS_BIN_ENV,
  LOCAL_SESSIONS_ENABLED_ENV,
  LOCAL_SESSIONS_LIST_MAX_BUFFER,
  LOCAL_SESSIONS_LIST_TIMEOUT_MS,
  LOCAL_SESSIONS_POLL_MS,
  SLEEP_AFTER_MS,
} from '../src/constants.js';
import {
  claudeSessionsBinary,
  createClaudeSessionLister,
  type LocalSession,
  type LocalSessionStatus,
  localSessionWatchEnabled,
  parseLocalSessions,
} from '../src/localSessions.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

/**
 * Sleeping chibis, server half: every Claude Code session open on this machine
 * is on the board (listed by `claude agents --json`, adopted from its
 * transcript), and an idle one falls asleep after SLEEP_AFTER_MS. Every test
 * gets a temp home and an injected clock and lister; nothing runs the real
 * claude or touches the real ~/.claude.
 */

const MIN = 60_000;
const LAPTOP = { id: 'laptop', label: 'Laptop', kind: 'computer' } as const;

type Message = Record<string, unknown>;

describe('parseLocalSessions', () => {
  it('reads the claude agents --json array', () => {
    const out = JSON.stringify([
      {
        pid: 11540,
        cwd: 'D:\\Projects\\hobbyfi-web-main',
        kind: 'interactive',
        startedAt: 1792219511209,
        sessionId: '5793ea6f-1111-2222-3333-444444444444',
        name: 'hobbyfi-web-main-50',
        status: 'idle',
      },
      { cwd: '/work/api', sessionId: 'abc-busy', status: 'busy' },
      { cwd: '/work/api', sessionId: 'abc-waiting', status: 'waiting' },
    ]);
    expect(parseLocalSessions(out)).toEqual([
      {
        sessionId: '5793ea6f-1111-2222-3333-444444444444',
        cwd: 'D:\\Projects\\hobbyfi-web-main',
        status: 'idle',
        pid: 11540,
        kind: 'interactive',
        name: 'hobbyfi-web-main-50',
        startedAt: 1792219511209,
      },
      { sessionId: 'abc-busy', cwd: '/work/api', status: 'busy' },
      { sessionId: 'abc-waiting', cwd: '/work/api', status: 'waiting' },
    ]);
  });

  it('drops entries without a usable session id or cwd', () => {
    const out = JSON.stringify([
      null,
      'a string',
      { cwd: '/work', status: 'idle' },
      { sessionId: '', cwd: '/work', status: 'idle' },
      // A session id becomes a file name: nothing that could walk out of the projects dir.
      { sessionId: '../../etc/passwd', cwd: '/work', status: 'idle' },
      { sessionId: 'a/b', cwd: '/work', status: 'idle' },
      { sessionId: 'no-cwd', status: 'idle' },
      { sessionId: 'ok', cwd: '/work', status: 'idle', pid: 'not a number', name: 7 },
    ]);
    expect(parseLocalSessions(out)).toEqual([{ sessionId: 'ok', cwd: '/work', status: 'idle' }]);
  });

  it('keeps a session whose status it does not know, as unknown', () => {
    const out = JSON.stringify([{ sessionId: 's1', cwd: '/work', status: 'thinking' }]);
    expect(parseLocalSessions(out)).toEqual([{ sessionId: 's1', cwd: '/work', status: 'unknown' }]);
  });

  it('throws on output that is not a JSON array', () => {
    expect(() => parseLocalSessions('not json')).toThrow();
    expect(() => parseLocalSessions('{"sessions": []}')).toThrow();
    expect(() => parseLocalSessions('')).toThrow();
  });
});

describe('claude session lister', () => {
  it('runs `claude agents --json` through execFile with a timeout, a buffer cap and no window', async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const list = createClaudeSessionLister({
      env: {},
      platform: 'win32',
      run: async (file, args, options) => {
        calls.push({ file, args, options: options as Record<string, unknown> });
        return JSON.stringify([{ sessionId: 's1', cwd: 'D:\\work', status: 'idle' }]);
      },
    });
    await expect(list()).resolves.toEqual([{ sessionId: 's1', cwd: 'D:\\work', status: 'idle' }]);
    expect(calls).toEqual([
      {
        file: 'claude.exe',
        args: ['agents', '--json'],
        options: {
          timeout: LOCAL_SESSIONS_LIST_TIMEOUT_MS,
          maxBuffer: LOCAL_SESSIONS_LIST_MAX_BUFFER,
          windowsHide: true,
        },
      },
    ]);
    expect(calls[0].options.shell).toBeUndefined();
  });

  it('rejects when the output is not a session list', async () => {
    const list = createClaudeSessionLister({ env: {}, run: async () => 'Error: unknown command' });
    await expect(list()).rejects.toThrow();
  });

  it('picks claude.exe on Windows, claude elsewhere, and honours the override', () => {
    expect(claudeSessionsBinary({}, 'win32')).toBe('claude.exe');
    expect(claudeSessionsBinary({}, 'darwin')).toBe('claude');
    expect(claudeSessionsBinary({}, 'linux')).toBe('claude');
    expect(
      claudeSessionsBinary({ [LOCAL_SESSIONS_BIN_ENV]: '/opt/claude/bin/claude' }, 'linux'),
    ).toBe('/opt/claude/bin/claude');
    expect(claudeSessionsBinary({ [LOCAL_SESSIONS_BIN_ENV]: '  ' }, 'linux')).toBe('claude');
  });

  it('is on unless PIXEL_AGENTS_SESSION_LIST turns it off', () => {
    expect(localSessionWatchEnabled({})).toBe(true);
    expect(localSessionWatchEnabled({ [LOCAL_SESSIONS_ENABLED_ENV]: '' })).toBe(true);
    expect(localSessionWatchEnabled({ [LOCAL_SESSIONS_ENABLED_ENV]: '1' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) {
      expect(localSessionWatchEnabled({ [LOCAL_SESSIONS_ENABLED_ENV]: off })).toBe(false);
    }
  });
});

describe('LocalSessionWatcher (through AgentRuntime)', () => {
  let home: string;
  let clock: number;
  let sessions: LocalSession[];
  let listSessions: ReturnType<typeof vi.fn<() => Promise<LocalSession[]>>>;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let messages: Message[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-local-sessions-'));
    clock = Date.now();
    sessions = [];
    listSessions = vi.fn(async () => sessions.map((s) => ({ ...s })));
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, {
      localSessions: {
        listSessions: () => listSessions(),
        now: () => clock,
        homedir: () => home,
      },
    });
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    runtime.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function cwdOf(name: string): string {
    return path.join(home, 'work', name);
  }

  /** A transcript last written `ageMs` before the injected clock. */
  function writeTranscript(
    cwd: string,
    sessionId: string,
    ageMs = 0,
    dirName = normalizeProjectPath(cwd),
  ): string {
    const dir = path.join(home, '.claude', 'projects', dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '');
    const t = (clock - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  }

  function list(sessionId: string, cwd: string, status: LocalSessionStatus = 'idle'): LocalSession {
    return { sessionId, cwd, status, kind: 'interactive' };
  }

  function poll(): Promise<void> {
    return runtime.localSessions.poll();
  }

  function agentFor(sessionId: string): AgentState | undefined {
    return [...store.values()].find((a) => a.sessionId === sessionId);
  }

  function sleeps(): Message[] {
    return messages.filter((m) => m.type === 'agentSleep');
  }

  function mtimeOf(file: string): number {
    return Math.floor(fs.statSync(file).mtimeMs);
  }

  function addBoardAgent(id: number, extra: Partial<AgentState>): AgentState {
    const agent = createAgentState({
      id,
      sessionId: `board-${id}`,
      isExternal: true,
      projectDir: '/work',
      jsonlFile: '',
      ...extra,
    });
    store.set(id, agent);
    return agent;
  }

  // ── Adoption ─────────────────────────────────────────────

  it('adopts an idle listed session from its transcript, labelled by its cwd', async () => {
    const cwd = cwdOf('hobbyfi-web');
    const file = writeTranscript(cwd, 'sess-idle', 5 * MIN);
    sessions = [list('sess-idle', cwd)];

    await poll();

    const agent = agentFor('sess-idle');
    expect(agent).toBeDefined();
    expect(agent!.jsonlFile).toBe(file);
    expect(agent!.isExternal).toBe(true);
    expect(agent!.directoryName).toBe('hobbyfi-web');
    expect(agent!.fromSessionList).toBe(true);
    // No hook confirmed this session: its tool activity must come from the transcript.
    expect(agent!.hookDelivered).toBe(false);
    expect(messages.some((m) => m.type === 'agentSleep')).toBe(false);
  });

  it('routes hook events for an adopted session to its agent', async () => {
    const cwd = cwdOf('api');
    writeTranscript(cwd, 'sess-hooked', 5 * MIN);
    sessions = [list('sess-hooked', cwd)];
    await poll();
    const agent = agentFor('sess-hooked')!;

    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-hooked',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.hookDelivered).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', id: agent.id }),
    );
  });

  it('finds a transcript outside the encoded cwd dir by searching the project dirs', async () => {
    const cwd = cwdOf('moved');
    const file = writeTranscript(cwd, 'sess-elsewhere', 5 * MIN, 'some-other-project-dir');
    sessions = [list('sess-elsewhere', cwd)];

    await poll();

    expect(agentFor('sess-elsewhere')?.jsonlFile).toBe(file);
  });

  it('skips a listed session with no transcript, and adopts it once the transcript appears', async () => {
    const cwd = cwdOf('fresh');
    sessions = [list('sess-later', cwd)];

    await poll();
    expect(store.size).toBe(0);

    writeTranscript(cwd, 'sess-later');
    await poll();
    expect(agentFor('sess-later')).toBeDefined();
  });

  it('adopts each session once, and leaves sessions already on the board alone', async () => {
    const cwd = cwdOf('web');
    writeTranscript(cwd, 'sess-once', 5 * MIN);
    const existingFile = writeTranscript(cwd, 'board-7', 5 * MIN);
    const existing = addBoardAgent(7, { sessionId: 'board-7', jsonlFile: existingFile });
    sessions = [list('sess-once', cwd), list('board-7', cwd)];

    await poll();
    await poll();

    expect(store.size).toBe(2);
    expect(existing.fromSessionList).toBeUndefined();
  });

  it('holds off adopting while a /clear is mid-flight, since its new session is that agent’s', async () => {
    const cwd = cwdOf('clearing');
    const clearing = addBoardAgent(5, { sessionId: 'sess-old', pendingClear: true });
    writeTranscript(cwd, 'sess-new', 0);
    sessions = [list('sess-new', cwd)];

    await poll();
    expect(store.size).toBe(1);

    // SessionStart(source=clear) never came: once the flag drops, the session is adoptable.
    clearing.pendingClear = false;
    await poll();
    expect(agentFor('sess-new')).toBeDefined();
  });

  it('does not re-adopt a session dismissed while it is still open', async () => {
    const cwd = cwdOf('dismissed');
    const file = writeTranscript(cwd, 'sess-dismissed', 5 * MIN);
    sessions = [list('sess-dismissed', cwd)];
    await poll();
    runtime.closeAgent(agentFor('sess-dismissed')!.id);
    // The dismissal tracker's cooldown is three minutes; the session stays open far longer.
    runtime.dismissalTracker.clearDismissal(file);

    await poll();
    expect(store.size).toBe(0);

    // Once the session is gone from the list, a later one with that id is new again.
    sessions = [];
    await poll();
    sessions = [list('sess-dismissed', cwd)];
    await poll();
    expect(agentFor('sess-dismissed')).toBeDefined();
  });

  // ── Sleeping ─────────────────────────────────────────────

  it('puts an idle agent to sleep once its last activity is SLEEP_AFTER_MS old', async () => {
    const cwd = cwdOf('sleepy');
    const file = writeTranscript(cwd, 'sess-sleepy');
    sessions = [list('sess-sleepy', cwd)];
    await poll();
    const id = agentFor('sess-sleepy')!.id;
    expect(sleeps()).toEqual([]);

    clock += SLEEP_AFTER_MS - 1_000;
    await poll();
    expect(sleeps()).toEqual([]);

    clock += 2_000;
    await poll();
    expect(sleeps()).toEqual([
      { type: 'agentSleep', id, sleeping: true, idleSince: mtimeOf(file) },
    ]);
    expect(runtime.localSessions.isSleeping(id)).toBe(true);

    // Only changes are broadcast.
    clock += LOCAL_SESSIONS_POLL_MS;
    await poll();
    expect(sleeps()).toHaveLength(1);
  });

  it('adopts a long-idle session straight into sleep', async () => {
    const cwd = cwdOf('ancient');
    const file = writeTranscript(cwd, 'sess-ancient', 3 * 60 * MIN);
    sessions = [list('sess-ancient', cwd)];

    await poll();

    const id = agentFor('sess-ancient')!.id;
    expect(sleeps()).toEqual([
      { type: 'agentSleep', id, sleeping: true, idleSince: mtimeOf(file) },
    ]);
  });

  it('counts the agent’s own last data as activity', async () => {
    const cwd = cwdOf('chatty');
    writeTranscript(cwd, 'sess-chatty', 60 * MIN);
    sessions = [list('sess-chatty', cwd, 'busy')];
    await poll();
    const agent = agentFor('sess-chatty')!;
    agent.lastDataAt = clock - 2 * MIN;

    sessions = [list('sess-chatty', cwd, 'idle')];
    await poll();

    expect(sleeps()).toEqual([]);
  });

  it('wakes a sleeping agent the moment it turns active, and lets it doze off again later', async () => {
    const cwd = cwdOf('wakes');
    writeTranscript(cwd, 'sess-wakes', 60 * MIN);
    sessions = [list('sess-wakes', cwd)];
    await poll();
    const id = agentFor('sess-wakes')!.id;
    expect(runtime.localSessions.isSleeping(id)).toBe(true);

    store.broadcast({ type: 'agentStatus', id, status: 'waiting' });
    expect(runtime.localSessions.isSleeping(id)).toBe(true);

    store.broadcast({ type: 'agentStatus', id, status: 'active' });
    expect(sleeps().at(-1)).toEqual({ type: 'agentSleep', id, sleeping: false });
    expect(runtime.localSessions.isSleeping(id)).toBe(false);

    // The list still says idle (it lags), but waking was activity.
    clock += LOCAL_SESSIONS_POLL_MS;
    await poll();
    expect(runtime.localSessions.isSleeping(id)).toBe(false);

    clock += SLEEP_AFTER_MS;
    await poll();
    expect(runtime.localSessions.isSleeping(id)).toBe(true);
    expect(sleeps()).toHaveLength(3);
  });

  it('never puts a busy or waiting session to sleep, and wakes one that turns busy', async () => {
    const cwd = cwdOf('workers');
    writeTranscript(cwd, 'sess-busy', 60 * MIN);
    writeTranscript(cwd, 'sess-waiting', 60 * MIN);
    sessions = [list('sess-busy', cwd, 'busy'), list('sess-waiting', cwd, 'waiting')];

    await poll();
    clock += SLEEP_AFTER_MS * 3;
    await poll();
    expect(sleeps()).toEqual([]);

    sessions = [list('sess-busy', cwd, 'idle'), list('sess-waiting', cwd, 'waiting')];
    await poll();
    const busyId = agentFor('sess-busy')!.id;
    expect(sleeps()).toEqual([expect.objectContaining({ id: busyId, sleeping: true })]);

    sessions = [list('sess-busy', cwd, 'busy'), list('sess-waiting', cwd, 'waiting')];
    await poll();
    expect(sleeps().at(-1)).toEqual({ type: 'agentSleep', id: busyId, sleeping: false });
  });

  it('puts board agents it did not adopt to sleep too, when their session is idle', async () => {
    const cwd = cwdOf('hooked');
    const file = writeTranscript(cwd, 'board-3', 60 * MIN);
    addBoardAgent(3, { sessionId: 'board-3', jsonlFile: file, lastDataAt: clock - 90 * MIN });
    sessions = [list('board-3', cwd)];

    await poll();

    expect(sleeps()).toEqual([
      { type: 'agentSleep', id: 3, sleeping: true, idleSince: mtimeOf(file) },
    ]);
  });

  // ── Removal ──────────────────────────────────────────────

  it('removes an agent it adopted once its session is missing from 2 polls in a row, and no other', async () => {
    const cwd = cwdOf('ending');
    writeTranscript(cwd, 'sess-ending', 5 * MIN);
    sessions = [list('sess-ending', cwd)];
    await poll();
    const adopted = agentFor('sess-ending')!;
    const other = addBoardAgent(9, { sessionId: 'board-9' });

    sessions = [];
    await poll();
    expect(store.has(adopted.id)).toBe(true);

    // Reappearing resets the count.
    sessions = [list('sess-ending', cwd)];
    await poll();
    sessions = [];
    await poll();
    expect(store.has(adopted.id)).toBe(true);

    await poll();
    expect(store.has(adopted.id)).toBe(false);
    expect(store.has(other.id)).toBe(true);

    // Unregistered: its hook events no longer resolve to an agent.
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-ending' });
    expect(store.size).toBe(1);
  });

  // ── Failures ─────────────────────────────────────────────

  it('treats a failed listing as no news: nothing removed, logged once, polling goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cwd = cwdOf('flaky');
    writeTranscript(cwd, 'sess-flaky', 5 * MIN);
    sessions = [list('sess-flaky', cwd)];
    await poll();
    const id = agentFor('sess-flaky')!.id;

    listSessions.mockRejectedValue(new Error('spawn claude.exe ENOENT'));
    await expect(poll()).resolves.toBeUndefined();
    await poll();
    await poll();
    expect(store.has(id)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    // Failures don't count as missing polls either.
    listSessions.mockImplementation(async () => []);
    await poll();
    expect(store.has(id)).toBe(true);
    await poll();
    expect(store.has(id)).toBe(false);
  });

  it('survives a lister that throws synchronously', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listSessions.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(poll()).resolves.toBeUndefined();
  });

  // ── Snapshot ─────────────────────────────────────────────

  it('re-sends sleeping agents to a connecting client', async () => {
    const cwd = cwdOf('snap');
    const asleepFile = writeTranscript(cwd, 'sess-asleep', 60 * MIN);
    writeTranscript(cwd, 'sess-awake', 60 * MIN);
    sessions = [list('sess-asleep', cwd), list('sess-awake', cwd, 'busy')];
    await poll();

    const sent: Message[] = [];
    resendAgentActivity((m) => sent.push(m), store);

    expect(sent.filter((m) => m.type === 'agentSleep')).toEqual([
      {
        type: 'agentSleep',
        id: agentFor('sess-asleep')!.id,
        sleeping: true,
        idleSince: mtimeOf(asleepFile),
      },
    ]);
  });

  // ── Remote agents ────────────────────────────────────────

  it('never sleeps, adopts over, or removes a remote agent', async () => {
    const remote = addBoardAgent(42, {
      sessionId: 'shared-id',
      hooksOnly: true,
      remoteSource: LAPTOP,
      lastDataAt: clock - 60 * MIN,
    });
    const cwd = cwdOf('remote');
    writeTranscript(cwd, 'shared-id', 60 * MIN);
    sessions = [list('shared-id', cwd)];

    await poll();
    sessions = [];
    await poll();
    await poll();
    await poll();

    expect(store.size).toBe(1);
    expect(store.get(42)).toBe(remote);
    expect(sleeps()).toEqual([]);
  });

  // ── Lifecycle ────────────────────────────────────────────

  it('polls on start and every LOCAL_SESSIONS_POLL_MS until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    runtime.startLocalSessionWatch();
    expect(listSessions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOCAL_SESSIONS_POLL_MS);
    expect(listSessions).toHaveBeenCalledTimes(2);

    runtime.stopLocalSessionWatch();
    await vi.advanceTimersByTimeAsync(LOCAL_SESSIONS_POLL_MS * 3);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('does nothing after dispose', async () => {
    const cwd = cwdOf('late');
    writeTranscript(cwd, 'sess-late', 5 * MIN);
    sessions = [list('sess-late', cwd)];
    runtime.localSessions.dispose();

    await poll();

    expect(store.size).toBe(0);
  });
});
