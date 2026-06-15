const isProd = process.env.NODE_ENV === 'production';

// Merge user-supplied overrides with .env / process.env values.
// Override wins when non-empty; env fallback applies otherwise.
// Called at operation time (not module load) so live server config changes take effect.
function resolveConfig(overrides = {}) {
  function pick(key, fallback = '') {
    const v = overrides[key];
    return (v !== undefined && v !== null && v !== '') ? v : (process.env[key] || fallback);
  }

  // Production always runs headless — client override is ignored.
  const headlessOverride = overrides.HEADLESS;
  const headless = isProd ? true :
    headlessOverride === true  || headlessOverride === 'true'  ? true  :
    headlessOverride === false || headlessOverride === 'false' ? false  :
    process.env.HEADLESS !== 'false';

  return {
    ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY'),
    PORTAL_USERNAME:   pick('PORTAL_USERNAME'),
    PORTAL_PASSWORD:   pick('PORTAL_PASSWORD'),
    HEADLESS:          headless,
    GMAIL_ADDRESS:     pick('GMAIL_ADDRESS'),
    SENDER_EMAIL:      pick('SENDER_EMAIL'),
    GMAIL_LABEL:       pick('GMAIL_LABEL', 'Petrol Bill'),
    LOOKBACK_DAYS:     parseInt(overrides.LOOKBACK_DAYS || process.env.LOOKBACK_DAYS || '2', 10),
  };
}

module.exports = { resolveConfig, isProd };
