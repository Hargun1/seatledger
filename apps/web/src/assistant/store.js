import { assistantRequest, AssistantError } from './client.js';
import { validId } from '../discovery/model.js';

// Only opaque references and an unresolved draft live in this account-scoped
// tab journal. Transcript, prices and inventory authority stay on the server.
export function createAssistantStore({ userId, csrfToken, request = assistantRequest, storage = globalThis.sessionStorage, newId = () => crypto.randomUUID() }) {
  const storageKey = 'seatledger.assistant.v1.' + userId, listeners = new Set();
  let state = { phase: 'loading', conversation: null, error: null, pending: null, checked: false, busy: false }, journal, locked = false, epoch = 0, reopen = false;
  const publish = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const save = next => {
    try { storage.setItem(storageKey, JSON.stringify(next)); journal = next; }
    catch { throw new AssistantError('STORAGE_UNAVAILABLE'); }
  };
  function load() {
    try {
      const value = JSON.parse(storage.getItem(storageKey) || 'null');
      if (value && validId(value.creationKey) && (value.id === null || validId(value.id))
        && (value.pending === null || validId(value.pending.key) && ['message','confirm'].includes(value.pending.action)
          && Number.isInteger(value.pending.body?.revision) && (value.pending.action === 'message'
            ? typeof value.pending.body.message === 'string' && value.pending.body.message.length <= 1500
            : validId(value.pending.body.proposalId) && value.pending.body.confirmed === true))) journal = value;
      else save({ creationKey: newId(), id: null, pending: null });
    } catch { throw new AssistantError('STORAGE_UNAVAILABLE'); }
  }
  function accept(conversation) {
    let pending = journal.pending;
    if (pending && (pending.action === 'message' ? conversation.revision > pending.body.revision
      : conversation.hold?.proposalId === pending.body.proposalId || conversation.revision !== pending.body.revision)) pending = null;
    if (!pending && conversation.pending && conversation.pending.revision === conversation.revision)
      pending = { action: 'message', key: conversation.pending.requestKey, body: { message: conversation.pending.message, revision: conversation.pending.revision } };
    save({ ...journal, id: conversation.id, pending });
    publish({ phase: 'ready', conversation, pending, error: null, checked: true, observedAt: performance.now() });
  }
  async function perform(work) {
    if (locked) return; locked = true; const current = epoch; publish({ busy: true, error: null });
    try { await work(() => current === epoch); }
    catch (error) { if (current === epoch) publish({ phase: state.conversation ? 'ready' : 'error', error: error instanceof AssistantError ? error : new AssistantError('UNKNOWN'), pending: journal?.pending, checked: false,
      ...([401,403].includes(error.status) ? { conversation: null, phase: 'error' } : {}) }); }
    finally { locked = false; if (current === epoch) publish({ busy: false }); if (reopen) { reopen = false; open(); } }
  }
  const open = () => { if (locked) { reopen = true; return; } return perform(async live => {
    if (!journal) load();
    const status = await request('status'); if (!live()) return;
    if (!status.enabled) { publish({ phase: 'disabled' }); return; }
    const value = await request(journal.id ? 'read' : 'create', { id: journal.id, key: journal.creationKey, csrfToken });
    if (live()) accept(value);
  }); };
  const refresh = () => perform(async live => {
    if (!journal?.id) return;
    const value = await request('read', { id: journal.id }); if (live()) accept(value);
  });
  const executePending = async live => {
    const pending = journal.pending;
    try {
      const value = await request(pending.action, { id: journal.id, ...pending, csrfToken });
      if (live()) { save({ ...journal, pending: null }); accept(value); }
    } catch (error) {
      if (live() && [400,404,429].includes(error.status) || live() && error.status === 409 && error.code !== 'ASSISTANT_BUSY')
        save({ ...journal, pending: null });
      throw error;
    }
  };
  const send = message => perform(async live => {
    if (!state.conversation || journal.pending || state.conversation.busy || !message.trim() || message.trim().length > 1500) return;
    const pending = { action: 'message', key: newId(), body: { message: message.trim(), revision: state.conversation.revision } };
    save({ ...journal, pending }); publish({ pending, checked: false }); await executePending(live);
  });
  const confirm = proposal => perform(async live => {
    if (!state.conversation || journal.pending || state.conversation.busy || state.conversation.proposal?.id !== proposal.id || proposal.status !== 'READY') return;
    const pending = { action: 'confirm', key: newId(), body: { proposalId: proposal.id, revision: state.conversation.revision, confirmed: true } };
    save({ ...journal, pending }); publish({ pending, checked: false }); await executePending(live);
  });
  const retry = () => perform(async live => {
    if (!journal?.pending || !state.checked || state.conversation?.busy) return;
    publish({ checked: false }); await executePending(live);
  });
  const startNew = () => perform(async live => {
    if (state.conversation?.busy) return;
    save({ creationKey: newId(), id: null, pending: null }); publish({ conversation: null, pending: null, checked: false });
    const value = await request('create', { key: journal.creationKey, csrfToken }); if (live()) accept(value);
  });
  return { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    open, refresh, send, confirm, retry, startNew, cancel: () => { epoch++; } };
}
