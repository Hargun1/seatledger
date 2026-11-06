const startupStatuses = new Set([502, 503, 504]);

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Only reads use startup recovery. A failed write must keep its original
// identity and be explicitly recovered by the existing command stores.
export async function readApi(path, { signal, credentials = 'same-origin', onRetry,
  fetchImpl = globalThis.fetch, budgetMs = 75000, attemptMs = 10000, retryMs = 2000,
  now = Date.now, wait = pause } = {}) {
  const deadline = now() + budgetMs;
  let response, timeout;
  while (now() < deadline) {
    signal?.throwIfAborted();
    try {
      response = await fetchImpl(path, { method: 'GET', credentials, cache: 'no-store',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(attemptMs, deadline - now())))]) });
      const spinningPage = response.status === 200 && response.headers.get('Content-Type')?.includes('text/html');
      if (!startupStatuses.has(response.status) && !spinningPage) return response;
    } catch (error) {
      if (signal?.aborted || error.name !== 'TimeoutError') throw error;
      timeout = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    onRetry?.();
    await wait(Math.min(retryMs, remaining), signal);
  }
  signal?.throwIfAborted();
  if (response) return response;
  throw timeout || new DOMException('The server did not become available.', 'TimeoutError');
}
