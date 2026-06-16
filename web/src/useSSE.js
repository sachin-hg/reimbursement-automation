import { useEffect, useRef } from 'react';
import { api } from './api.js';

export function useSSE(runId, handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const base = api.base;
    const url = runId
      ? `${base}/api/events?runId=${encodeURIComponent(runId)}`
      : `${base}/api/events`;

    // withCredentials: true sends the session cookie cross-origin
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const fn = handlersRef.current[data.type];
        if (fn) fn(data);
      } catch {}
    };

    return () => es.close();
  }, [runId]);  // reconnect whenever the active run changes
}
