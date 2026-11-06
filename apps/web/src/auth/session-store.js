import { authRequest, AuthError } from './client.js';

// One store per mounted provider. Cookies stay with the browser; session/CSRF
// data stays in memory. Epochs stop an older GET from undoing a newer mutation.
export function createSessionStore(request = authRequest) {
  let state = { status: 'loading', session: null, busy: false, notice: '', error: '', waking: false };
  let epoch = 0, reading, mutating = false;
  const listeners = new Set();
  const publish = update => { state = { ...state, ...update }; for (const listener of listeners) listener(); };
  const cancelRead = () => { epoch++; reading?.abort(); reading = undefined; };

  async function refresh({ background = false } = {}) {
    if (mutating) return;
    const wasAuthenticated = state.status === 'authenticated';
    cancelRead();
    const current = epoch, controller = new AbortController();
    reading = controller;
    if (!background) publish({ status: 'loading', session: null, error: '', waking: false });
    try {
      const session = await request('session', { signal: controller.signal, onRetry: () => {
        if (current === epoch && !controller.signal.aborted) publish({ status: 'loading', session: null, waking: true, error: '' });
      } });
      if (current === epoch) publish({ status: 'authenticated', session, error: '', notice: '', waking: false });
    } catch (error) {
      if (current !== epoch || controller.signal.aborted) return;
      if (error.status === 401) publish({ status: 'anonymous', session: null, error: '', waking: false,
        notice: wasAuthenticated ? 'Your session has ended. Please sign in again.' : state.notice });
      else publish({ status: 'error', session: null, waking: false, error: 'We cannot check your session right now. Your sign-in status is unknown.' });
    } finally { if (current === epoch) reading = undefined; }
  }

  async function mutate(action, body) {
    if (mutating) throw new AuthError('AUTH_BUSY', 409);
    mutating = true;
    cancelRead();
    const current = epoch;
    publish({ busy: true, error: '', waking: false });
    const signingOut = action === 'logout' || action === 'logout-all';
    try {
      const session = await request(action, { body, csrfToken: signingOut ? state.session?.csrfToken : undefined });
      if (current === epoch) publish(signingOut
        ? { status: 'anonymous', session: null, notice: action === 'logout-all' ? 'Signed out on all devices.' : 'You have signed out.' }
        : { status: 'authenticated', session, notice: '' });
    } catch (error) {
      if (current === epoch) {
        if (signingOut && error.status === 401) {
          publish({ status: 'anonymous', session: null, notice: 'Your session has ended. Please sign in again.' });
          return;
        }
        if (!error.status || error.status >= 500 || (signingOut && error.status === 403)) {
          publish({ status: 'error', session: null,
            error: 'We could not confirm that change. Check your session before trying again.' });
        }
      }
      throw error;
    } finally {
      mutating = false;
      if (current === epoch) publish({ busy: false });
    }
  }

  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    refresh, mutate, cancelRead
  };
}
