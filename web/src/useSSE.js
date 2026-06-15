import { useEffect, useRef } from 'react';

export function useSSE(runId, handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const url = runId
      ? `/api/events?runId=${encodeURIComponent(runId)}`
      : '/api/events';
    const es = new EventSource(url);

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
