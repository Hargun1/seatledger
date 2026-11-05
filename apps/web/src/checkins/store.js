import { CheckinError, credentialId, createScanJournal, checkinRequest } from './client.js';

// Credentials live only in an explicit request's closure, never in this snapshot/journal.
export function createCheckinStore({ userId, organizationId, showId, csrfToken, storage, request = checkinRequest,
  uuid = () => globalThis.crypto.randomUUID(), onAuthRequired = () => {} }) {
  const scope = { userId, organizationId, showId }, journal = createScanJournal(scope, storage);
  let state = { stage: 'loading', pending: null, receipt: null, error: '' }, live = false, locked = false, freshVisible = false, version = 0, read;
  const listeners = new Set();
  const set = changes => { state = { ...state, ...changes }; for (const fn of listeners) fn(); };
  const current = v => live && v === version;
  function access(error) { if (error.status === 401) Promise.resolve(onAuthRequired()).catch(() => {}); }
  function accept(value, command) {
    if (value.admissionGranted && !freshVisible) value = { ...value, admissionGranted: false, status: 'ALREADY_RECORDED' };
    try { journal.clear(); set({ stage: 'recorded', pending: null, receipt: value, error: '' }); }
    catch (error) { set({ stage: 'recorded', pending: command, receipt: { ...value, admissionGranted: false, status: 'ALREADY_RECORDED' }, error: error.message }); }
  }
  async function recover() {
    if (!live || locked || !state.pending) return;
    const command = state.pending, v = ++version; read?.abort(); read = new AbortController();
    set({ stage: 'recovering', receipt: null, error: '' });
    try {
      const value = await request({ command, recover: true, signal: read.signal });
      if (current(v)) accept(value, command);
    } catch (error) {
      if (current(v)) { set({ stage: 'pending', receipt: null, error: error.status === 404
        ? 'No receipt is visible yet. That does not prove the earlier scan failed. Check again or retry this original request.' : new CheckinError(error.code).message }); access(error); }
    }
  }
  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state,
    start() {
      live = true; ++version;
      try { const pending = journal.read(); set({ stage: pending ? 'pending' : 'ready', pending, receipt: null, error: '' }); if (pending) void recover(); }
      catch (error) { set({ stage: 'blocked', pending: null, receipt: null, error: error.message }); }
    },
    cancel() { live = false; ++version; read?.abort(); }, recover,
    async submit(credential) {
      if (!live || locked || !['ready', 'pending'].includes(state.stage)) return;
      const ticketId = credentialId(credential);
      if (!ticketId) { set({ error: new CheckinError('INVALID_REQUEST').message }); return; }
      let command, fresh = false;
      try {
        command = journal.read();
        if (command && command.ticketId !== ticketId) throw new CheckinError('WRONG_TICKET');
        if (!command) { command = { ...scope, requestKey: uuid(), ticketId }; journal.save(command); fresh = true; }
      } catch (error) { set({ stage: error.code === 'WRONG_TICKET' ? 'pending' : 'blocked', error: error.message }); return; }
      locked = true; freshVisible = true; read?.abort(); const v = ++version;
      set({ stage: 'submitting', pending: command, receipt: null, error: '' });
      try {
        const value = await request({ command, credential, csrfToken });
        if (current(v)) accept(value, command);
      } catch (error) {
        if (current(v)) {
          // A later rejection cannot disprove an earlier unknown commit.
          if (fresh && error.definite) {
            try { journal.clear(); set({ stage: 'ready', pending: null, receipt: null, error: error.message }); }
            catch (storageError) { set({ stage: 'blocked', receipt: null, error: storageError.message }); }
          } else set({ stage: 'pending', receipt: null, error: new CheckinError(error.code).message });
          access(error);
        }
      } finally { locked = false; }
    },
    next() { if (live && !locked && !state.pending && state.stage === 'recorded') set({ stage: 'ready', receipt: null, error: '' }); },
    leave() { freshVisible = false; if (state.receipt?.admissionGranted) set({ receipt: { ...state.receipt, admissionGranted: false, status: 'ALREADY_RECORDED' } }); }
  };
}
