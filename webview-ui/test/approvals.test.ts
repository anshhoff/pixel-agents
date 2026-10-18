import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import {
  agentsWithPending,
  APPROVAL_READ_ONLY_NOTE,
  APPROVAL_SCOPE_NOTE,
  approvalAgentLabel,
  type ApprovalCard as ApprovalCardState,
  approvalCardFooter,
  approvalsReducer,
  type ApprovalsState,
  INITIAL_APPROVALS,
} from '../src/permissions/approvalState.js';

function pending(requestId: string, id: number, since = 1): ServerMessage {
  return {
    type: 'permissionPending',
    requestId,
    id,
    tool: 'Bash',
    detail: 'git push --force origin main',
    since,
  };
}

function apply(state: ApprovalsState, ...msgs: ServerMessage[]): ApprovalsState {
  return msgs.reduce((s, msg) => approvalsReducer(s, { type: 'message', msg }), state);
}

describe('approvalsReducer', () => {
  it('tracks pending requests per agent and opens the oldest for a clicked agent', () => {
    let state = apply(INITIAL_APPROVALS, pending('b', 1, 20), pending('a', 1, 10), pending('c', 2));
    expect([...agentsWithPending(state.pending)].sort()).toEqual([1, 2]);
    state = approvalsReducer(state, { type: 'open', agentId: 1 });
    expect(state.card?.request.requestId).toBe('a');
    expect(approvalsReducer(INITIAL_APPROVALS, { type: 'open', agentId: 9 }).card).toBeNull();
  });

  it('a resolution drops the request and shows its outcome on the open card', () => {
    let state = apply(INITIAL_APPROVALS, pending('a', 1));
    state = approvalsReducer(state, { type: 'open', agentId: 1 });
    state = apply(state, { type: 'permissionResolved', requestId: 'a', id: 1, outcome: 'allowed' });
    expect(state.pending).toEqual({});
    expect(state.card?.outcome).toBe('allowed');
    expect(approvalsReducer(state, { type: 'close' }).card).toBeNull();
  });

  it('answers once: a second click (or a click after the outcome) does nothing', () => {
    let state = approvalsReducer(apply(INITIAL_APPROVALS, pending('a', 1)), {
      type: 'open',
      agentId: 1,
    });
    state = approvalsReducer(state, { type: 'answer', behavior: 'deny' });
    expect(state.card?.answering).toBe('deny');
    expect(approvalsReducer(state, { type: 'answer', behavior: 'allow' })).toBe(state);
  });

  it('a reconnect snapshot (officeAccess first) starts over; a closed agent drops its requests', () => {
    let state = approvalsReducer(apply(INITIAL_APPROVALS, pending('a', 1), pending('b', 2)), {
      type: 'open',
      agentId: 1,
    });
    state = apply(state, { type: 'agentClosed', id: 1 });
    expect(Object.keys(state.pending)).toEqual(['b']);
    expect(state.card).toBeNull();
    state = apply(state, { type: 'officeAccess', readOnly: true });
    expect(state).toEqual(INITIAL_APPROVALS);
  });

  it('labels the card repo · title', () => {
    expect(approvalAgentLabel('hobbyfi-blog', 'Fix the build')).toBe(
      'hobbyfi-blog · Fix the build',
    );
    expect(approvalAgentLabel('hobbyfi-blog', '  ')).toBe('hobbyfi-blog');
    expect(approvalAgentLabel(undefined, undefined)).toBe('Agent');
  });
});

describe('approval card visibility by privilege', () => {
  const card: ApprovalCardState = {
    request: {
      requestId: 'a',
      agentId: 1,
      tool: 'Bash',
      detail: 'git push --force origin main',
      since: 1,
    },
  };

  it('a privileged board gets Allow / Deny with the this-once note', () => {
    expect(approvalCardFooter(card, false)).toEqual({
      kind: 'buttons',
      disabled: false,
      note: APPROVAL_SCOPE_NOTE,
    });
    expect(APPROVAL_SCOPE_NOTE).toBe("Only this once. Your settings' deny rules still apply.");
  });

  it('a read-only board gets no buttons, only where to approve', () => {
    expect(approvalCardFooter(card, true)).toEqual({
      kind: 'readOnly',
      note: APPROVAL_READ_ONLY_NOTE,
    });
    expect(APPROVAL_READ_ONLY_NOTE).toBe("Open the board's private link to approve");
  });

  it('the buttons go inert once this board answered', () => {
    expect(approvalCardFooter({ ...card, answering: 'allow' }, false)).toMatchObject({
      kind: 'buttons',
      disabled: true,
    });
  });

  it('once resolved, every board sees the outcome instead', () => {
    for (const readOnly of [false, true]) {
      expect(approvalCardFooter({ ...card, outcome: 'answeredInTerminal' }, readOnly)).toEqual({
        kind: 'outcome',
        text: 'Answered in the terminal',
      });
    }
    expect(approvalCardFooter({ ...card, outcome: 'allowed' }, false)).toMatchObject({
      text: '✅ Allowed',
    });
    expect(approvalCardFooter({ ...card, outcome: 'denied' }, true)).toMatchObject({
      text: '❌ Denied',
    });
  });
});
