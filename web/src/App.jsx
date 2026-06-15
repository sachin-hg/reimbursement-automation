import { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';
import { useSSE } from './useSSE.js';
import StepBar from './components/StepBar.jsx';
import StartForm from './components/StartForm.jsx';
import Step1Panel from './components/Step1Panel.jsx';
import Step2Panel from './components/Step2Panel.jsx';
import Step3Panel from './components/Step3Panel.jsx';
import Step4Panel from './components/Step4Panel.jsx';

// Phases: 'start' | 'step1' | 'cropping' | 'step2' | 'extracting' | 'step3' | 'step4'

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

  // On mount: try to recover in-progress run from server
  useEffect(() => {
    api.status().then(({ run }) => {
      if (!run) return;
      restoreRun(run);
    }).catch(() => {});
  }, []);

  function restoreRun(run) {
    if (!run) return;
    if (run.attachments) setAttachments(run.attachments);
    if (run.prepared)    setPrepared(run.prepared);
    if (run.bills)       setBills(run.bills);
    if (run.skipped)     setSkipped(run.skipped);

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

  // SSE event handlers
  useSSE({
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

    extract_result: ({ id, type, bill_no, bill_date, bill_amount, croppedUrl, filename, error }) => {
      if (type === 'bill') {
        setBills(prev => {
          if (prev.find(b => b.id === id)) return prev;
          return [...prev, { id, filename, bill_no, bill_date, bill_amount, croppedUrl }];
        });
      } else {
        setSkipped(prev => {
          if (prev.find(s => s.id === id)) return prev;
          return [...prev, { id, filename, croppedUrl, error: error || null }];
        });
      }
    },

    extract_complete: ({ bills: b, skipped: s }) => {
      setBills(b);
      setSkipped(s);
      setPhase('step3');
    },

    submit_start: () => setPhase('step4'),

    submit_complete: ({ result }) => {
      setSubmitResult(result);
      setSubmitError(result.success ? '' : result.error || '');
    },

    submit_error: ({ error }) => {
      setSubmitResult({ success: false });
      setSubmitError(error);
    },
  });

  function handleStarted({ attachments: atts }) {
    setAttachments(atts);
    setTotalImages(atts.length);
    setPrepared([]);
    setBills([]);
    setSkipped([]);
    setSubmitResult(null);
    setSubmitError('');
    setPhase('step1');
  }

  async function handleReset() {
    try { await api.resetRun(); } catch {}
    setPhase('start');
    setAttachments([]);
    setPrepared([]);
    setBills([]);
    setSkipped([]);
    setSubmitResult(null);
    setSubmitError('');
    setTotalImages(0);
    setExtractTotal(0);
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>⛽ Petrol Bill Reimbursement</h1>
        <div className="spacer" />
        {phase !== 'start' && <StepBar phase={phase} />}
        {phase !== 'start' && (
          <button className="btn btn-ghost btn-sm" onClick={handleReset}>
            New Run
          </button>
        )}
      </div>

      <div className="main">
        {phase === 'start' && (
          <StartForm onStarted={handleStarted} />
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
            onExtractStarted={() => { setPhase('extracting'); setBills([]); setSkipped([]); }}
          />
        )}

        {(phase === 'extracting' || phase === 'step3') && (
          <Step3Panel
            bills={bills}
            skipped={skipped}
            extractProgress={(bills.length + skipped.length)}
            extractTotal={extractTotal}
            onSubmitStarted={() => setPhase('step4')}
          />
        )}

        {phase === 'step4' && (
          <Step4Panel
            result={submitResult}
            error={submitError}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  );
}
