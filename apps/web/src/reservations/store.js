import { discoveryRequest } from '../discovery/client.js';
import { BookingError, reservationRequest, readAllCurrent } from './client.js';
import { createRequestJournal } from './journal.js';

export function createBookingStore({ userId, eventId, showId, getCsrf, api = reservationRequest,
  recover = readAllCurrent, loadMap = signal => discoveryRequest('seats', { eventId, showId, signal }),
  journal = createRequestJournal(userId, showId), newKey = () => crypto.randomUUID(), clock = () => performance.now() }) {
  let pending = null, storageError = null;
  try { pending = journal.read(); } catch (error) { storageError = error; }
  let state = { status: 'loading', map: null, mapError: null, holds: [], holdsError: null, asOf: null, observedAt: 0,
    selected: [], pending, requestState: pending ? 'uncertain' : 'idle', feedback: '', error: storageError, storageError: Boolean(storageError), conflicts: [] };
  let generation = 0, readVersion = 0, reading, writeController, writing = false, writeVersion = 0;
  const listeners = new Set(), publish = patch => { state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const cancelRead = () => { ++readVersion; reading?.abort(); };
  async function refresh() {
    if (writing) return;
    cancelRead(); const own = readVersion, scope = generation, controller = new AbortController(), observedAt = clock(); reading = controller;
    publish({ status: 'loading', map: null, holds: [], asOf: null, selected: [], mapError: null, holdsError: null });
    const results = await Promise.allSettled([loadMap(controller.signal), recover({ userId, showId, signal: controller.signal })]);
    if (own !== readVersion || scope !== generation || controller.signal.aborted) return;
    const [map, holds] = results;
    publish({ status: 'ready', map: map.status === 'fulfilled' ? map.value : null, mapError: map.status === 'rejected' ? map.reason : null,
      holds: holds.status === 'fulfilled' ? holds.value.reservations : [], holdsError: holds.status === 'rejected' ? holds.reason : null,
      asOf: holds.status === 'fulfilled' ? holds.value.asOf : null, observedAt });
  }
  function select(id) {
    if (writing || state.pending || state.storageError || state.status !== 'ready' || !state.map || state.holdsError) return;
    const seat = state.map.seats.find(s => s.id === id);
    if (!seat || seat.state === 'BOOKED' || state.holds.some(h => h.items.some(item => item.id === id))) return;
    const selected = state.selected.includes(id) ? state.selected.filter(s => s !== id) : [...state.selected, id].sort();
    if (selected.length > 8) { publish({ feedback: 'Choose up to eight seats in one hold.' }); return; }
    if (new Set(state.map.seats.filter(s => selected.includes(s.id)).map(s => s.currency)).size > 1) { publish({ feedback: 'Choose seats priced in the same currency.' }); return; }
    publish({ selected, feedback: '', conflicts: [] });
  }
  async function dispatch(command, uncertain, closeOnly = false) {
    if (writing) return;
    writing = true; const own = ++writeVersion, scope = generation; cancelRead(); writeController = new AbortController();
    publish({ pending: command, requestState: 'sending', error: null, feedback: '' });
    try {
      const result = await api(closeOnly ? 'resolve' : command.kind, { userId, showId, command, csrfToken: getCsrf(), signal: writeController.signal });
      if (scope !== generation) return;
      journal.clear();
      publish({ pending: null, requestState: 'idle', selected: [], conflicts: [], storageError: false,
        feedback: result?.error === 'REQUEST_CLOSED' ? 'That saved request is closed and cannot run later. Existing holds have not been released.'
          : closeOnly ? 'That saved request already completed. Your current holds have been checked; no hold was released by this check.'
            : command.kind === 'create' ? 'Request recorded. Your current live holds are checked below; a replay does not renew the deadline.' : 'Release recorded. Your current holds and availability have been refreshed.' });
      writing = false; await refresh();
    } catch (error) {
      if (scope !== generation) return;
      const knownRejection = error instanceof BookingError && !error.uncertain && !uncertain && error.code !== 'STORAGE_UNAVAILABLE';
      if (knownRejection) {
        try { journal.clear(); }
        catch (failure) { publish({ requestState: 'uncertain', storageError: true, error: failure }); return; }
        publish({ pending: null, requestState: 'idle', selected: [], feedback: error.message, error: null, conflicts: error.unavailableSeatIds });
        writing = false; await refresh();
      } else publish({ requestState: 'uncertain', error, storageError: error.code === 'STORAGE_UNAVAILABLE' || state.storageError,
        feedback: 'The original request is still unconfirmed. Retry this same request; checking current holds does not cancel it.' });
    } finally { if (own === writeVersion) { writing = false; if (scope === generation && state.requestState === 'sending') publish({ requestState: 'uncertain' }); } }
  }
  function start(kind, reservationId) {
    if (writing || state.pending || state.storageError || state.status !== 'ready' || state.holdsError) return;
    if (kind === 'create' && (!state.map || state.selected.length < 1 || state.selected.length > 8)) return;
    if (kind === 'release' && !state.holds.some(h => h.id === reservationId)) return;
    let command;
    try { command = { kind, userId, showId, key: newKey(), ...(kind === 'create' ? { seatIds: [...state.selected] } : { reservationId }) }; journal.save(command); }
    catch (error) { publish({ storageError: true, error }); return; } // Never send without a saved reference.
    return dispatch(command, false);
  }
  function resume(closeOnly = false) {
    if (!state.pending || writing) return;
    try { journal.save(state.pending); } catch (error) { publish({ storageError: true, error }); return; }
    return dispatch(state.pending, true, closeOnly);
  }
  return { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, refresh, select,
    hold: () => start('create'), release: id => start('release', id), retry: () => resume(), resolve: () => resume(true),
    cancel() { ++generation; ++writeVersion; cancelRead(); writeController?.abort(); writing = false;
      publish({ requestState: state.pending ? 'uncertain' : 'idle' }); } };
}
