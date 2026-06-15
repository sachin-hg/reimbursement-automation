import { useState } from 'react';
import { api } from '../api.js';

const CONF_LOW = 55;

function ConfBadge({ score }) {
  if (!score || score === 0) return null;
  const cls = score >= 70 ? 'badge-green' : score >= CONF_LOW ? 'badge-yellow' : 'badge-red';
  return <span className={`badge ${cls}`} title="OCR confidence">{score}%</span>;
}

export default function BillCard({ bill, isSkipped, isIncluded, isRemoved, onChange, onToggleInclude, onToggleRemove }) {
  const [showOcr, setShowOcr] = useState(false);
  const [reextracting, setReextracting] = useState(false);

  function update(field, value) {
    onChange({ ...bill, [field]: value });
  }

  const amount = parseFloat(bill.bill_amount) || 0;
  const isValid = bill.bill_no && bill.bill_date && amount > 0;

  return (
    <div className={`bill-card card ${isSkipped ? 'skipped-card' : ''} ${isSkipped && isIncluded ? 'included' : ''} ${isRemoved ? 'skipped-card' : ''}`}>
      {/* Header */}
      <div className="card-header">
        <span className="ellipsis" style={{ flex: 1, fontSize: 12, color: isRemoved ? 'var(--muted)' : 'inherit' }}>
          {bill.filename}
        </span>
        {isSkipped ? (
          <>
            <span className="badge badge-yellow">⚠</span>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, fontWeight: 500 }}
            >
              <input type="checkbox" checked={isIncluded} onChange={e => onToggleInclude(e.target.checked)} style={{ width: 13, height: 13 }} />
              Include
            </label>
          </>
        ) : isRemoved ? (
          <span className="badge badge-gray">Removed</span>
        ) : (
          <>
            <ConfBadge score={bill.ocrConfidence} />
            <span className={`badge ${isValid ? 'badge-green' : 'badge-yellow'}`}>
              {isValid ? `₹${amount.toFixed(2)}` : 'Incomplete'}
            </span>
          </>
        )}
      </div>

      <div style={{ opacity: isRemoved ? 0.5 : 1 }}>
          {/* Image — full card width */}
          {bill.croppedUrl && (
            <div style={{ background: '#fafbfc', borderBottom: '1px solid var(--border)', padding: '10px', textAlign: 'center' }}>
              <img
                src={bill.croppedUrl}
                alt="receipt"
                loading="lazy"
                style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 4 }}
              />
            </div>
          )}

          {/* Raw OCR output (collapsible) */}
          {bill.ocrText && (
            <div style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowOcr(v => !v)}
                style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 0, padding: '6px 14px', fontSize: 11, color: 'var(--muted)' }}
              >
                {showOcr ? '▲' : '▼'} Raw OCR text
              </button>
              {showOcr && (
                <pre style={{
                  margin: 0, padding: '8px 14px 12px',
                  fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  color: 'var(--muted)', background: 'var(--surface-2, #f8f9fa)',
                  maxHeight: 200, overflowY: 'auto',
                }}>{bill.ocrText}</pre>
              )}
            </div>
          )}

          {/* Fields */}
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {isSkipped && bill.error && (
              <div className="error-banner" style={{ fontSize: 11 }}>
                {bill.error || 'no extractable data found'}
              </div>
            )}
            {isSkipped && !bill.croppedUrl && (
              <p className="muted small" style={{ lineHeight: 1.4 }}>Fill in details manually to include this bill</p>
            )}

            {bill.extracting ? (
              <div className="row" style={{ gap: 6, color: 'var(--muted)', fontSize: 12, padding: '4px 0' }}>
                <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                Extracting structured data…
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Receipt / Invoice No.</label>
                  <input
                    type="text"
                    value={bill.bill_no || ''}
                    onChange={e => update('bill_no', e.target.value)}
                    placeholder="e.g. May-102837-ORGNL"
                    disabled={isRemoved}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div className="field">
                    <label>Date (DD/MM/YYYY)</label>
                    <input
                      type="text"
                      value={bill.bill_date || ''}
                      onChange={e => update('bill_date', e.target.value)}
                      placeholder="24/05/2026"
                      disabled={isRemoved}
                    />
                  </div>
                  <div className="field">
                    <label>Amount (₹)</label>
                    <input
                      type="number"
                      value={bill.bill_amount || ''}
                      onChange={e => update('bill_amount', parseFloat(e.target.value) || '')}
                      placeholder="1520.00"
                      min="0" step="0.01"
                      disabled={isRemoved}
                    />
                  </div>
                </div>
              </>
            )}

            {!bill.extracting && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {!isSkipped && (
                  <button
                    className={`btn btn-sm ${isRemoved ? 'btn-primary' : 'btn-danger'}`}
                    onClick={onToggleRemove}
                  >
                    {isRemoved ? '+ Include' : 'Remove'}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    setReextracting(true);
                    try {
                      const res = await api.reextract(bill.id);
                      if (res.found) onChange({ ...bill, bill_no: res.bill_no, bill_date: res.bill_date, bill_amount: res.bill_amount });
                      else alert('LLM could not extract data from this image.');
                    } catch (err) {
                      alert(err.message);
                    } finally {
                      setReextracting(false);
                    }
                  }}
                  disabled={reextracting || isRemoved}
                  title="Re-extract this bill using Claude Vision"
                >
                  {reextracting ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> Re-extracting…</> : '↺ Re-extract with LLM'}
                </button>
              </div>
            )}
          </div>
      </div>
    </div>
  );
}
