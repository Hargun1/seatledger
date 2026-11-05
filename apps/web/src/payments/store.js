import { checkoutRequest, readPaymentHistory, CheckoutError } from './client.js';
import { createPaymentJournal } from './journal.js';

export function createCheckoutStore({ userId, showId, reservationId, getCsrf, api = checkoutRequest, history = readPaymentHistory,
  journal = createPaymentJournal(userId, showId, reservationId), newKey = () => crypto.randomUUID() }) {
  let pending = null, error = null;
  try { pending = journal.read(); } catch (failure) { error = failure; }
  let state = { status: 'loading', agreement: null, payments: [], pending, requestState: pending ? 'uncertain' : 'idle',
    storageError: Boolean(error), error, notice: '' };
  let generation = 0, readVersion = 0, writeVersion = 0, reading, sending, writing = false;
  const listeners = new Set(), publish = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const scope = { userId, showId, reservationId };
  const cancelRead = () => { ++readVersion; reading?.abort(); };
  async function refresh() {
    if (writing) return;
    cancelRead(); const own = readVersion, epoch = generation, controller = new AbortController(); reading = controller;
    publish({ status: 'loading', agreement: null, payments: [], error: null });
    try {
      const agreement = await api('agreement', { ...scope, signal: controller.signal });
      const payments = await history({ ...scope, agreement, signal: controller.signal });
      if (own !== readVersion || epoch !== generation || controller.signal.aborted) return;
      publish({ status: 'ready', agreement, payments, error: null });
    } catch (failure) {
      if (own === readVersion && epoch === generation && !controller.signal.aborted) publish({ status: 'error', agreement: null, payments: [], error: failure });
    }
  }
  async function dispatch(command, wasUncertain, resolve = false) {
    if (writing) return;
    writing = true; cancelRead(); const epoch = generation, own = ++writeVersion; sending = new AbortController();
    publish({ pending: command, requestState: 'sending', error: null, notice: '' });
    try {
      // Never infer current payment state from a saved POST replay. GET after it.
      const result = await api(resolve ? 'resolve' : 'start', { ...scope, command, agreement: state.agreement || undefined, csrfToken: getCsrf(), signal: sending.signal });
      if (epoch !== generation) return;
      journal.clear(); publish({ pending: null, requestState: 'idle', storageError: false,
        notice: result.error === 'REQUEST_CLOSED' ? 'That original request is closed. Any existing payment is shown below.'
          : 'Your request is recorded. Checking the current payment outcome.' });
      writing = false; await refresh();
    } catch (failure) {
      if (epoch !== generation) return;
      const known = failure instanceof CheckoutError && !failure.uncertain && !wasUncertain && failure.code !== 'STORAGE_UNAVAILABLE';
      if (known) {
        try { journal.clear(); } catch (storageFailure) { publish({ requestState: 'uncertain', storageError: true, error: storageFailure }); return; }
        publish({ pending: null, requestState: 'idle', notice: failure.message }); writing = false; await refresh();
      } else publish({ requestState: 'uncertain', error: failure, storageError: state.storageError || failure.code === 'STORAGE_UNAVAILABLE',
        notice: 'Keep this original request. An empty payment list does not prove it failed.' });
    } finally { if (own === writeVersion) { writing = false; if (epoch === generation && state.requestState === 'sending') publish({ requestState: 'uncertain' }); } }
  }
  function start() {
    if (writing || state.pending || state.storageError || state.status !== 'ready' || state.payments.length || state.agreement?.effectiveStatus !== 'ACTIVE') return;
    let command; try { command = { ...scope, key: newKey() }; journal.save(command); }
    catch (failure) { publish({ storageError: true, error: failure }); return; }
    return dispatch(command, false);
  }
  function resume(resolve = false) {
    if (writing || !state.pending) return;
    try { journal.save(state.pending); } catch (failure) { publish({ storageError: true, error: failure }); return; }
    return dispatch(state.pending, true, resolve);
  }
  return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state, refresh, start,
    retry: () => resume(), resolve: () => resume(true),
    cancel() { ++generation; ++writeVersion; cancelRead(); sending?.abort(); writing = false; publish({ requestState: state.pending ? 'uncertain' : 'idle' }); } };
}
