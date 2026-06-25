import { useState } from 'react';
import { api, type IntakeProposal, type ProposeResult } from '../api.js';

type Props = {
  onApprove: (proposal: IntakeProposal) => void
  onClose: () => void
}

// Paste a raw report -> the agent proposes a create/update (writing nothing) ->
// Approve hands the proposal off to the pre-filled TicketModal; Cancel dismisses.
export default function TriageModal({ onApprove, onClose }: Props) {
  const [report, setReport] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [result, setResult] = useState<ProposeResult | null>(null);

  const triage = async () => {
    if (!report.trim()) return;
    setPhase('loading');
    setResult(null);
    try {
      setResult(await api.intake.propose(report.trim()));
      setPhase('idle');
    } catch {
      setPhase('error');
    }
  };

  const proposal = result?.proposal ?? null;
  const proposedTitle = proposal && typeof proposal.args.title === 'string' ? proposal.args.title : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal triage-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="triage-title">Triage a report</h2>
        <textarea
          className="triage-input"
          placeholder="Paste a bug report, request, or note — the agent will propose a ticket…"
          value={report}
          onChange={(e) => setReport(e.target.value)}
          autoFocus
        />

        {phase === 'error' && (
          <p className="triage-status triage-error">Triage failed — is the model running?</p>
        )}

        {result && (proposal ? (
          <div className="triage-proposal">
            <div className="triage-proposal-head">
              Agent suggests:{' '}
              <strong>{proposal.action === 'update_ticket' ? 'Update an existing ticket' : 'Create a ticket'}</strong>
              {proposedTitle && <> — “{proposedTitle}”</>}
            </div>
            {result.summary && <p className="triage-status">{result.summary}</p>}
          </div>
        ) : (
          <p className="triage-status">{result.summary || 'No action suggested.'}</p>
        ))}

        <div className="triage-actions">
          {proposal ? (
            <button type="button" className="btn primary" onClick={() => onApprove(proposal)}>
              Approve &amp; edit
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => void triage()}
              disabled={phase === 'loading' || report.trim() === ''}
            >
              {phase === 'loading' ? 'Triaging…' : 'Triage'}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
