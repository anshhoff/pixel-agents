import type { PermissionBehavior } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import type { ApprovalCard as ApprovalCardState } from './approvalState.js';
import { approvalCardFooter } from './approvalState.js';

interface ApprovalCardProps {
  card: ApprovalCardState | null;
  /** Read-only board (no token): the card shows, its buttons don't. */
  readOnly: boolean;
  /** `repo · title` for the agent that asked. */
  agentLabel: string;
  onAnswer: (behavior: PermissionBehavior) => void;
  onClose: () => void;
}

/**
 * The approval card: what the session wants to run, in full, and — on a
 * privileged board only — Allow / Deny for this one request. Deny asks no
 * further questions. Never offers "always allow": an answer here is this once,
 * and the settings' deny rules still win.
 */
export function ApprovalCard({ card, readOnly, agentLabel, onAnswer, onClose }: ApprovalCardProps) {
  if (!card) return null;
  const { request } = card;
  const footer = approvalCardFooter(card, readOnly);
  return (
    <Modal isOpen onClose={onClose} title="🔐 Needs approval" zIndex={60}>
      <div className="flex flex-col gap-6 px-10 pb-6 max-w-[640px]" data-testid="approval-card">
        <div className="text-sm text-text-muted" data-testid="approval-agent">
          {agentLabel}
        </div>
        <div className="text-lg" data-testid="approval-tool">
          {request.tool}
        </div>
        <pre
          className="font-mono text-[12px] whitespace-pre-wrap break-all bg-bg-dark border-2 border-border p-6 max-h-[40vh] overflow-auto m-0 select-text"
          data-testid="approval-detail"
        >
          {request.detail}
        </pre>
        {footer.kind === 'outcome' && (
          <div className="text-lg" data-testid="approval-outcome">
            {footer.text}
          </div>
        )}
        {footer.kind === 'readOnly' && (
          <div className="text-sm text-text-muted" data-testid="approval-read-only">
            {footer.note}
          </div>
        )}
        {footer.kind === 'buttons' && (
          <>
            <div className="flex gap-8">
              <Button
                variant={footer.disabled ? 'disabled' : 'accent'}
                disabled={footer.disabled}
                onClick={() => onAnswer('allow')}
                data-testid="approval-allow"
              >
                ✅ Allow
              </Button>
              <Button
                variant={footer.disabled ? 'disabled' : 'default'}
                disabled={footer.disabled}
                onClick={() => onAnswer('deny')}
                data-testid="approval-deny"
              >
                ❌ Deny
              </Button>
            </div>
            <div className="text-2xs text-text-muted" data-testid="approval-scope">
              {footer.note}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
