import { credentialId } from './client.js';

const unavailable = 'Camera QR reading is unavailable in this browser. Paste the complete admission code instead.';
const permission = 'Camera access was not granted. You can try again or paste the admission code.';

// No frame uploads, admission, journal, saved images, or automatic restart lives here.
export function createTicketCamera({ video, onCode, onState, expectedTicketId,
  mediaDevices = globalThis.navigator?.mediaDevices, Detector = globalThis.BarcodeDetector,
  secure = globalThis.isSecureContext, schedule = fn => setTimeout(fn, 250), cancel = clearTimeout,
  loadReader = () => import('./software-reader.js'), createCanvas = () => document.createElement('canvas') }) {
  let generation = 0, stream = null, timer = null, running = false, trackListeners = [], frameReader = null;
  function stop(status = 'idle', message = 'Camera stopped. Paste a code or start scanning again.') {
    ++generation; running = false;
    if (timer !== null) cancel(timer); timer = null;
    for (const [track, listener] of trackListeners) track.removeEventListener('ended', listener);
    trackListeners = [];
    frameReader?.clear?.(); frameReader = null;
    const previous = stream; stream = null;
    if (previous) { video.pause(); video.srcObject = null; for (const track of previous.getTracks()) track.stop(); }
    onState({ status, message });
  }
  function dispose() { stop(); }
  async function start() {
    if (running) return;
    const own = ++generation; running = true;
    onState({ status: 'starting', message: 'Preparing camera. Your browser may ask for permission.' });
    try {
      if (!secure || !mediaDevices?.getUserMedia) {
        stop('unavailable', unavailable); return;
      }
      let detector;
      try {
        const formats = await Detector?.getSupportedFormats?.();
        if (formats?.includes('qr_code')) detector = new Detector({ formats: ['qr_code'] });
      } catch { /* Use the local software reader when native support fails. */ }
      if (own !== generation) return;
      if (!detector) {
        const { softwareReader } = await loadReader();
        if (own !== generation) return;
        detector = softwareReader(createCanvas()); frameReader = detector;
      }
      const acquired = await mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      // Permission prompts cannot be cancelled. Release a late grant immediately.
      if (own !== generation) { for (const track of acquired.getTracks()) track.stop(); return; }
      stream = acquired;
      for (const track of stream.getVideoTracks()) {
        const ended = () => { if (own === generation) stop('error', 'The camera disconnected. Paste a code or start again.'); };
        track.addEventListener('ended', ended); trackListeners.push([track, ended]);
      }
      video.srcObject = stream; await video.play();
      if (own !== generation) return;
      onState({ status: 'scanning', message: 'Show one private ticket QR to the camera. Scanning fills the code only.' });
      async function scan() {
        if (own !== generation) return;
        try {
          if (video.readyState >= 2) {
            const results = await detector.detect(video);
            if (own !== generation) return;
            const codes = [...new Set(results.map(result => result.rawValue).filter(value => credentialId(value)))];
            if (codes.length === 1 && (!expectedTicketId || credentialId(codes[0]) === expectedTicketId)) {
              stop('read', 'Ticket code filled. Check the selected show, then press Check & admit. Scanning alone does not grant entry.');
              onCode(codes[0]); return;
            }
            if (results.length) onState({ status: 'scanning', message: codes.length > 1 ? 'Show only one ticket QR at a time.'
              : codes.length && expectedTicketId ? 'Scan the original ticket for this unresolved request.' : 'No complete SeatLedger ticket code found. You can paste it instead.' });
          }
          if (own === generation) timer = schedule(scan);
        } catch { if (own === generation) stop('error', 'Camera reading failed. Paste the complete admission code or start again.'); }
      }
      timer = schedule(scan);
    } catch (error) {
      if (own === generation) stop('error', ['NotAllowedError', 'SecurityError'].includes(error?.name) ? permission : 'The camera could not start. Close other camera apps or paste the admission code.');
    }
  }
  return { start, stop, dispose };
}
