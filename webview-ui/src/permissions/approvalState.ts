import type {
  PermissionBehavior,
  PermissionOutcome,
  ServerMessage,
} from '../../../core/src/messages.js';

/** How long the card shows a request's outcome before it closes itself. */
export const APPROVAL_OUTCOME_SHOW_MS = 2_500;

/** The label an agent with a pending request shows instead of its activity. */
export const APPROVAL_LABEL_TEXT = '🔐 needs approval — click';

/** Under the buttons: what an answer from the board can and cannot do. */
export const APPROVAL_SCOPE_NOTE = "Only this once. Your settings' deny rules still apply.";

/** In place of the buttons, for a read-only (untokened) board. */
export const APPROVAL_READ_ONLY_NOTE = "Open the board's private link to approve";

/** One request a local session is waiting on (permissionPending). */
export interface PendingApproval {
  requestId: string;
  agentId: number;
  tool: string;
  detail: string;
  since: number;
}

/** The open approval card: which request, and how it ended once it has. */
export interface ApprovalCard {
  request: PendingApproval;
  /** Set once this board sent an answer, so the buttons can't send twice. */
  answering?: PermissionBehavior;
  /** Set by permissionResolved; the card shows it, then closes. */
  outcome?: PermissionOutcome;
}

export interface ApprovalsState {
  pending: Record<string, PendingApproval>;
  card: ApprovalCard | null;
}

export type ApprovalsAction =
  | { type: 'message'; msg: ServerMessage }
  | { type: 'open'; agentId: number }
  | { type: 'answer'; behavior: PermissionBehavior }
  | { type: 'close' };

export const INITIAL_APPROVALS: ApprovalsState = { pending: {}, card: null };

/** The card's `repo · title` line; either half may be unknown. */
export function approvalAgentLabel(repo: string | undefined, title: string | undefined): string {
  return [repo, title?.trim()].filter((part) => part).join(' · ') || 'Agent';
}

/** What the card's bottom section shows. The ONE place privilege decides
 *  whether Allow / Deny exist (ApprovalCard renders exactly this). */
export type ApprovalCardFooter =
  | { kind: 'outcome'; text: string }
  | { kind: 'readOnly'; note: string }
  | { kind: 'buttons'; disabled: boolean; note: string };

export function approvalCardFooter(card: ApprovalCard, readOnly: boolean): ApprovalCardFooter {
  if (card.outcome) return { kind: 'outcome', text: outcomeText(card.outcome) };
  if (readOnly) return { kind: 'readOnly', note: APPROVAL_READ_ONLY_NOTE };
  return { kind: 'buttons', disabled: card.answering !== undefined, note: APPROVAL_SCOPE_NOTE };
}

/** Short text for how a request ended. */
export function outcomeText(outcome: PermissionOutcome): string {
  switch (outcome) {
    case 'allowed':
      return '✅ Allowed';
    case 'denied':
      return '❌ Denied';
    case 'answeredInTerminal':
      return 'Answered in the terminal';
    case 'expired':
      return 'Expired: answer it in the terminal';
  }
}

/** The oldest pending request for an agent, if any. */
export function oldestPendingFor(
  pending: Record<string, PendingApproval>,
  agentId: number,
): PendingApproval | undefined {
  let oldest: PendingApproval | undefined;
  for (const req of Object.values(pending)) {
    if (req.agentId !== agentId) continue;
    if (!oldest || req.since < oldest.since) oldest = req;
  }
  return oldest;
}

/** Agents that have at least one pending request. */
export function agentsWithPending(pending: Record<string, PendingApproval>): Set<number> {
  return new Set(Object.values(pending).map((req) => req.agentId));
}

function without(
  pending: Record<string, PendingApproval>,
  keep: (req: PendingApproval) => boolean,
): Record<string, PendingApproval> {
  return Object.fromEntries(Object.entries(pending).filter(([, req]) => keep(req)));
}

/** Pure state transitions for the approvals UI (Node-tested). */
export function approvalsReducer(state: ApprovalsState, action: ApprovalsAction): ApprovalsState {
  switch (action.type) {
    case 'message': {
      const msg = action.msg;
      switch (msg.type) {
        case 'officeAccess':
          // First message of every (re)connect snapshot: what was pending
          // before is re-sent if it still is, and anything resolved while we
          // were away must not keep its buttons.
          return INITIAL_APPROVALS;
        case 'permissionPending': {
          const request: PendingApproval = {
            requestId: msg.requestId,
            agentId: msg.id,
            tool: msg.tool,
            detail: msg.detail,
            since: msg.since,
          };
          return { ...state, pending: { ...state.pending, [msg.requestId]: request } };
        }
        case 'permissionResolved': {
          const pending = without(state.pending, (req) => req.requestId !== msg.requestId);
          const card =
            state.card?.request.requestId === msg.requestId
              ? { ...state.card, outcome: msg.outcome }
              : state.card;
          return { pending, card };
        }
        case 'agentClosed': {
          const pending = without(state.pending, (req) => req.agentId !== msg.id);
          const card = state.card?.request.agentId === msg.id ? null : state.card;
          return { pending, card };
        }
        default:
          return state;
      }
    }
    case 'open': {
      const request = oldestPendingFor(state.pending, action.agentId);
      return request ? { ...state, card: { request } } : state;
    }
    case 'answer':
      if (!state.card || state.card.answering || state.card.outcome) return state;
      return { ...state, card: { ...state.card, answering: action.behavior } };
    case 'close':
      return { ...state, card: null };
  }
}
