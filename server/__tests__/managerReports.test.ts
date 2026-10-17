import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../core/src/messages.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type AlertFetch, PhoneAlerts } from '../src/alerts.js';
import {
  MANAGER_CLAUDE_MAX_BUFFER,
  MANAGER_CLAUDE_TIMEOUT_MS,
  MANAGER_DIR_NAME,
  MANAGER_REPORT_CHECK_INTERVAL_MS,
  REPORTS_DIR_NAME,
} from '../src/constants.js';
import { ProgressTracker } from '../src/progress/progressTracker.js';
import {
  buildReportData,
  buildReportPrompt,
  type ClaudeRun,
  ManagerReports,
  managerReportsEnabled,
  templateReport,
} from '../src/tasks/managerReports.js';
import { TaskLedger } from '../src/tasks/taskLedger.js';
import type { AgentState } from '../src/types.js';

/**
 * The Manager's daily report (docs/office/DESIGN.md, phase M): at 19:00 local
 * (or on "Write report now") the day's task log goes to `claude -p` as compact
 * JSON; on any failure a deterministic template is written instead. The claude
 * runner, ntfy fetch, clock and data dir are all injected: nothing runs claude,
 * nothing leaves the machine, nothing touches the real ~/.pixel-agents.
 */

const MIN = 60_000;
const DAY = '2026-10-17';
const at = (h: number, m = 0, d = 17) => new Date(2026, 9, d, h, m, 0).getTime();
const PR_URL = 'https://github.com/acme/web/pull/42';
const TOPIC = 'pixel-agents-Xy12_ab';
const AI_MARKDOWN = '## Done today\n- Shipped the strip';

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.title ?? 'id',
    title: 'Task',
    repo: 'hobbyfi-blog',
    machine: 'local',
    sessionId: 'session-secret-uuid',
    startedAt: at(9),
    status: 'done',
    prs: [],
    pushes: 0,
    filesEdited: 0,
    commands: 0,
    activeMs: 0,
    ...overrides,
  };
}

const SAMPLE: Task[] = [
  task({
    title: 'Ship the strip',
    status: 'done',
    activeMs: 42 * MIN,
    pushes: 2,
    filesEdited: 5,
    commands: 12,
    prs: [{ title: 'Add the strip', repo: 'acme/web', url: PR_URL, at: at(11) }],
  }),
  task({ title: 'Refactor auth', status: 'in_progress', activeMs: 75 * MIN, commands: 30 }),
  task({ title: 'Pick a font', status: 'waiting', activeMs: 3 * MIN }),
  task({ title: '💻 Mac · web', repo: 'web', machine: 'Mac', status: 'done', activeMs: 10 * MIN }),
];

