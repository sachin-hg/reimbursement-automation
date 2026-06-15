import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api.js';
import { useSSE } from './useSSE.js';
import StepBar from './components/StepBar.jsx';
import StartForm from './components/StartForm.jsx';
import Step1Panel from './components/Step1Panel.jsx';
import Step2Panel from './components/Step2Panel.jsx';
import Step3Panel from './components/Step3Panel.jsx';
import Step4Panel from './components/Step4Panel.jsx';
import RunList from './components/RunList.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';

// Phases: 'start' | 'step1' | 'cropping' | 'step2' | 'extracting' | 'step3' | 'step4'

function navigate(path) {
  window.history.pushState({}, '', path);
}

export default function App() {
  const [phase, setPhase]   = useState('start');
  const [attachments, setAttachments] = useState([]);  // { id, filename, originalUrl }
  const [prepared, setPrepared]       = useState([]);  // { id, filename, originalUrl, croppedUrl }
  const [totalImages, setTotalImages] = useState(0);
  const [bills, setBills]     = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [extractTotal, setExtractTotal] = useState(0);
  const [submitResult, setSubmitResult] = useState(null);
  const [submitError, setSubmitError]   = useState('');
  const [submitLog, setSubmitLog] = useState([]);
  const [submitScreenshot, setSubmitScreenshot] = useState(null);
  const [submitPaused, setSubmitPaused] = useState(false);
  const [submitAwaitingConfirm, setSubmitAwaitingConfirm] = useState(null);
  const [runId, setRunId] = useState(null);
  const [removedIds, setRemovedIds] = useState([]);
  const [includedSkippedIds, setIncludedSkippedIds] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const step3SaveRef = useRef(null);

  // On mount: try to restore run from URL path or server state
  useEffect(() => {
    const match = window.location.pathname.match(/^\/run\/(run_[a-z0-9_]+)$/);
    if (match) {
      const id = match[1];
      api.activateRun(id).then(({ run }) => restoreRun(run)).catch(() => navigate('/'));
    } else {
      api.status().then(({ run }) => {
        if (!run) return;
        restoreRun(run);
      }).catch(() => {});
    }
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    function onPopState() {
      const match = window.location.pathname.match(/^\/run\/(run_[a-z0-9_]+)$/);
      if (match) {
        const id = match[1];
        api.activateRun(id).then(({ run }) => restoreRun(run)).catch(() => {});
      } else {
        handleReset();
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function restoreRun(run) {
    if (!run) return;
    if (run.id)          setRunId(run.id);
    if (run.attachments) setAttachments(run.attachments);
    if (run.prepared)    setPrepared(run.prepared);
    if (run.bills)       setBills(run.bills);
    if (run.skipped)     setSkipped(run.skipped);
    setRemovedIds(run.removedIds || []);
    setIncludedSkippedIds(run.includedSkippedIds || []);

    const s = run.status;
    if (s === 'loaded')      setPhase('step1');
    else if (s === 'cropping')    { setPhase('cropping');   setTotalImages(run.attachments?.length || 0); }
    else if (s === 'crop_done')   { setPhase('step2');      setTotalImages(run.prepared?.length || 0); }
    else if (s === 'extracting')  { setPhase('extracting'); setExtractTotal(run.prepared?.length || 0); }
    else if (s === 'extracted')   { setPhase('step3');      setExtractTotal((run.bills?.length || 0) + (run.skipped?.length || 0)); }
    else if (s === 'submitting')  setPhase('step4');
    else if (s === 'done' || s === 'error') {
      setPhase('step4');
      setSubmitResult(run.result);
      setSubmitError(run.error || '');
    }
  }

  // Keep api._runId in sync whenever React runId state changes.
  // This ensures all subsequent api calls are scoped to the active run,
  // and useSSE reconnects to the correct /api/events?runId= channel.
  useEffect(() => {
    api.setRunId(runId);
  }, [runId]);

  // SSE event handlers — scoped to the active runId (reconnects automatically on change)
  useSSE(runId, {
    state: ({ run }) => restoreRun(run),

    crop_progress: ({ id, filename, originalUrl, croppedUrl, done, total }) => {
      setPhase(p => p === 'cropping' ? 'cropping' : 'cropping');
      setTotalImages(total);
      setPrepared(prev => {
        if (prev.find(p => p.id === id)) return prev;
        return [...prev, { id, filename, originalUrl, croppedUrl, cropStatus: 'done' }];
      });
    },

    crop_error: ({ id, filename, originalUrl, done, total }) => {
      setTotalImages(total);
      setPrepared(prev => {
        if (prev.find(p => p.id === id)) return prev;
        return [...prev, { id, filename, originalUrl, croppedUrl: originalUrl, cropStatus: 'error' }];
      });
    },

    crop_complete: ({ prepared: allPrepared }) => {
      setPrepared(allPrepared);
      setTotalImages(allPrepared.length);
      setPhase('step2');
    },

    extract_progress: ({ total }) => {
      setExtractTotal(total);
    },

    // OCR phase: card appears immediately with raw OCR text, fields show loading
    ocr_result: ({ id, filename, croppedUrl, ocrText, ocrConfidence }) => {
      setPhase('step3');
      setBills(prev => {
        if (prev.find(b => b.id === id)) return prev;
        return [...prev, { id, filename, croppedUrl, ocrText, ocrConfidence: ocrConfidence ?? null,
          bill_no: null, bill_date: null, bill_amount: null, extracting: true }];
      });
    },

    // Claude phase: update existing card with structured data (or add fresh for LLM mode)
    extract_result: ({ id, type, bill_no, bill_date, bill_amount, croppedUrl, filename, error, ocrConfidence, ocrText }) => {
      if (type === 'bill') {
        setBills(prev => {
          const exists = prev.find(b => b.id === id);
          if (exists) {
            return prev.map(b => b.id === id
              ? { ...b, bill_no, bill_date, bill_amount, extracting: false }
              : b);
          }
          return [...prev, { id, filename, bill_no, bill_date, bill_amount, croppedUrl,
            ocrConfidence: ocrConfidence ?? null, ocrText: ocrText ?? null }];
        });
      } else {
        // Move from bills (OCR preview) to skipped
        setBills(prev => prev.filter(b => b.id !== id));
        setSkipped(prev => {
          if (prev.find(s => s.id === id)) return prev;
          return [...prev, { id, filename, croppedUrl, error: error || null,
            ocrConfidence: ocrConfidence ?? null, ocrText: ocrText ?? null }];
        });
      }
    },

    extract_complete: () => {
      // Clear extracting flags in case any extract_result events were missed over SSE,
      // and reset extractTotal so stillExtracting becomes false immediately.
      setBills(prev => prev.map(b => b.extracting ? { ...b, extracting: false } : b));
      setExtractTotal(0);
      setPhase('step3');
    },

    submit_start: () => {
      setPhase('step4');
      setSubmitLog([]);
      setSubmitScreenshot(null);
      setSubmitPaused(false);
      setSubmitAwaitingConfirm(null);
    },

    submit_progress: (entry) => {
      setSubmitLog(prev => {
        const idx = prev.findIndex(e => e.id === entry.id);
        const next = idx >= 0
          ? prev.map((e, i) => i === idx ? entry : e)
          : [...prev, entry];
        // When a bill fails, flip all that bill's prior entries to error status
        if (entry.step === 'bill_error' && entry.billIndex) {
          return next.map(e =>
            e.billIndex === entry.billIndex && e.id !== entry.id
              ? { ...e, status: 'error' }
              : e
          );
        }
        return next;
      });
    },

    submit_screenshot: ({ step, dataUrl }) => {
      setSubmitScreenshot({ step, dataUrl });
    },

    submit_paused: ({ paused }) => {
      setSubmitPaused(paused);
    },

    submit_awaiting_confirm: (data) => {
      setSubmitAwaitingConfirm(data);
    },

    submit_confirmed: () => {
      setSubmitAwaitingConfirm(null);
    },

    submit_complete: ({ result }) => {
      setSubmitResult(result);
      setSubmitError(result.success ? '' : result.error || '');
    },

    submit_error: ({ error }) => {
      setSubmitResult({ success: false });
      setSubmitError(error);
    },

    recrop_done: ({ id, croppedUrl }) => {
      setPrepared(prev => prev.map(p => p.id === id ? { ...p, croppedUrl } : p));
    },
    manualcrop_done: ({ id, croppedUrl }) => {
      setPrepared(prev => prev.map(p => p.id === id ? { ...p, croppedUrl } : p));
    },
    reextract_done: ({ id, bill_no, bill_date, bill_amount }) => {
      setBills(prev => prev.map(b => b.id === id ? { ...b, bill_no, bill_date, bill_amount } : b));
    },
  });

  function handleStarted({ runId: newRunId, attachments: atts }) {
    setRunId(newRunId || null);
    setAttachments(atts);
    setTotalImages(atts.length);
    setPrepared([]);
    setBills([]);
    setSkipped([]);
    setRemovedIds([]);
    setIncludedSkippedIds([]);
    setSubmitResult(null);
    setSubmitError('');
    setPhase('step1');
    if (newRunId) navigate(`/run/${newRunId}`);
  }

  function handleRetry() {
    setSubmitResult(null);
    setSubmitError('');
    setSubmitLog([]);
    setSubmitScreenshot(null);
    setSubmitPaused(false);
    setSubmitAwaitingConfirm(null);
    setPhase('step3');
  }

  async function handleKillSubmit() {
    try { await api.killSubmit(); } catch {}
  }

  async function handlePauseSubmit() {
    try { await api.pauseSubmit(); } catch {}
  }

  async function handleConfirmSubmit() {
    setSubmitAwaitingConfirm(null);
    try { await api.confirmSubmit(); } catch {}
  }

  async function handleRetryFailed(failedBills) {
    try { await api.retryFailed(failedBills); } catch (err) { console.error('Retry failed:', err); }
  }

  async function handleReset() {
    navigate('/');
    try { await api.resetRun(); } catch {}
    setPhase('start');
    setRunId(null);
    setAttachments([]);
    setPrepared([]);
    setBills([]);
    setSkipped([]);
    setRemovedIds([]);
    setIncludedSkippedIds([]);
    setSubmitResult(null);
    setSubmitError('');
    setTotalImages(0);
    setExtractTotal(0);
    setSubmitLog([]);
    setSubmitScreenshot(null);
    setSubmitPaused(false);
    setSubmitAwaitingConfirm(null);
  }

  function canNavigateTo(stepId) {
    if (phase === 'cropping' || phase === 'extracting') return false;
    // Map phases to numeric step positions
    const PHASE_NUM = { step1: 1, cropping: 2, step2: 2, extracting: 3, step3: 3, step4: 4 };
    const STEP_NUM  = { step1: 1, step2: 2, step3: 3, step4: 4 };
    const cur = PHASE_NUM[phase] || 0;
    const tgt = STEP_NUM[stepId];
    if (!tgt || tgt === cur) return false;
    if (tgt < cur) return true; // going back — always ok
    // Going forward: only one step ahead, and only if prerequisite data is ready
    if (tgt === cur + 1) {
      if (stepId === 'step2') return prepared.length > 0;
      if (stepId === 'step3') return bills.length > 0 || skipped.length > 0;
      if (stepId === 'step4') return !!submitResult; // only if already visited step4
    }
    return false;
  }

  async function handleStepNavigate(stepId) {
    if (!canNavigateTo(stepId)) return;
    if (phase === 'step3' && step3SaveRef.current) {
      try {
        const state = await step3SaveRef.current();
        setBills(state.bills);
        setSkipped(state.skipped);
        setRemovedIds(state.removedIds);
        setIncludedSkippedIds(state.includedSkippedIds);
      } catch {}
    }
    setPhase(stepId);
  }

  async function handleActivateRun(id) {
    try {
      const { run } = await api.activateRun(id);
      restoreRun(run);
      navigate(`/run/${id}`);
    } catch (err) {
      console.error('Failed to activate run', err);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>⛽ Petrol Bill Reimbursement</h1>
        <div className="spacer" />
        {phase !== 'start' && (
          <StepBar phase={phase} onNavigate={handleStepNavigate} canNavigate={canNavigateTo} />
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowSettings(true)}
          title="Configuration"
          style={{ fontSize: 16, padding: '4px 8px' }}
        >
          ⚙
        </button>
        {phase !== 'start' && (
          <button className="btn btn-ghost btn-sm" onClick={handleReset}>
            New Run
          </button>
        )}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <div className="main">
        {phase === 'start' && (
          <>
            <StartForm onStarted={handleStarted} />
            <RunList onActivate={handleActivateRun} />
          </>
        )}

        {phase === 'step1' && (
          <Step1Panel
            attachments={attachments}
            onCropStarted={() => { setPhase('cropping'); setPrepared([]); }}
            onReset={handleReset}
          />
        )}

        {(phase === 'cropping' || phase === 'step2') && (
          <Step2Panel
            prepared={prepared}
            totalImages={totalImages}
            onBack={phase === 'step2' ? () => setPhase('step1') : null}
            onExtractStarted={() => {
              setPhase('extracting');
              setBills([]);
              setSkipped([]);
              setRemovedIds([]);
              setIncludedSkippedIds([]);
            }}
          />
        )}

        {(phase === 'extracting' || phase === 'step3') && (
          <Step3Panel
            key={runId || 'default'}
            bills={bills}
            skipped={skipped}
            extractProgress={(bills.length + skipped.length)}
            extractTotal={extractTotal}
            initialRemovedIds={removedIds}
            initialIncludedIds={includedSkippedIds}
            onBack={phase === 'step3' ? () => setPhase('step2') : null}
            onSaveState={(state) => {
              setBills(state.bills);
              setSkipped(state.skipped);
              setRemovedIds(state.removedIds);
              setIncludedSkippedIds(state.includedSkippedIds);
            }}
            onRegisterSave={(fn) => { step3SaveRef.current = fn; }}
            onSubmitStarted={() => setPhase('step4')}
          />
        )}

        {phase === 'step4' && (
          <Step4Panel
            result={submitResult}
            error={submitError}
            log={submitLog}
            screenshot={submitScreenshot}
            paused={submitPaused}
            awaitingConfirm={submitAwaitingConfirm}
            onReset={handleReset}
            onRetry={handleRetry}
            onKill={handleKillSubmit}
            onPause={handlePauseSubmit}
            onConfirm={handleConfirmSubmit}
            onRetryFailed={handleRetryFailed}
          />
        )}
      </div>
    </div>
  );
}
