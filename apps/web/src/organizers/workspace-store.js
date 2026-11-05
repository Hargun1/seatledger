import { WorkspaceError } from './client.js';

// This is display/recovery state. PostgreSQL and the API decide permissions.
export function createWorkspaceStore({ load, write, onAuthRequired = () => {} }) {
  let state = { status: 'loading', page: null, cursor: null, busy: false, error: '', notice: '' };
  let epoch = 0, reading, writing = false;
  const listeners = new Set();
  const publish = update => { state = { ...state, ...update }; for (const listener of listeners) listener(); };
  const cancel = () => { epoch++; reading?.abort(); reading = undefined; };
  async function refresh({ cursor = null, notice = '' } = {}) {
    if (writing) return;
    cancel();
    const current = epoch, controller = new AbortController(); reading = controller;
    publish({ status: 'loading', page: null, cursor, error: '', notice });
    try {
      const page = await load({ cursor, signal: controller.signal });
      if (current === epoch) publish({ status: 'ready', page });
    } catch (error) {
      if (current !== epoch || controller.signal.aborted) return;
      publish({ status: 'error', page: null, error: error.message });
      if (error.status === 401) onAuthRequired();
    } finally { if (current === epoch) reading = undefined; }
  }
  async function mutate(action, body, notice, { refreshAfter = true } = {}) {
    if (writing || state.status !== 'ready') throw new WorkspaceError('ACCESS_BUSY', 409);
    writing = true; cancel(); const current = epoch;
    publish({ busy: true, error: '', notice: '' });
    let result;
    try {
      result = await write(action, body);
    } catch (error) {
      if (current === epoch) {
        const uncertain = !error.status || error.status >= 500;
        publish({ status: uncertain ? 'uncertain' : 'error', page: null,
          error: uncertain ? 'We could not confirm the save. It may already be recorded. Reload the workspace to check before trying again.' : error.message });
        if (error.status === 401) onAuthRequired();
      }
      throw error;
    } finally {
      writing = false;
      if (current === epoch) publish({ busy: false });
    }
    // A successful write is followed by a fresh read, never another mutation.
    if (current === epoch) {
      if (refreshAfter) await refresh({ notice });
      else publish({ status: 'loading', page: null, notice }); // Caller navigates after confirmed create/delete.
    }
    return result;
  }
  return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state, refresh, mutate, cancel };
}
