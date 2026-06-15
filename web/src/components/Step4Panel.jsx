import { useEffect, useRef, useState } from 'react';

const PHASE_LABELS = {
  launch:            'Browser',
  login_nav:         'Portal',
  login_fill:        'Login',
  login_submit:      'Login',
  nav_reimbursement: 'Navigation',
  final_confirm:     'Submission',
  final_submit:      'Submission',
  user_confirm:      'Review',
  error:             'Error',
};

function StatusIcon({ status }) {
  if (status === 'done')  return <span style={{ color: 'var(--green, #22c55e)', fontWeight: 700, fontSize: 14 }}>✓</span>;
  if (status === 'error') return <span style={{ color: 'var(--red, #ef4444)', fontWeight: 700, fontSize: 14 }}>✗</span>;
  return <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, flexShrink: 0 }} />;
}

function BillChip({ entry }) {
  if (!entry.billIndex) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, padding: '1px 6px', borderRadius: 10,
      background: 'var(--surface-2, #f1f5f9)', color: 'var(--muted)',
      fontWeight: 500, marginTop: 2, whiteSpace: 'nowrap',
    }}>
      {entry.billIndex}/{entry.billTotal}
      {entry.billFilename && <span style={{ opacity: 0.7 }}>· {entry.billFilename}</span>}
      {entry.billAmount && <span>· ₹{entry.billAmount}</span>}
    </span>
  );
}

function LogEntry({ entry, isLatestActive }) {
  const isBill = entry.step?.startsWith('bill_');
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '7px 12px',
      background: isLatestActive ? 'var(--surface-2, #f8fafc)' : 'transparent',
      borderLeft: isLatestActive ? '2px solid var(--blue, #3b82f6)' : '2px solid transparent',
    }}>
      <div style={{ marginTop: 1, flexShrink: 0, width: 16, display: 'flex', justifyContent: 'center' }}>
        <StatusIcon status={entry.status} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          color: entry.status === 'error' ? 'var(--red, #ef4444)'
               : entry.status === 'done'  ? 'inherit'
               : 'var(--blue, #3b82f6)',
          fontWeight: isBill ? 400 : entry.status === 'active' ? 500 : 400,
          lineHeight: 1.4,
        }}>
          {isBill && <span style={{ opacity: 0.45, fontSize: 11, marginRight: 4 }}>└</span>}
          {entry.label}
        </div>
        {isBill && <BillChip entry={entry} />}
      </div>
    </div>
  );
}

function PhaseHeader({ label }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--muted)', padding: '10px 12px 4px',
    }}>
      {label}
    </div>
  );
}

