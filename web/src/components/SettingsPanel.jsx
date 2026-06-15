import { useState, useEffect } from 'react';
import { api } from '../api.js';

const STORAGE_KEY = 'reimbursement_config';
const SENSITIVE = new Set(['PORTAL_PASSWORD', 'ANTHROPIC_API_KEY']);

function loadStored() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

export default function SettingsPanel({ onClose }) {
  const [form, setForm]     = useState({
    ANTHROPIC_API_KEY: '',
    PORTAL_USERNAME: '',
    PORTAL_PASSWORD: '',
    HEADLESS: false,
    GMAIL_ADDRESS: '',
    SENDER_EMAIL: '',
    GMAIL_LABEL: '',
    LOOKBACK_DAYS: '',
  });
  // envVars: which keys have values in .env (booleans for sensitive, values for others)
  const [envVars, setEnvVars]   = useState({});
  const [saved, setSaved]       = useState(false);
  const [reveal, setReveal]     = useState({});

  // Session token state
  const [sessionToken, setSessionToken]       = useState('');
  const [restoreInput, setRestoreInput]       = useState('');
  const [tokenCopied, setTokenCopied]         = useState(false);
  const [tokenMsg, setTokenMsg]               = useState('');
  const [revealToken, setRevealToken]         = useState(false);

  useEffect(() => {
    // Load what the user previously saved in localStorage
    const stored = loadStored();
    setForm(prev => ({
      ...prev,
      PORTAL_USERNAME: stored.PORTAL_USERNAME || '',
      HEADLESS:        stored.HEADLESS === true,
      GMAIL_ADDRESS:   stored.GMAIL_ADDRESS   || '',
      SENDER_EMAIL:    stored.SENDER_EMAIL    || '',
      GMAIL_LABEL:     stored.GMAIL_LABEL     || '',
      LOOKBACK_DAYS:   stored.LOOKBACK_DAYS   != null ? String(stored.LOOKBACK_DAYS) : '',
      // Sensitive: never stored in readable form in state — user re-enters if they want to change
      ANTHROPIC_API_KEY: '',
      PORTAL_PASSWORD:   '',
    }));

    // Ask the server which env vars are already configured
    api.getConfig().then(setEnvVars).catch(() => {});

    // Load session token
    api.getToken().then(({ token }) => setSessionToken(token)).catch(() => {});
  }, []);

  function set(key, val) { setForm(f => ({ ...f, [key]: val })); setSaved(false); }

  function handleSave() {
    const stored = loadStored();
    const updated = { ...stored };

    // Non-sensitive fields: always write (empty = clear override)
    const NON_SENSITIVE = ['PORTAL_USERNAME', 'GMAIL_ADDRESS', 'SENDER_EMAIL', 'GMAIL_LABEL'];
    for (const k of NON_SENSITIVE) {
      if (form[k]) updated[k] = form[k];
      else delete updated[k];
    }
    updated.HEADLESS = form.HEADLESS;
    if (form.LOOKBACK_DAYS) updated.LOOKBACK_DAYS = parseInt(form.LOOKBACK_DAYS, 10);
    else delete updated.LOOKBACK_DAYS;

    // Sensitive fields: only overwrite if user typed something new
    if (form.ANTHROPIC_API_KEY) updated.ANTHROPIC_API_KEY = form.ANTHROPIC_API_KEY;
    if (form.PORTAL_PASSWORD)   updated.PORTAL_PASSWORD   = form.PORTAL_PASSWORD;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setSaved(true);
    setForm(f => ({ ...f, ANTHROPIC_API_KEY: '', PORTAL_PASSWORD: '' })); // clear after save
  }

  function handleClearAll() {
    if (!confirm('Clear all saved configuration from this browser?')) return;
    localStorage.removeItem(STORAGE_KEY);
    setForm({ ANTHROPIC_API_KEY: '', PORTAL_USERNAME: '', PORTAL_PASSWORD: '',
      HEADLESS: false, GMAIL_ADDRESS: '', SENDER_EMAIL: '', GMAIL_LABEL: '', LOOKBACK_DAYS: '' });
    setSaved(false);
  }

  async function handleCopyToken() {
    try {
      await navigator.clipboard.writeText(sessionToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      setTokenMsg('Copy failed — select the token text and copy manually.');
    }
  }

  async function handleNewToken() {
    if (!confirm(
      'Generate a new session?\n\n' +
      'You will lose access to your current runs in this browser unless you saved your token.\n\n' +
      'Continue?'
    )) return;
    try {
      const { token } = await api.newToken();
      setSessionToken(token);
      setRestoreInput('');
      setTokenMsg('New session created. Your old runs are gone from this browser (but still on disk — restore your old token to see them).');
      setTimeout(() => setTokenMsg(''), 5000);
    } catch (err) {
      setTokenMsg(`Error: ${err.message}`);
    }
  }

  async function handleRestoreToken() {
    const t = restoreInput.trim();
    if (!t) return;
    try {
      const { token } = await api.restoreToken(t);
      setSessionToken(token);
      setRestoreInput('');
      setTokenMsg('Token restored — reload the page to see your runs.');
    } catch (err) {
      setTokenMsg(`Error: ${err.message}`);
    }
  }

  // Placeholder text for a field: shows whether value comes from .env or localStorage
  function ph(key, fallback = '') {
    const stored = loadStored();
    if (SENSITIVE.has(key)) {
      if (stored[key]) return 'saved in browser (type to replace)';
      if (envVars[key]) return 'configured in .env';
      return 'not set';
    }
    if (stored[key]) return `saved: ${stored[key]}`;
    const envVal = envVars[key];
    if (envVal != null) return `from .env: ${envVal}`;
    return fallback || 'not set';
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        width: 520, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto',
        padding: '28px 32px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Configuration</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Settings are stored in this browser only. Credentials are used exclusively for the active run and
          are never persisted on the server. Falls back to server <code>.env</code> for any field left empty.
        </p>
        <p className="muted" style={{ fontSize: 12, marginBottom: 24, padding: '8px 10px', background: 'var(--surface-2, #f8f9fa)', borderRadius: 6, borderLeft: '3px solid var(--border)' }}>
          Privacy: Your portal credentials and personal details are used only to automate form submission
          in your browser session — they are never sent to any AI model. Only receipt images are shared
          with Claude for data extraction.
        </p>

        {/* ── Claude AI ─────────────────────────────────────────── */}
        <Section title="Claude AI">
          <Field label="Anthropic API Key">
            <PasswordInput
              value={form.ANTHROPIC_API_KEY}
              placeholder={ph('ANTHROPIC_API_KEY')}
              revealed={!!reveal.ANTHROPIC_API_KEY}
              onReveal={() => setReveal(r => ({ ...r, ANTHROPIC_API_KEY: !r.ANTHROPIC_API_KEY }))}
              onChange={v => set('ANTHROPIC_API_KEY', v)}
            />
          </Field>
        </Section>

        {/* ── Portal ──────────────────────────────────────────────── */}
        <Section title="Payroll Portal">
          <Field label="Username / Employee ID">
            <input className="input" value={form.PORTAL_USERNAME}
              placeholder={ph('PORTAL_USERNAME', 'e.g. 506394')}
              onChange={e => set('PORTAL_USERNAME', e.target.value)} />
          </Field>
          <Field label="Password">
            <PasswordInput
              value={form.PORTAL_PASSWORD}
              placeholder={ph('PORTAL_PASSWORD')}
              revealed={!!reveal.PORTAL_PASSWORD}
              onReveal={() => setReveal(r => ({ ...r, PORTAL_PASSWORD: !r.PORTAL_PASSWORD }))}
              onChange={v => set('PORTAL_PASSWORD', v)}
            />
          </Field>
          {envVars.isProd ? (
            <Field label="Headless browser">
              <span className="muted" style={{ fontSize: 12 }}>
                Always headless in production — not configurable.
              </span>
            </Field>
          ) : (
            <Field label="Headless browser" hint="Hide browser window during portal submission">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
                <input type="checkbox" checked={form.HEADLESS}
                  onChange={e => set('HEADLESS', e.target.checked)}
                  style={{ width: 15, height: 15 }} />
                Run headless (no browser window)
              </label>
            </Field>
          )}
        </Section>

        {/* ── Gmail ───────────────────────────────────────────────── */}
        <Section title="Gmail">
          <Field label="Gmail Address">
            <input className="input" type="email" value={form.GMAIL_ADDRESS}
              placeholder={ph('GMAIL_ADDRESS', 'you@gmail.com')}
              onChange={e => set('GMAIL_ADDRESS', e.target.value)} />
          </Field>
          <Field label="Sender Email" hint="Who sends the petrol bill images">
            <input className="input" type="email" value={form.SENDER_EMAIL}
              placeholder={ph('SENDER_EMAIL', 'sender@example.com')}
              onChange={e => set('SENDER_EMAIL', e.target.value)} />
          </Field>
          <Field label="Gmail Label">
            <input className="input" value={form.GMAIL_LABEL}
              placeholder={ph('GMAIL_LABEL', 'Petrol Bill')}
              onChange={e => set('GMAIL_LABEL', e.target.value)} />
          </Field>
          <Field label="Lookback Days" hint="How many days back to search Gmail">
            <input className="input" type="number" min="1" max="90"
              value={form.LOOKBACK_DAYS}
              placeholder={ph('LOOKBACK_DAYS', '2')}
              onChange={e => set('LOOKBACK_DAYS', e.target.value)}
              style={{ width: 80 }} />
          </Field>
        </Section>

        {/* ── Session / Identity ───────────────────────────────────── */}
        <Section title="Session">
          <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
            Your session token identifies your runs. Save it to restore access later, or enter a saved token to switch sessions.
          </p>

          {/* Token display */}
          <Field label="Your token">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="input"
                readOnly
                value={sessionToken}
                type={revealToken ? 'text' : 'password'}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevealToken(r => !r)}
                title={revealToken ? 'Hide' : 'Show'}>
                {revealToken ? '🙈' : '👁'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleCopyToken}
                title="Copy token" style={{ flexShrink: 0 }}>
                {tokenCopied ? '✓' : '📋'}
              </button>
            </div>
          </Field>

          {/* Restore saved token */}
          <Field label="Restore saved token">
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                value={restoreInput}
                placeholder="Paste your saved token here"
                onChange={e => setRestoreInput(e.target.value)}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleRestoreToken}
                disabled={!restoreInput.trim()}
                style={{ flexShrink: 0 }}
              >
                Restore
              </button>
            </div>
          </Field>

          {tokenMsg && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>{tokenMsg}</p>
          )}

          <button type="button" className="btn btn-ghost btn-sm" onClick={handleNewToken}
            style={{ alignSelf: 'flex-start', color: 'var(--red)', marginTop: 4 }}>
            New session →
          </button>
        </Section>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
          <button className="btn btn-ghost btn-sm" onClick={handleClearAll}
            style={{ color: 'var(--red)', fontSize: 12 }}>
            Clear all saved values
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className={`btn ${saved ? 'btn-success' : 'btn-primary'}`}
              onClick={handleSave}
              style={{ minWidth: 90 }}
            >
              {saved ? '✓ Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--muted)', marginBottom: 12, paddingBottom: 6,
        borderBottom: '1px solid var(--border)',
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 13, fontWeight: 500 }}>
        {label}
        {hint && <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

function PasswordInput({ value, placeholder, revealed, onReveal, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="input" type={revealed ? 'text' : 'password'}
        value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} style={{ flex: 1 }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReveal}
        title={revealed ? 'Hide' : 'Show'} style={{ flexShrink: 0 }}>
        {revealed ? '🙈' : '👁'}
      </button>
    </div>
  );
}
