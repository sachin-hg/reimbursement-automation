import { useState } from 'react';
import { api } from '../api.js';

export default function Step1Panel({ attachments, onCropStarted, onReset }) {
  const [loading, setLoading] = useState(false);

  async function handleCrop() {
    setLoading(true);
    try {
      await api.crop();
      onCropStarted();
    } catch (err) {
      alert(err.message);
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h2>Images Loaded</h2>
          <p className="muted" style={{ marginTop: 2 }}>{attachments.length} image{attachments.length !== 1 ? 's' : ''} ready for cropping</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onReset}>Start Over</button>
      </div>

      <div className="card">
        <div className="images-grid" style={{ padding: 12 }}>
          {attachments.map(a => (
            <div key={a.id}>
              <div className="image-thumb">
                <img src={a.originalUrl} alt={a.filename} loading="lazy" />
              </div>
              <div className="image-thumb-name" title={a.filename}>{a.filename}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="sticky-footer">
        <span className="muted">{attachments.length} image{attachments.length !== 1 ? 's' : ''} — auto-crop will detect each receipt boundary</span>
        <button
          className="btn btn-primary btn-lg"
          onClick={handleCrop}
          disabled={loading}
        >
          {loading
            ? <><span className="spinner" /> Starting…</>
            : `→ Crop All ${attachments.length} Images`}
        </button>
      </div>
    </div>
  );
}
