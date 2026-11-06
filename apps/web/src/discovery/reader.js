// A public GET reader: no sessions, writes or cached stale success.
// The hook creates a new reader for each route/filter key, so a new scope has
// a fresh loading snapshot even before React runs effect cleanup.
export function createPublicReader(load) {
  let state = { status: 'loading', data: null, error: null }, generation = 0, controller;
  const listeners = new Set();
  const publish = next => { state = next; for (const notify of listeners) notify(); };
  return {
    getSnapshot: () => state,
    subscribe: notify => { listeners.add(notify); return () => listeners.delete(notify); },
    async refresh() {
      const own = ++generation; controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      publish({ status: 'loading', data: null, error: null });
      try {
        const data = await load(signal, () => {
          if (own === generation && !signal.aborted) publish({ status: 'loading', data: null, error: null, waking: true });
        });
        if (own === generation && !signal.aborted) publish({ status: 'ready', data, error: null });
      } catch (error) {
        if (own === generation && !signal.aborted) publish({ status: 'error', data: null, error });
      }
    },
    cancel() { ++generation; controller?.abort(); }
  };
}
