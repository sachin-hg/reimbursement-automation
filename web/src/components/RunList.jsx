import { useState, useEffect } from 'react';
import { api } from '../api.js';

const STATUS_LABELS = {
  loaded:     { label: 'Uploaded',    color: '#6b7280', bg: '#f3f4f6' },
  cropping:   { label: 'Cropping…',   color: '#2563eb', bg: '#eff6ff' },
  crop_done:  { label: 'Cropped',     color: '#6b7280', bg: '#f3f4f6' },
  extracting: { label: 'Extracting…', color: '#2563eb', bg: '#eff6ff' },
  extracted:  { label: 'Ready',       color: '#059669', bg: '#ecfdf5' },
  submitting: { label: 'Submitting…', color: '#d97706', bg: '#fffbeb' },
  done:       { label: 'Submitted ✓', color: '#059669', bg: '#ecfdf5' },
  error:      { label: 'Error',       color: '#dc2626', bg: '#fef2f2' },
};

export default function RunList({ onActivate }) {
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);

  function refresh() {
    api.listRuns().then(setRuns).catch(() => {}).finally(() => setLoaded(true));
  }

  useEffect(() => { refresh(); }, []);

  async function handleDelete(e, id) {
    e.stopPropagation();
    if (!confirm('Delete this run and its images?')) return;
    await api.deleteRun(id).catch(() => {});
    setRuns(prev => prev.filter(r => r.id !== id));
  }

  if (!loaded || !runs.length) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--muted)', marginBottom: 12,
      }}>
        Recent Runs
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {runs.map(run => {
          const s = STATUS_LABELS[run.status] || { label: run.status, color: '#6b7280', bg: '#f3f4f6' };
          const date = run.createdAt ? new Date(run.createdAt).toLocaleString() : '';
          return (
            <div
              key={run.id}
              className="card"
              onClick={() => onActivate(run.id)}
              style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, transition: 'box-shadow 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = ''}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {run.folder}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {date}
                  {run.attachmentCount > 0 && ` · ${run.attachmentCount} image${run.attachmentCount !== 1 ? 's' : ''}`}
                  {run.billCount > 0 && ` · ${run.billCount} bill${run.billCount !== 1 ? 's' : ''} extracted`}
                </div>
              </div>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap',
                background: s.bg, color: s.color, fontWeight: 600,
              }}>
                {s.label}
              </span>
              <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 500, flexShrink: 0 }}>Continue →</span>
              <button
                className="btn btn-sm btn-ghost"
                style={{ flexShrink: 0, color: 'var(--muted)', padding: '2px 6px' }}
                onClick={e => handleDelete(e, run.id)}
                title="Delete this run"
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