describe('report data and prompt', () => {
  it('builds compact JSON: titles, repos, machines, status, minutes and counts only', () => {
    const data = buildReportData(DAY, SAMPLE);
    expect(data).toEqual({
      date: DAY,
      totals: { done: 2, open: 1, waiting: 1, prs: 1, pushes: 2, minutesActive: 130 },
      tasks: [
        {
          title: 'Ship the strip',
          repo: 'hobbyfi-blog',
          machine: 'local',
          status: 'done',
          minutesActive: 42,
          prs: [{ title: 'Add the strip', url: PR_URL }],
          pushes: 2,
          files: 5,
          commands: 12,
        },
        expect.objectContaining({
          title: 'Refactor auth',
          status: 'in_progress',
          minutesActive: 75,
        }),
        expect.objectContaining({ title: 'Pick a font', status: 'waiting', minutesActive: 3 }),
        expect.objectContaining({ title: '💻 Mac · web', machine: 'Mac', minutesActive: 10 }),
      ],
    });
    // No ids, sessions or times leave the machine.
    expect(JSON.stringify(data)).not.toMatch(/session-secret-uuid|startedAt|"id"/);
  });

  it('asks for the six sections, addressed to Ansh, from the JSON alone', () => {
    const data = buildReportData(DAY, SAMPLE);
    const prompt = buildReportPrompt(data);
    for (const section of [
      'Done today',
      'Still open',
      'Waiting on you',
      'PRs shipped',
      'Stuck or failing',
      'One suggestion',
    ]) {
      expect(prompt).toContain(`## ${section}`);
    }
    expect(prompt).toContain('Ansh');
    expect(prompt).toMatch(/never invent/i);
    expect(prompt).toContain(JSON.stringify(data));
  });

  it('writes a deterministic template with the same sections from the same data', () => {
    const data = buildReportData(DAY, SAMPLE);
    const md = templateReport(data);
    expect(templateReport(data)).toBe(md);
    expect(md).toContain('Ansh');
    const section = (name: string) => {
      const from = md.indexOf(`## ${name}`);
      expect(from).toBeGreaterThanOrEqual(0);
      const next = md.indexOf('\n## ', from + 1);
      return md.slice(from, next === -1 ? undefined : next);
    };
    expect(section('Done today')).toContain('Ship the strip');
    expect(section('Done today')).toContain('💻 Mac · web');
    expect(section('Done today')).not.toContain('Refactor auth');
    expect(section('Still open')).toContain('Refactor auth');
    expect(section('Waiting on you')).toContain('Pick a font');
    expect(section('PRs shipped')).toContain(`[Add the strip](${PR_URL})`);
    // An hour and more of work with nothing shipped looks stuck.
    expect(section('Stuck or failing')).toContain('Refactor auth');
    expect(section('One suggestion')).toMatch(/waiting on you/i);
  });

  it('says so when a section is empty', () => {
    const md = templateReport(buildReportData(DAY, []));
    expect(md).toMatch(/## Done today\n+_Nothing/);
    expect(md).toMatch(/## PRs shipped\n+_No PRs/);
  });
});

describe('managerReportsEnabled', () => {
  it('is on unless PIXEL_AGENTS_MANAGER turns it off', () => {
    expect(managerReportsEnabled({})).toBe(true);
    expect(managerReportsEnabled({ PIXEL_AGENTS_MANAGER: 'on' })).toBe(true);
    for (const off of ['off', 'OFF', ' 0 ', 'false', 'no']) {
      expect(managerReportsEnabled({ PIXEL_AGENTS_MANAGER: off })).toBe(false);
    }
  });
});

describe('ManagerReports', () => {
  let dataDir: string;
  let store: AgentStateStore;
  let clock: number;
  let tracker: ProgressTracker;
  let ledger: TaskLedger;
  let alerts: PhoneAlerts;
  let reports: ManagerReports;
  let runs: ClaudeRun[];
  let runner: (run: ClaudeRun) => Promise<string>;
  let sent: Array<{ url: string; body: string; headers: Record<string, string> }>;
  let messages: Array<Record<string, unknown>>;
  let env: NodeJS.ProcessEnv;

  const reportFile = (date = DAY) => path.join(dataDir, REPORTS_DIR_NAME, `${date}.json`);
  const readReport = (date = DAY) => JSON.parse(fs.readFileSync(reportFile(date), 'utf-8'));
  const alertsFile = () => path.join(dataDir, 'alerts.json');

  function newReports(platform: NodeJS.Platform = 'linux'): ManagerReports {
    return new ManagerReports(store, ledger, alerts, {
      dataDir,
      now: () => clock,
      env,
      platform,
      runClaude: (run) => {
        runs.push(run);
        return runner(run);
      },
    });
  }

  function addAgent(id: number, extra: Partial<AgentState> = {}): void {
    store.set(
      id,
      createAgentState({
        id,
        sessionId: `session-${id}`,
        isExternal: true,
        projectDir: '/work',
        jsonlFile: '',
        directoryName: 'hobbyfi-blog',
        ...extra,
      }),
    );
  }
  const status = (id: number, s: 'active' | 'waiting') =>
    store.broadcast({ type: 'agentStatus', id, status: s });

  /** Two done, one in progress, one waiting. */
  function seedDay(): void {
    for (const [id, title] of [
      [1, 'Ship the strip'],
      [2, 'Write the docs'],
      [3, 'Refactor auth'],
      [4, 'Pick a font'],
    ] as const) {
      addAgent(id, { title });
      status(id, 'active');
    }
    status(4, 'waiting');
    store.delete(1);
    store.delete(2);
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-reports-'));
    store = new AgentStateStore();
    clock = at(10);
    tracker = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    ledger = new TaskLedger(store, tracker, { dataDir, now: () => clock });
    sent = [];
    const fetchImpl: AlertFetch = async (url, init) => {
      sent.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200 };
    };
    alerts = new PhoneAlerts(store, tracker, {
      configFile: alertsFile(),
      fetch: fetchImpl,
      now: () => clock,
    });
    runs = [];
    runner = async () => `\n${AI_MARKDOWN}\n\n`;
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    env = {};
    reports = newReports();
  });

  afterEach(() => {
    reports.dispose();
    alerts.dispose();
    ledger.dispose();
    tracker.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('writing a report', () => {
    it('runs claude -p with no tools and no session, in the manager dir, prompt on stdin', async () => {
      seedDay();
      await reports.writeNow();

      expect(runs).toHaveLength(1);
      const [run] = runs;
      expect(run.file).toBe('claude');
      expect(run.args).toEqual([
        '-p',
        '--tools',
        '',
        '--no-session-persistence',
        '--output-format',
        'text',
      ]);
      expect(run.args).not.toContain('--bare');
      expect(run.cwd).toBe(path.join(dataDir, MANAGER_DIR_NAME));
      expect(fs.statSync(run.cwd).isDirectory()).toBe(true);
      expect(run.timeout).toBe(MANAGER_CLAUDE_TIMEOUT_MS);
      expect(MANAGER_CLAUDE_TIMEOUT_MS).toBe(120_000);
      expect(run.maxBuffer).toBe(MANAGER_CLAUDE_MAX_BUFFER);
      expect(MANAGER_CLAUDE_MAX_BUFFER).toBe(1024 * 1024);
      expect(run.input).toBe(buildReportPrompt(buildReportData(DAY, ledger.tasksFor(DAY))));
      expect(run.input).toContain('Refactor auth');
    });

    it('saves the AI report and announces it', async () => {
      seedDay();
      clock = at(15, 30);
      await reports.writeNow();
      expect(readReport()).toEqual({
        date: DAY,
        markdown: AI_MARKDOWN,
        generatedAt: at(15, 30),
        aiWritten: true,
      });
      expect(messages).toContainEqual({ type: 'reportReady', date: DAY });
      expect(reports.reportMessage(DAY)).toEqual({
        type: 'report',
        date: DAY,
        exists: true,
        markdown: AI_MARKDOWN,
        generatedAt: at(15, 30),
        aiWritten: true,
      });
    });

    it('uses claude.exe on Windows, and PIXEL_AGENTS_CLAUDE_BIN over either', async () => {
      reports.dispose();
      reports = newReports('win32');
      await reports.writeNow();
      expect(runs.at(-1)!.file).toBe('claude.exe');

      reports.dispose();
      env = { PIXEL_AGENTS_CLAUDE_BIN: '/opt/claude/bin/claude' };
      reports = newReports('win32');
      await reports.writeNow();
      expect(runs.at(-1)!.file).toBe('/opt/claude/bin/claude');
    });

    it('writes the template report when claude fails', async () => {
      const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedDay();
      runner = async () => {
        throw new Error('spawn claude ENOENT');
      };
      await reports.writeNow();
      const data = buildReportData(DAY, ledger.tasksFor(DAY));
      expect(readReport()).toMatchObject({ markdown: templateReport(data), aiWritten: false });
      expect(messages).toContainEqual({ type: 'reportReady', date: DAY });
      expect(logged).toHaveBeenCalled();
    });

    it('writes the template report when claude answers with nothing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner = async () => '   \n';
      await reports.writeNow();
      expect(readReport()).toMatchObject({ aiWritten: false });
      expect(readReport().markdown).toContain('## Done today');
    });

    it('answers requestReport with writing:true while it runs, one run at a time', async () => {
      let finish!: (text: string) => void;
      runner = () => new Promise<string>((resolve) => (finish = resolve));
      const first = reports.writeNow();
      const second = reports.writeNow();
      await Promise.resolve();
      expect(reports.reportMessage(DAY)).toEqual({
        type: 'report',
        date: DAY,
        exists: false,
        writing: true,
      });
      expect(runs).toHaveLength(1);

      finish(AI_MARKDOWN);
      await Promise.all([first, second]);
      expect(runs).toHaveLength(1);
      expect(reports.reportMessage(DAY)).toMatchObject({ exists: true, aiWritten: true });
      expect(reports.reportMessage(DAY)).not.toHaveProperty('writing');
    });

    it('says a day has no report, and shrugs off a corrupt one', () => {
      expect(reports.reportMessage('2026-10-01')).toEqual({
        type: 'report',
        date: '2026-10-01',
        exists: false,
      });
      fs.mkdirSync(path.join(dataDir, REPORTS_DIR_NAME), { recursive: true });
      fs.writeFileSync(reportFile('2026-10-02'), '{ nope');
      expect(reports.reportMessage('2026-10-02')).toMatchObject({ exists: false });
    });

    it('never runs claude with PIXEL_AGENTS_MANAGER=off: Write report now writes the template', async () => {
      reports.dispose();
      env = { PIXEL_AGENTS_MANAGER: 'off' };
      reports = newReports();
      seedDay();
      await reports.writeNow();
      expect(runs).toEqual([]);
      expect(readReport()).toMatchObject({ aiWritten: false });
    });
  });

  describe('the 19:00 run', () => {
    it('fires once at 19:00 local, not before, and pushes the counts to the phone', async () => {
      fs.writeFileSync(alertsFile(), JSON.stringify({ ntfyTopic: TOPIC }));
      seedDay();
      clock = at(18, 59);
      await reports.checkSchedule();
      expect(runs).toHaveLength(0);

      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
      expect(readReport()).toMatchObject({ aiWritten: true });
      expect(sent).toEqual([
        {
          url: `https://ntfy.sh/${TOPIC}`,
          body: '📋 Daily report: 2 done, 1 open, 1 waiting',
          headers: expect.objectContaining({ Title: 'Daily report' }),
        },
      ]);

      clock = at(19, 1);
      await reports.checkSchedule();
      clock = at(23, 59);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
    });

    it('fires once per day even across restarts, and again the next day', async () => {
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);

      reports.dispose();
      reports = newReports();
      clock = at(19, 30);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);

      clock = at(19, 0, 18);
      await reports.checkSchedule();
      expect(runs).toHaveLength(2);
      expect(fs.existsSync(reportFile('2026-10-18'))).toBe(true);
    });

    it('catches up after a restart past 19:00 on the same day', async () => {
      clock = at(21, 15);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
    });

    it('still fires at 19:00 after an earlier Write report now', async () => {
      clock = at(15, 0);
      await reports.writeNow();
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(2);
    });

    it('pushes nothing without alerts.json, or for a manual report', async () => {
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(sent).toEqual([]);

      fs.writeFileSync(alertsFile(), JSON.stringify({ ntfyTopic: TOPIC }));
      await reports.writeNow();
      expect(sent).toEqual([]);
    });

    it('checks on start and then every minute', async () => {
      vi.useFakeTimers();
      clock = at(18, 59);
      reports.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveLength(0);
      clock = at(19, 0);
      await vi.advanceTimersByTimeAsync(MANAGER_REPORT_CHECK_INTERVAL_MS);
      expect(runs).toHaveLength(1);
      reports.dispose();
      clock = at(19, 0, 18);
      await vi.advanceTimersByTimeAsync(MANAGER_REPORT_CHECK_INTERVAL_MS * 2);
      expect(runs).toHaveLength(1);
    });

    it('is off with PIXEL_AGENTS_MANAGER=off', async () => {
      reports.dispose();
      env = { PIXEL_AGENTS_MANAGER: 'off' };
      reports = newReports();
      clock = at(19, 0);
      reports.start();
      await reports.checkSchedule();
      expect(runs).toEqual([]);
      expect(fs.existsSync(reportFile())).toBe(false);
    });
  });
});
