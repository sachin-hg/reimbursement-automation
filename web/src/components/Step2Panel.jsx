import { useState } from 'react';
import { api } from '../api.js';
import ImageCropCard from './ImageCropCard.jsx';

const CONF_LOW = 55; // matches server LOW_CONFIDENCE_THRESHOLD

function confidenceBadge(score) {
  if (score === null || score === undefined) return null;
  const color = score >= 70 ? 'badge-green' : score >= CONF_LOW ? 'badge-yellow' : 'badge-red';
  return <span className={`badge ${color}`} title="OCR confidence">{score}%</span>;
}

export default function Step2Panel({ prepared, totalImages, onExtractStarted }) {
  const [decisions, setDecisions] = useState({});
  const [mode, setMode] = useState('ocr'); // 'ocr' | 'llm'
  const [loading, setLoading] = useState(false);

  const approvedIds = prepared.filter(p => decisions[p.id] === 'approved').map(p => p.id);
  const pendingCount  = prepared.filter(p => !decisions[p.id]).length;
  const approvedCount = approvedIds.length;
  const rejectedCount = prepared.filter(p => decisions[p.id] === 'rejected').length;
  const stillCropping = prepared.length < totalImages;

  // Sort: show low-confidence images first so they stand out
  const sorted = [...prepared].sort((a, b) => {
    const ca = a.ocrConfidence ?? 101;
    const cb = b.ocrConfidence ?? 101;
    return ca - cb;
  });

  function decide(id, decision) { setDecisions(d => ({ ...d, [id]: decision })); }
  function approveAll() { const n = {}; prepared.forEach(p => { n[p.id] = 'approved'; }); setDecisions(n); }
  function rejectAll()  { const n = {}; prepared.forEach(p => { n[p.id] = 'rejected'; }); setDecisions(n); }
  function clearAll()   { setDecisions({}); }

  async function handleExtract() {
    if (!approvedIds.length) return;
    setLoading(true);
    try {
      await api.extract(approvedIds, mode);
      onExtractStarted();
    } catch (err) {
      alert(err.message);
      setLoading(false);
    }
  }

  const lowConfCount = prepared.filter(p => p.ocrConfidence !== null && p.ocrConfidence !== undefined && p.ocrConfidence < CONF_LOW).length;

  return (
    <div>
      <div className="section-header">
        <div>
          <h2>Review Crops</h2>
          <div className="row mt8 gap4">
            <span className="badge badge-green">{approvedCount} approved</span>
            {rejectedCount > 0 && <span className="badge badge-red">{rejectedCount} rejected</span>}
            {pendingCount > 0 && <span className="badge badge-gray">{pendingCount} pending</span>}
            {lowConfCount > 0 && <span className="badge badge-red" title="Low OCR confidence — review carefully">⚠ {lowConfCount} low confidence</span>}
            {stillCropping && (
              <span className="badge badge-blue">
                <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                {prepared.length}/{totalImages} cropped
              </span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          <button className="btn btn-sm btn-success" onClick={approveAll}
            disabled={stillCropping || approvedCount === prepared.length}>✓ Approve All</button>
          <button className="btn btn-sm btn-ghost" onClick={rejectAll}
            disabled={stillCropping || rejectedCount === prepared.length}
            style={rejectedCount === prepared.length && prepared.length > 0 ? { color: 'var(--red)' } : {}}>✗ Reject All</button>
          {(approvedCount > 0 || rejectedCount > 0) && (
            <button className="btn btn-sm btn-ghost" onClick={clearAll}>↺ Clear</button>
          )}
        </div>
      </div>

      {stillCropping && (
        <div className="card mb16" style={{ padding: '10px 16px' }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="spinner" />
            <span className="muted">Cropping {prepared.length + 1} of {totalImages}…</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${(prepared.length / totalImages) * 100}%` }} />
          </div>
        </div>
      )}

      {sorted.map(item => (
        <ImageCropCard
          key={item.id}
          item={item}
          decision={decisions[item.id]}
          onDecide={decide}
          confidenceBadge={confidenceBadge(item.ocrConfidence)}
        />
      ))}

      <div className="sticky-footer">
        {/* Extraction mode toggle */}
        <div className="row" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Extract via:</span>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            {[['ocr', 'OCR (fast)'], ['llm', 'LLM Vision (accurate)']].map(([val, label]) => (
              <button
                key={val}
                onClick={() => setMode(val)}
                style={{
                  padding: '4px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer', border: 'none',
                  background: mode === val ? 'var(--accent)' : 'transparent',
                  color: mode === val ? 'white' : 'var(--muted)',
                  borderRight: val === 'ocr' ? '1px solid var(--border)' : 'none',
                }}
              >{label}</button>
            ))}
          </div>
          {mode === 'ocr' && lowConfCount > 0 && (
            <span className="muted" style={{ fontSize: 11 }}>⚠ {lowConfCount} low-confidence will use LLM fallback</span>
          )}
        </div>

        <button
          className="btn btn-primary btn-lg"
          onClick={handleExtract}
          disabled={approvedCount === 0 || stillCropping || loading}
        >
          {loading
            ? <><span className="spinner" /> Starting…</>
            : `→ Extract from ${approvedCount} Image${approvedCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}
