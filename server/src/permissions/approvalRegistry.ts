import * as path from 'path';

import type {
  PermissionBehavior,
  PermissionOutcome,
  PermissionPending,
  PermissionResolved,
} from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { remoteSourceOf } from '../remoteSource.js';
import {
  PERMISSION_AGENT_RESOLVE_MS,
  PERMISSION_AGENT_RESOLVE_POLL_MS,
  PERMISSION_WAIT_MS,
} from './constants.js';
import { formatPermissionDetail, shortPermissionDetail } from './permissionDetail.js';

/** What the hook script prints back to Claude Code. Only these two fields,
 *  ever: no "always allow", no updatedPermissions, no rewritten input. */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  message?: string;
}

/** The long-poll's answer: a decision, or nothing (the terminal decides). */
export interface PermissionWaitResult {
  decision?: PermissionDecision;
}

/** One PermissionRequest, as the hook script posts it. */
export interface PermissionWaitRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  /** The session's working directory (the payload's `cwd`), for the log. */
  cwd?: string;
  /** Set when the payload came through remote/relay. Never answered here. */
  remote?: boolean;
}

/** One line of approvals.log, before formatting. */
export interface ApprovalLogEntry {
  time: string;
  agentId: number;
  repo: string;
  tool: string;
  detail: string;
  decision: PermissionBehavior;
  client?: string;
}

export interface PermissionApprovalsOptions {
  store: AgentStateStore;
  /** Whether approvals are switched off right now (re-read per request). */
  isSwitchedOff?: () => boolean;
  /** Appends one answer to the audit log. Never throws (see approvalsLog.ts). */
  log?: (entry: ApprovalLogEntry) => void;
  waitMs?: number;
  resolveAgentMs?: number;
  resolveAgentPollMs?: number;
  now?: () => number;
}

/** The message Claude reads when the board denies a tool call. */
export const BOARD_DENY_MESSAGE = 'The user denied this from the Pixel Agents board.';

/** Hook events that mean the session moved past its permission dialog: the
 *  terminal answered it (or the session ended). Any of them arriving for the
 *  session after a request was registered resolves that request. */
const SESSION_MOVED_ON_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
]);

interface PendingRequest {
  requestId: string;
  sessionId: string;
  /** Undefined until the session's agent is found; only then is it broadcast. */
  agentId?: number;
  tool: string;
  detail: string;
  since: number;
  cwd?: string;
  timer: ReturnType<typeof setTimeout>;
  finish: (result: PermissionWaitResult) => void;
}

/**
 * Pending permission requests, by requestId. A local session's
 * PermissionRequest hook long-polls `wait`; the request is shown on the board
 * (`permissionPending`) and ends in exactly one `permissionResolved`:
 *  - `allowed` / `denied`: a privileged client answered (`answer`). The wait
 *    returns the decision, and the answer is appended to approvals.log.
 *  - `answeredInTerminal`: the session moved on (PreToolUse, PostToolUse,
 *    Stop or SessionEnd after the request), its agent left the board, or the
 *    hook went away. The wait returns no decision.
 *  - `expired`: nobody answered within the wait window. No decision.
 * Relayed remote sessions are never registered: approvals are LOCAL only.
 */
export class PermissionApprovals {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waitMs: number;
  private readonly resolveAgentMs: number;
  private readonly resolveAgentPollMs: number;
  private readonly now: () => number;
  private readonly onAgentRemoved = (id: number) => {
    for (const req of [...this.pending.values()]) {
      if (req.agentId === id) this.finish(req, 'answeredInTerminal', {});
    }
  };
  private disposed = false;

  constructor(private readonly options: PermissionApprovalsOptions) {
    this.waitMs = options.waitMs ?? PERMISSION_WAIT_MS;
    this.resolveAgentMs = options.resolveAgentMs ?? PERMISSION_AGENT_RESOLVE_MS;
    this.resolveAgentPollMs = options.resolveAgentPollMs ?? PERMISSION_AGENT_RESOLVE_POLL_MS;
    this.now = options.now ?? Date.now;
    options.store.on('agentRemoved', this.onAgentRemoved);
  }

  /**
   * Hold one request until it is answered, superseded, or expires. Resolves
   * with no decision whenever the board should stay out of it: switched off,
   * a remote session, a requestId already in use, or no LOCAL agent for the
   * session within PERMISSION_AGENT_RESOLVE_MS.
   */
  wait(request: PermissionWaitRequest): Promise<PermissionWaitResult> {
    if (this.disposed || request.remote || this.options.isSwitchedOff?.()) {
      return Promise.resolve({});
    }
    if (this.pending.has(request.requestId)) return Promise.resolve({});
    return new Promise((resolve) => {
      const req: PendingRequest = {
        requestId: request.requestId,
        sessionId: request.sessionId,
        tool: request.toolName,
        detail: formatPermissionDetail(request.toolName, request.toolInput),
        since: this.now(),
        cwd: request.cwd,
        timer: setTimeout(() => this.finish(req, 'expired', {}), this.waitMs),
        finish: resolve,
      };
      // Registered BEFORE the agent is known, so a terminal answer that lands
      // while the agent is still being resolved is not missed.
      this.pending.set(req.requestId, req);
      this.attachAgent(req, this.now() + this.resolveAgentMs);
    });
  }

