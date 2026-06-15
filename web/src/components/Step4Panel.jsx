export default function Step4Panel({ result, error, onReset }) {
  const success = result?.success;

  return (
    <div>
      <div className="section-header">
        <h2>Portal Submission</h2>
      </div>

      {!result && !error && (
        <div className="card" style={{ padding: 32 }}>
          <div className="loading-placeholder">
            <span className="spinner" />
            Submitting to Mynd Solutions portal…
          </div>
        </div>
      )}

      {(result || error) && (
        <>
          <div className={`submit-summary ${success ? '' : 'error'}`}>
            <span style={{ fontSize: 28 }}>{success ? '✅' : '❌'}</span>
            <div>
              <div className="bold">
                {success
                  ? `${result.count} bill${result.count !== 1 ? 's' : ''} submitted successfully`
                  : 'Submission failed'}
              </div>
              {error && <div className="small" style={{ marginTop: 2 }}>{error}</div>}
              {!success && result?.error && <div className="small" style={{ marginTop: 2 }}>{result.error}</div>}
            </div>
          </div>

          {!success && (
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
                Submit manually at:{' '}
                <strong>mypayroll2.myndsolution.com</strong>
                <br />
                Quick Links → Reimbursement Claim → Car Running Maintenance Allowance
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onReset}>
              ← Start New Run
            </button>
          </div>
        </>
      )}
    </div>
  );
}
