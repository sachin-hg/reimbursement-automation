import { useState, useEffect } from 'react';
import { api } from '../api.js';
import BillCard from './BillCard.jsx';

export default function Step3Panel({
  bills: initialBills,
  skipped: initialSkipped,
  extractProgress,
  extractTotal,
  onSubmitStarted,
}) {
  const [bills, setBills]     = useState(initialBills);
  const [skipped, setSkipped] = useState(
    initialSkipped.map(s => ({ ...s, bill_no: '', bill_date: '', bill_amount: '' }))
  );
  const [included, setIncluded]   = useState({});
  const [removed, setRemoved]     = useState(new Set());
  const [loading, setLoading]     = useState(false);

  // Sync from parent while SSE events are arriving during extraction
  useEffect(() => { setBills(initialBills); }, [initialBills]);
  useEffect(() => {
    setSkipped(prev =>
      initialSkipped.map(s => prev.find(p => p.id === s.id) ?? { ...s, bill_no: '', bill_date: '', bill_amount: '' })
    );
  }, [initialSkipped]);

  // Drive progress from props (not stale local state) so the bar stays accurate
  const stillExtracting = extractTotal > 0 && (initialBills.length + initialSkipped.length) < extractTotal;

  function updateBill(id, updated) {
    setBills(bs => bs.map(b => b.id === id ? updated : b));
  }

  function toggleRemove(id) {
    setRemoved(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function removeAll() {
    setRemoved(new Set(bills.map(b => b.id)));
  }

  function includeAll() {
    setRemoved(new Set());
  }

  function updateSkipped(id, updated) {
    setSkipped(ss => ss.map(s => s.id === id ? updated : s));
  }

  function toggleInclude(id, val) {
    setIncluded(m => ({ ...m, [id]: val }));
  }

  const includedSkipped = skipped.filter(s => included[s.id] && s.bill_no && s.bill_date && s.bill_amount);
  const allBillsToSubmit = [
    ...bills.filter(b => !removed.has(b.id)),
    ...includedSkipped,
  ];

  const total = allBillsToSubmit.reduce((sum, b) => sum + (parseFloat(b.bill_amount) || 0), 0);

  async function handleSubmit() {
    if (!allBillsToSubmit.length) return;
    setLoading(true);
    try {
      await api.submit(allBillsToSubmit);
      onSubmitStarted();
    } catch (err) {
      alert(err.message);
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h2>Review Extracted Data</h2>
          <div className="row mt8 gap4">
            <span className="badge badge-green">{bills.length - removed.size} included</span>
            {removed.size > 0 && <span className="badge badge-gray">{removed.size} removed</span>}
            {skipped.length > 0 && <span className="badge badge-yellow">{skipped.length} skipped</span>}
            {stillExtracting && (
              <span className="badge badge-blue">
                <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                Extracting…
              </span>
            )}
          </div>
        </div>
        {bills.length > 0 && !stillExtracting && (
          <div className="row" style={{ gap: 6, flexShrink: 0 }}>
            {removed.size < bills.length ? (
              <button className="btn btn-sm btn-ghost" onClick={removeAll} style={{ color: 'var(--red)' }}>
                ✗ Remove All
              </button>
            ) : null}
            {removed.size > 0 && (
              <button className="btn btn-sm btn-success" onClick={includeAll}>
                ✓ Include All
              </button>
            )}
          </div>
        )}
      </div>

      {stillExtracting && (
        <div className="card mb16" style={{ padding: '10px 16px' }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="spinner" />
            <span className="muted">
              Extracting {bills.length + skipped.length + 1} of {extractTotal}…
            </span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-fill"
              style={{ width: `${((bills.length + skipped.length) / extractTotal) * 100}%` }}
            />
          </div>
        </div>
      )}

      {bills.length > 0 && (
        <div className="mb16">
          <h3 className="muted small bold mb8" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Extracted Bills
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            {bills.map(b => (
              <BillCard
                key={b.id}
                bill={b}
                isSkipped={false}
                isRemoved={removed.has(b.id)}
                onChange={updated => updateBill(b.id, updated)}
                onToggleRemove={() => toggleRemove(b.id)}
              />
            ))}
          </div>
        </div>
      )}

      {skipped.length > 0 && (
        <div>
          <h3 className="muted small bold mb8" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Skipped — Manual Entry
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            {skipped.map(s => (
              <BillCard
                key={s.id}
                bill={s}
                isSkipped={true}
                isIncluded={!!included[s.id]}
                onChange={updated => updateSkipped(s.id, updated)}
                onToggleInclude={val => toggleInclude(s.id, val)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="sticky-footer">
        <div>
          <div className="bold">{allBillsToSubmit.length} bill{allBillsToSubmit.length !== 1 ? 's' : ''} to submit</div>
          <div className="muted small">Total: ₹{total.toFixed(2)}</div>
        </div>
        <button
          className="btn btn-success btn-lg"
          onClick={handleSubmit}
          disabled={allBillsToSubmit.length === 0 || loading || stillExtracting}
        >
          {loading
            ? <><span className="spinner" /> Submitting…</>
            : `→ Submit ${allBillsToSubmit.length} Bill${allBillsToSubmit.length !== 1 ? 's' : ''} to Portal`}
        </button>
      </div>
    </div>
  );
}
