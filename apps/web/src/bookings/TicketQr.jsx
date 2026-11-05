import React, { useMemo, useState } from 'react';
import { ticketQr } from './ticket-qr.js';
import './ticket-qr.css';

export function TicketQr({ credential }) {
  const symbol = useMemo(() => { try { return ticketQr(credential); } catch { return null; } }, [credential]);
  if (!symbol) return <p>QR preview is unavailable. Use the complete admission code below.</p>;
  return <svg className="ticket-qr" viewBox={`0 0 ${symbol.size} ${symbol.size}`} width="228" height="228"
    role="img" aria-label="Private admission QR code" shapeRendering="crispEdges">
    <rect width={symbol.size} height={symbol.size} fill="#fff" />
    <path d={symbol.path} fill="#000" />
  </svg>;
}

export function PrivateTicketCode({ credential }) {
  const [open, setOpen] = useState(false);
  return <div className="private-ticket-code"><button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
    {open ? 'Hide private QR & admission code' : 'Show private QR & admission code'}</button>
    {open && <div><TicketQr credential={credential} /><code>{credential}</code><p>Staff scan this QR or paste the code, then check live admission status.</p></div>}
  </div>;
}
