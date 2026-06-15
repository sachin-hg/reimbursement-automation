export default function StepBar({ phase, onNavigate, canNavigate }) {
  const steps = [
    { id: 'step1', label: 'Load' },
    { id: 'step2', label: 'Crop' },
    { id: 'step3', label: 'Extract' },
    { id: 'step4', label: 'Submit' },
  ];

  const order = ['start', 'step1', 'cropping', 'step2', 'extracting', 'step3', 'step4'];
  const phaseIdx = order.indexOf(phase);

  function getStatus(stepId) {
    const stepOrder = { step1: 1, step2: 3, step3: 5, step4: 6 };
    const idx = stepOrder[stepId];
    if (phaseIdx > idx) return 'done';
    if (stepId === 'step2' && (phase === 'cropping' || phase === 'step2')) return 'active';
    if (stepId === 'step1' && phase === 'step1') return 'active';
    if (stepId === 'step3' && (phase === 'extracting' || phase === 'step3')) return 'active';
    if (stepId === 'step4' && phase === 'step4') return 'active';
    return 'pending';
  }

  return (
    <div className="stepbar">
      {steps.map((s, i) => {
        const status = getStatus(s.id);
        const clickable = canNavigate?.(s.id);
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <span className="stepbar-arrow" style={{ padding: '0 2px' }}>›</span>}
            <div
              className={`stepbar-item ${status}${clickable ? ' stepbar-clickable' : ''}`}
              onClick={clickable ? () => onNavigate?.(s.id) : undefined}
              title={clickable ? `Go to ${s.label}` : undefined}
            >
              <div className="stepbar-dot">
                {status === 'done' ? '✓' : i + 1}
              </div>
              <span>{s.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
