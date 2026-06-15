import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

function isImage(file) {
  return IMAGE_EXTS.has('.' + file.name.split('.').pop().toLowerCase());
}

export default function StartForm({ onStarted }) {
  const inputRef = useRef(null);
  const [files, setFiles]       = useState([]);
  const [folderName, setFolderName] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [dragging, setDragging] = useState(false);

  function handleFiles(fileList) {
    const all = Array.from(fileList);
    const images = all.filter(isImage);
    if (!images.length) { setError('No image files found in the selected folder.'); return; }

    // Derive folder name from webkitRelativePath of first file
    const rel = all[0]?.webkitRelativePath || '';
    const name = rel ? rel.split('/')[0] : 'Selected folder';

    setFiles(images);
    setFolderName(name);
    setError('');
  }

  function onInputChange(e) {
    handleFiles(e.target.files);
  }

  function onDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  function onDragLeave() { setDragging(false); }

  async function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const items = e.dataTransfer.items;
    if (!items) return;

    // Collect files from dropped folder via DataTransferItemList
    const collected = [];
    const promises = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) promises.push(collectEntries(entry, collected));
    }
    await Promise.all(promises);
    if (collected.length) handleFiles(collected);
  }

  async function handleStart() {
    if (!files.length) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.upload(files);
      onStarted(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const thumbs = files.slice(0, 5);

  return (
    <div className="start-form" style={{ marginTop: 60 }}>
      <div className="card" style={{ padding: 32 }}>
        <h2 style={{ marginBottom: 6 }}>Petrol Bill Reimbursement</h2>
        <p className="muted" style={{ marginBottom: 28, fontSize: 14 }}>
          Select a folder containing petrol bill images. Claude will crop, extract, and submit each bill.
        </p>

        {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

        {/* Hidden file input — webkitdirectory via ref */}
        <input
          ref={el => {
            inputRef.current = el;
            if (el) el.webkitdirectory = true;
          }}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onInputChange}
        />

        {/* Drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${dragging ? 'var(--accent)' : files.length ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '28px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.15s',
            background: dragging ? '#eff6ff' : files.length ? 'var(--green-bg)' : 'var(--bg)',
            userSelect: 'none',
          }}
        >
          {files.length === 0 ? (
            <>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📁</div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                Click to select a folder
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                or drag &amp; drop a folder here
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>{folderName}</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
                {files.length} image{files.length !== 1 ? 's' : ''} — click to change
              </div>

              {/* Mini preview strip */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
                {thumbs.map((f, i) => (
                  <ImagePreview key={i} file={f} />
                ))}
                {files.length > 5 && (
                  <div style={{
                    width: 52, height: 52, borderRadius: 6, background: '#e2e8f0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 600, color: 'var(--muted)',
                  }}>
                    +{files.length - 5}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <button
          className="btn btn-primary btn-lg"
          style={{ marginTop: 20, width: '100%' }}
          onClick={handleStart}
          disabled={!files.length || loading}
        >
          {loading
            ? <><span className="spinner" /> Uploading {files.length} images…</>
            : files.length
              ? `→ Process ${files.length} Image${files.length !== 1 ? 's' : ''}`
              : 'Select a folder to begin'}
        </button>
      </div>
    </div>
  );
}

// Small inline preview that reads from File object
function ImagePreview({ file }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = e => setUrl(e.target.result);
    reader.readAsDataURL(file);
  }, [file]);

  return (
    <div style={{
      width: 52, height: 52, borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0,
    }}>
      {url && <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
    </div>
  );
}

// Recursively collect files from a dropped folder entry
async function collectEntries(entry, out) {
  if (entry.isFile) {
    await new Promise(resolve => entry.file(f => { out.push(f); resolve(); }));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    await new Promise(resolve => {
      reader.readEntries(async entries => {
        for (const e of entries) await collectEntries(e, out);
        resolve();
      });
    });
  }
}
