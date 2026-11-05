import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createTicketCamera } from './camera.js';

export function CameraInput({ disabled, expectedTicketId, onCode, onStart, stopVersion }) {
  const video = useRef(null), camera = useRef(null), latest = useRef(null);
  latest.current = { disabled, onCode, onStart };
  const [state, setState] = useState({ status: 'idle', message: '' });
  useEffect(() => {
    let mounted = true;
    setState({ status: 'idle', message: '' });
    const controller = createTicketCamera({ video: video.current, expectedTicketId,
      onState: value => { if (mounted) setState(value); },
      onCode: code => { if (mounted && !latest.current.disabled) latest.current.onCode(code); } });
    camera.current = controller;
    const leave = () => controller.stop();
    const visibility = () => { if (document.visibilityState !== 'visible') leave(); };
    window.addEventListener('blur', leave); window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => { mounted = false; controller.dispose(); camera.current = null;
      window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visibility); };
  }, [expectedTicketId]);
  useLayoutEffect(() => { camera.current?.stop(); }, [disabled, stopVersion]);
  const active = ['starting', 'scanning'].includes(state.status);
  return <section className="entrance-camera" aria-label="Optional ticket camera">
    <div className="entrance-form-actions"><button type="button" className="secondary-button" disabled={disabled || active} onClick={() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) { latest.current.onStart?.(); void camera.current?.start(); }
    }}>Start camera QR scan</button>
      <button type="button" className="text-button" disabled={!active} onClick={() => camera.current?.stop()}>Stop camera</button></div>
    <video ref={video} muted playsInline hidden={!active} aria-label="Live ticket camera preview" />
    <p>Camera access requires HTTPS or loopback and your permission. QR reading happens on this device. Show one ticket at a time; paste is always available.</p>
    {state.message && <p role="status">{state.message}</p>}
  </section>;
}
