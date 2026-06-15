import { useEffect, useRef } from 'react';

export function useSSE(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const fn = handlersRef.current[data.type];
        if (fn) fn(data);
      } catch {}
    };

    return () => es.close();
  }, []);
}