  /** Every raw hook event the server receives. An event that shows the
   *  session moved past its dialog resolves that session's requests. */
  observeHookEvent(event: Record<string, unknown>): void {
    const name = event.hook_event_name;
    const sessionId = event.session_id;
    if (typeof name !== 'string' || typeof sessionId !== 'string') return;
    if (!SESSION_MOVED_ON_EVENTS.has(name) || remoteSourceOf(event)) return;
    for (const req of [...this.pending.values()]) {
      if (req.sessionId === sessionId) this.finish(req, 'answeredInTerminal', {});
    }
  }

  /**
   * A privileged client's answer. Returns whether it settled a pending
   * request. Only reachable past the read-only gate in handleClientMessage;
   * validated here again because the payload is client-supplied.
   */
  answer(requestId: unknown, behavior: unknown, client?: string): boolean {
    if (typeof requestId !== 'string') return false;
    if (behavior !== 'allow' && behavior !== 'deny') return false;
    const req = this.pending.get(requestId);
    // An announced request only: one still resolving its agent was never shown.
    if (!req || req.agentId === undefined) return false;
    const decision: PermissionDecision =
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: BOARD_DENY_MESSAGE };
    this.finish(req, behavior === 'allow' ? 'allowed' : 'denied', { decision });
    this.options.log?.({
      time: new Date(this.now()).toISOString(),
      agentId: req.agentId,
      repo: this.repoOf(req),
      tool: req.tool,
      detail: shortPermissionDetail(req.detail),
      decision: behavior,
      client,
    });
    return true;
  }

  /** The hook's connection closed before an answer (Claude Code moved on and
   *  ended the hook, or the session exited). */
  abandon(requestId: string): void {
    const req = this.pending.get(requestId);
    if (req) this.finish(req, 'answeredInTerminal', {});
  }

  /** Pending requests as permissionPending messages, for the connect snapshot. */
  pendingMessages(): PermissionPending[] {
    return [...this.pending.values()]
      .filter((req) => req.agentId !== undefined)
      .map((req) => this.pendingMessage(req));
  }

  /** Answer every wait with no decision (the terminal still decides). */
  dispose(): void {
    this.disposed = true;
    this.options.store.off('agentRemoved', this.onAgentRemoved);
    for (const req of [...this.pending.values()]) {
      clearTimeout(req.timer);
      this.pending.delete(req.requestId);
      req.finish({});
    }
  }

  private attachAgent(req: PendingRequest, deadline: number): void {
    if (this.pending.get(req.requestId) !== req) return; // already settled
    const found = this.localAgentFor(req.sessionId);
    if (found === 'remote') {
      this.finish(req, 'answeredInTerminal', {});
      return;
    }
    if (found !== undefined) {
      req.agentId = found;
      this.options.store.broadcast({ ...this.pendingMessage(req) });
      return;
    }
    if (this.now() >= deadline) {
      this.finish(req, 'answeredInTerminal', {});
      return;
    }
    setTimeout(() => this.attachAgent(req, deadline), this.resolveAgentPollMs);
  }

  /** The board agent for a session: a top-level agent wins over a teammate
   *  sharing the session. 'remote' when the session is a relayed one. */
  private localAgentFor(sessionId: string): number | 'remote' | undefined {
    let fallback: number | undefined;
    for (const [id, agent] of this.options.store) {
      if (agent.sessionId !== sessionId) continue;
      if (agent.remoteSource) return 'remote';
      if (agent.leadAgentId === undefined) return id;
      fallback ??= id;
    }
    return fallback;
  }

  private pendingMessage(req: PendingRequest): PermissionPending {
    return {
      type: 'permissionPending',
      requestId: req.requestId,
      id: req.agentId!,
      tool: req.tool,
      detail: req.detail,
      since: req.since,
    };
  }

  private repoOf(req: PendingRequest): string {
    const agent = req.agentId !== undefined ? this.options.store.get(req.agentId) : undefined;
    return agent?.directoryName || (req.cwd ? path.basename(req.cwd) : '') || '?';
  }

  /** Settle a request exactly once: stop its timer, drop it, answer the wait,
   *  and tell the board (only if the board was ever told it was pending). */
  private finish(
    req: PendingRequest,
    outcome: PermissionOutcome,
    result: PermissionWaitResult,
  ): void {
    if (this.pending.get(req.requestId) !== req) return;
    clearTimeout(req.timer);
    this.pending.delete(req.requestId);
    req.finish(result);
    if (req.agentId !== undefined) {
      const resolved: PermissionResolved = {
        type: 'permissionResolved',
        requestId: req.requestId,
        id: req.agentId,
        outcome,
      };
      this.options.store.broadcast({ ...resolved });
    }
  }
}