function ProgressLog({ log }) {
  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [log.length]);

  if (!log.length) return null;

  const rows = [];
  let lastPhase = null, lastBillIndex = null;

  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    const isBill = entry.step?.startsWith('bill_');
    const phase = isBill ? null : PHASE_LABELS[entry.step];

    if (!isBill && phase && phase !== lastPhase) {
      rows.push({ type: 'header', label: phase, key: `h_${i}` });
      lastPhase = phase;
    }
    if (isBill && entry.billIndex && entry.billIndex !== lastBillIndex) {
      rows.push({ type: 'header', label: `Bill ${entry.billIndex} of ${entry.billTotal} — ${entry.billFilename || ''}`, key: `bh_${entry.billIndex}` });
      lastBillIndex = entry.billIndex;
      lastPhase = null;
    }

    const isLatestActive = entry.status === 'active' && i === log.length - 1;
    rows.push({ type: 'entry', entry, isLatestActive, key: entry.id });
  }

  return (
    <div style={{ overflowY: 'auto', maxHeight: 480, flex: 1 }}>
      {rows.map(r => r.type === 'header'
        ? <PhaseHeader key={r.key} label={r.label} />
        : <LogEntry key={r.key} entry={r.entry} isLatestActive={r.isLatestActive} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

export default function Step4Panel({
  result, error, log = [], screenshot, paused,
  awaitingConfirm, onReset, onRetry, onKill, onPause, onConfirm, onRetryFailed,
}) {
  const success = result?.success;
  const isSubmitting = !result && !error;
  const [retrying, setRetrying] = useState(false);

  async function handleRetryFailed() {
    if (!awaitingConfirm?.failedBills?.length) return;
    setRetrying(true);
    try {
      await onRetryFailed?.(awaitingConfirm.failedBills);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div>
      <div className="section-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>Portal Submission</h2>
          {isSubmitting && log.length > 0 && (
            <div className="row mt8 gap4">
              {paused
                ? <span className="badge badge-yellow">⏸ Paused</span>
                : <span className="badge badge-blue"><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Submitting…</span>
              }
            </div>
          )}
        </div>

        {/* Pause / Kill controls */}
        {isSubmitting && !awaitingConfirm && (
          <div className="row" style={{ gap: 6, flexShrink: 0 }}>
            {onPause && (
              <button className="btn btn-sm btn-ghost" onClick={onPause} title={paused ? 'Resume submission' : 'Pause between bills'}>
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
            )}
            {onKill && (
              <button className="btn btn-sm btn-danger" onClick={onKill} title="Stop submission immediately">
                ✕ Kill
              </button>
            )}
          </div>
        )}
      </div>

      {/* Live progress */}
      {log.length > 0 && (
        <div className="card mb16" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: screenshot ? '1fr 400px' : '1fr', minHeight: 200 }}>
            <div style={{ borderRight: screenshot ? '1px solid var(--border)' : 'none' }}>
              <ProgressLog log={log} />
            </div>
            {screenshot && (
              <div style={{ background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8, position: 'relative' }}>
                <img src={screenshot.dataUrl} alt="Browser view" style={{ width: '100%', height: 'auto', borderRadius: 4, objectFit: 'contain', maxHeight: 480, border: '1px solid rgba(255,255,255,0.1)' }} />
                <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', fontSize: 10, color: 'rgba(255,255,255,0.45)', background: 'rgba(0,0,0,0.6)', padding: '2px 8px', borderRadius: 8, whiteSpace: 'nowrap' }}>
                  Live browser view
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation gate — shown after all bills saved, before final portal submit */}
      {awaitingConfirm && (
        <div className="card mb16" style={{ padding: 20, border: '2px solid var(--blue, #3b82f6)' }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
            Review before final submission
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4, lineHeight: 1.6 }}>
            {awaitingConfirm.successCount} of {awaitingConfirm.total} bills have been entered into the portal.
            {awaitingConfirm.failCount > 0 && (
              <span style={{ color: 'var(--red, #ef4444)' }}> {awaitingConfirm.failCount} failed — see log above.</span>
            )}
          </div>
          {awaitingConfirm.failCount > 0 && awaitingConfirm.failedBills?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, background: 'var(--red-bg, #fee2e2)', borderRadius: 6, padding: '8px 12px', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--red, #ef4444)' }}>Failed bills:</strong>{' '}
              {awaitingConfirm.failedBills.map(b => b.filename).join(', ')}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.6 }}>
            The portal is now showing the <strong>"I hereby confirm…"</strong> checkbox.
            {awaitingConfirm.failCount > 0
              ? ' You can retry the failed bills, or confirm to submit the successful ones.'
              : ' Please review the entries in the browser screenshot, then click Confirm & Submit to proceed.'}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {awaitingConfirm.failCount > 0 && onRetryFailed && (
              <button
                className="btn btn-ghost"
                onClick={handleRetryFailed}
                disabled={retrying}
                title="Re-attempt the failed bills using the still-open browser session"
              >
                {retrying
                  ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Retrying…</>
                  : `↺ Retry ${awaitingConfirm.failCount} Failed Bill${awaitingConfirm.failCount !== 1 ? 's' : ''}`}
              </button>
            )}
            <button className="btn btn-success btn-lg" onClick={onConfirm} disabled={retrying}>
              ✓ Confirm &amp; Submit
            </button>
            {onKill && (
              <button className="btn btn-danger" onClick={onKill} disabled={retrying}>
                ✕ Cancel &amp; Kill
              </button>
            )}
          </div>
        </div>
      )}

      {/* Spinner while waiting for first event */}
      {!log.length && isSubmitting && (
        <div className="card mb16" style={{ padding: 32 }}>
          <div className="loading-placeholder">
            <span className="spinner" />
            Connecting to Mynd Solutions portal…
          </div>
        </div>
      )}

      {/* Result summary */}
      {(result || error) && (
        <>
          <div className={`submit-summary ${success ? '' : 'error'}`}>
            <span style={{ fontSize: 28 }}>{success ? '✅' : '❌'}</span>
            <div>
              <div className="bold">
                {success
                  ? `${result.count} bill${result.count !== 1 ? 's' : ''} submitted successfully`
                  : 'Submission failed'}
              </div>
              {result?.failed > 0 && (
                <div className="small" style={{ marginTop: 2, color: 'var(--red, #ef4444)' }}>
                  {result.failed} bill{result.failed !== 1 ? 's' : ''} failed — check log above
                </div>
              )}
              {(error || result?.error) && (
                <div className="small" style={{ marginTop: 2 }}>{error || result?.error}</div>
              )}
            </div>
          </div>

          {!success && (
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
                Submit manually at: <strong>mypayroll2.myndsolution.com</strong>
                <br />Quick Links → Reimbursement Claim → Car Running Maintenance Allowance
              </p>
            </div>
          )}
        </>
      )}

      {(result || error) && (
        <div style={{ display: 'flex', gap: 10 }}>
          {!success && onRetry && (
            <button className="btn btn-primary" onClick={onRetry}>↺ Try Again</button>
          )}
          <button className="btn btn-ghost" onClick={onReset}>← Start New Run</button>
        </div>
      )}
    </div>
  );
}
