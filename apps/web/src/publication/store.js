import { PublicationError } from './client.js';

function frozen(value) {
  const copy = structuredClone(value);
  const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  return freeze(copy);
}
// No automatic POST replay. A pending reviewed intention lives only in this
// scoped store; status reads resolve uncertainty before explicit same-token retry.
export function createPublicationStore({ readStatus, readReview, publish, onAuthRequired = () => {} }) {
  let state = { status: 'loading', data: null, review: null, busy: false, error: '', notice: '' };
  let epoch = 0, working = false, reading, pending = null;
  const listeners = new Set();
  const emit = update => { state = { ...state, ...update }; listeners.forEach(fn => fn()); };
  const cancel = () => { epoch++; reading?.abort(); reading = undefined; pending = null; working = false; };
  async function load() {
    if (working) return;
    working = true; const current = ++epoch, controller = new AbortController(); reading = controller;
    emit({ status: 'loading', data: null, review: null, busy: true, error: '', notice: '' });
    try {
      const data = await readStatus({ signal: controller.signal });
      if (current !== epoch) return;
      const previous = pending;
      if (data.event.status !== 'DRAFT') { pending = null; emit({ status: 'record', data, review: null }); }
      else if (previous && data.organization.role === 'OWNER' && data.event.publicationRevision === previous.event.publicationRevision) {
        emit({ status: 'retry', data, review: previous, notice: 'The event is currently a draft. You can explicitly retry the same reviewed publication; no request has been replayed automatically.' });
      } else {
        pending = null; emit({ status: 'draft', data, review: null, notice: previous ? 'The draft or your access changed. Prepare a fresh review before confirming.' : '' });
      }
    } catch (error) {
      if (current !== epoch || controller.signal.aborted) return;
      if (error.status && error.status < 500) pending = null;
      emit({ status: pending ? 'uncertain' : 'error', data: null, review: null, error: error.message });
      if (error.status === 401) onAuthRequired();
    } finally { if (current === epoch) { working = false; reading = undefined; emit({ busy: false }); } }
  }
  async function prepare() {
    if (working || state.status !== 'draft') return;
    working = true; const current = ++epoch, controller = new AbortController(); reading = controller;
    emit({ status: 'loading', busy: true, data: null, review: null, error: '', notice: '' });
    try {
      const review = frozen(await readReview({ signal: controller.signal }));
      if (current === epoch) emit({ status: 'review', review, data: { event: review.event, organization: review.organization, receipt: null } });
    } catch (error) {
      if (current !== epoch || controller.signal.aborted) return;
      emit({ status: 'error', data: null, review: null, error: error.message }); if (error.status === 401) onAuthRequired();
    } finally { if (current === epoch) { working = false; reading = undefined; emit({ busy: false }); } }
  }
  function confirm() {
    if (!working && state.status === 'review' && state.review.organization.role === 'OWNER') emit({ status: 'confirm' });
  }
  function back() { if (!working && state.status === 'confirm') emit({ status: 'review' }); }
  function discard() {
    if (!working && state.status === 'retry') { pending = null; emit({ status: 'draft', review: null, notice: 'The previous review was discarded in this view. Prepare a fresh review before confirming.' }); }
  }
  async function save() {
    if (working || !['confirm', 'retry'].includes(state.status) || state.review?.organization.role !== 'OWNER') throw new PublicationError('ACCESS_BUSY', 409);
    working = true; const current = ++epoch, review = state.review; pending = review;
    emit({ status: 'publishing', review: null, data: null, busy: true, error: '', notice: '' });
    try {
      const receipt = await publish(review);
      if (current === epoch) {
        pending = null; emit({ status: 'record', data: { event: receipt.event, organization: review.organization, receipt }, review: null, notice: 'Programme published locally. Its publication record is saved.' });
      }
    } catch (error) {
      if (current !== epoch) return;
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) pending = null;
      emit({ status: uncertain ? 'uncertain' : 'error', review: null, data: null,
        error: uncertain ? 'We could not confirm publication. It may already be saved. Check publication status before taking another action.' : error.message });
      if (error.status === 401) onAuthRequired();
    } finally { if (current === epoch) { working = false; emit({ busy: false }); } }
  }
  return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => state, load, prepare, confirm, back, discard, save, cancel };
}
