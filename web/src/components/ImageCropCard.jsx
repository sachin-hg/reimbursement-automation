import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api.js'; // used by applyManualCrop → api.manualcrop

export default function ImageCropCard({ item, decision, onDecide, confidenceBadge }) {
  const [mode, setMode]         = useState('');        // '' | 'manual'
  const [loading, setLoading]   = useState(false);
  const [croppedUrl, setCroppedUrl] = useState(item.croppedUrl);
  const [cropReady, setCropReady]   = useState(!!item.croppedUrl);

  // Sync crop URL when another SSE subscriber triggers a crop on this same item
  useEffect(() => {
    if (item.croppedUrl && !loading) {
      setCroppedUrl(item.croppedUrl);
      setCropReady(true);
    }
  }, [item.croppedUrl]);

  // Manual drag-select state
  const imgRef    = useRef(null);
  const [sel, setSel]     = useState(null);   // { x1, y1, x2, y2 } in 0-1 range
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);

  const getRelPos = useCallback((e) => {
    const rect = imgRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height)),
    };
  }, []);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const pos = getRelPos(e);
    dragStart.current = pos;
    setSel({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
    setDragging(true);
  }, [getRelPos]);

  const onMouseMove = useCallback((e) => {
    if (!dragging) return;
    const pos = getRelPos(e);
    setSel(s => ({ ...s, x2: pos.x, y2: pos.y }));
  }, [dragging, getRelPos]);

  const onMouseUp = useCallback((e) => {
    if (!dragging) return;
    const pos = getRelPos(e);
    setSel(s => ({ ...s, x2: pos.x, y2: pos.y }));
    setDragging(false);
  }, [dragging, getRelPos]);

  const selBox = sel ? {
    left:   `${Math.min(sel.x1, sel.x2) * 100}%`,
    top:    `${Math.min(sel.y1, sel.y2) * 100}%`,
    width:  `${Math.abs(sel.x2 - sel.x1) * 100}%`,
    height: `${Math.abs(sel.y2 - sel.y1) * 100}%`,
  } : null;

  const hasSel = sel && Math.abs(sel.x2 - sel.x1) > 0.02 && Math.abs(sel.y2 - sel.y1) > 0.02;

  async function applyManualCrop() {
    if (!hasSel) return;
    setLoading(true);
    try {
      const x1 = Math.min(sel.x1, sel.x2), x2 = Math.max(sel.x1, sel.x2);
      const y1 = Math.min(sel.y1, sel.y2), y2 = Math.max(sel.y1, sel.y2);
      const pcts = {
        leftPct:   x1 * 100,
        topPct:    y1 * 100,
        rightPct:  (1 - x2) * 100,
        bottomPct: (1 - y2) * 100,
      };
      const res = await api.manualcrop(item.id, pcts);
      setCroppedUrl(res.croppedUrl + `?t=${Date.now()}`);
      setCropReady(true);
      setSel(null);
      setMode('');
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  const statusBadge = {
    approved: <span className="badge badge-green">✓ Approved</span>,
    rejected: <span className="badge badge-red">✗ Rejected</span>,
    pending:  <span className="badge badge-gray">Pending</span>,
  }[decision || 'pending'];

  return (
    <div className={`crop-card card ${decision === 'rejected' ? 'skipped-card' : ''}`}>
      <div className="card-header">
        <span className="ellipsis" style={{ flex: 1 }}>{item.filename}</span>
        {confidenceBadge}
        {statusBadge}
        {!cropReady && <span className="spinner" />}
      </div>

      <div className="crop-card-images">
        {/* Original */}
        <div className="crop-pane">
          <span className="crop-pane-label">Original</span>
          <img src={item.originalUrl} alt="original" loading="lazy" />
        </div>

        {/* Cropped */}
        <div className="crop-pane">
          <span className="crop-pane-label">Cropped</span>
          {cropReady
            ? <img src={croppedUrl} alt="cropped" loading="lazy" key={croppedUrl} />
            : <div className="loading-placeholder"><span className="spinner" /> Cropping…</div>
          }
        </div>
      </div>

      {/* Actions */}
      <div className="crop-actions">
        <button
          className={`btn btn-sm ${decision === 'approved' ? 'btn-success' : 'btn-ghost'}`}
          onClick={() => { onDecide(item.id, 'approved'); setMode(''); }}
          disabled={!cropReady}
        >✓ Approve</button>

        <button
          className={`btn btn-sm ${mode === 'manual' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => { setMode(mode === 'manual' ? '' : 'manual'); setSel(null); }}
          disabled={loading}
        >↺ Re-crop</button>

        <button
          className={`btn btn-sm ${decision === 'rejected' ? 'btn-danger' : 'btn-ghost'}`}
          style={decision === 'rejected' ? { borderColor: 'var(--red)', background: 'var(--red-bg)' } : {}}
          onClick={() => { onDecide(item.id, 'rejected'); setMode(''); }}
        >✗ Reject</button>

        {loading && <span className="spinner" />}
      </div>

      {/* Manual re-crop panel */}
      {mode === 'manual' && (
        <div className="crop-expand">
          <p className="manual-crop-hint">Click and drag on the original image to select the area to keep.</p>
          <div
            className="manual-crop-container"
            ref={imgRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <img src={item.originalUrl} alt="select crop area" draggable={false} />
            <div className="manual-crop-overlay">
              {selBox && (
                <>
                  <div className="manual-crop-dim" style={{ top: 0, left: 0, right: 0, height: selBox.top }} />
                  <div className="manual-crop-dim" style={{ bottom: 0, left: 0, right: 0, top: `calc(${selBox.top} + ${selBox.height})` }} />
                  <div className="manual-crop-dim" style={{ top: selBox.top, left: 0, width: selBox.left, height: selBox.height }} />
                  <div className="manual-crop-dim" style={{ top: selBox.top, right: 0, left: `calc(${selBox.left} + ${selBox.width})`, height: selBox.height }} />
                  <div className="manual-crop-selection" style={selBox} />
                </>
              )}
            </div>
          </div>
          <div className="row mt8">
            <button
              className="btn btn-primary btn-sm"
              onClick={applyManualCrop}
              disabled={!hasSel || loading}
            >
              {loading ? <><span className="spinner" /> Cropping…</> : 'Apply Crop'}
            </button>
            {hasSel && (
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}>Clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
