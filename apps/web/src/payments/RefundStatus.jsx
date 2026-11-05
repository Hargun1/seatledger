import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { priceLabel, utcWhen } from '../discovery/model.js';
import { readCustomerRefund, refundOutcome } from './refund.js';
import { CheckoutError } from './client.js';

// Parent is keyed by account/checkout; no refund or result is persisted in storage.
export function RefundStatus({ payment }) {
  const auth = useAuth(), generation = useRef(0), controller = useRef(null), refreshRef = useRef(null);
  const [state, setState] = useState({ loading: true, value: null, error: null });
  const { id, amountMinor, currency } = payment;
  useEffect(() => {
    const refresh = async () => {
      const version = ++generation.current;
      controller.current?.abort(); const current = new AbortController(); controller.current = current;
      setState({ loading: true, value: null, error: null });
      try {
        const value = await readCustomerRefund({ payment: { id, amountMinor, currency }, signal: current.signal });
        if (!current.signal.aborted && generation.current === version) setState({ loading: false, value, error: null });
      } catch (error) {
        if (!current.signal.aborted && generation.current === version) setState({ loading: false, value: null, error });
      }
    };
    refreshRef.current = refresh;
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh(); window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus);
    return () => { generation.current++; controller.current?.abort(); refreshRef.current = null;
      window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [id, amountMinor, currency]);
  const outcome = refundOutcome(state.value), refund = state.value?.refund;
  return <section className="checkout-refund" aria-label="Current simulated refund status">
    <div className="checkout-section-label"><span>FULL SIMULATED REFUND</span>
      <button className="text-button" disabled={state.loading} onClick={() => refreshRef.current?.()}>Check refund status</button></div>
    <div role="status">{state.loading ? <p>Checking the current refund record.</p> : state.error
      ? <p>{state.error instanceof CheckoutError ? state.error.message : 'We could not check the refund. Try again.'} Refund completion is not confirmed.</p>
      : <><h4>{outcome.title}</h4><p>{outcome.detail}</p>
        {refund && <p>{priceLabel(refund.amountMinor, refund.currency)} / requested <time dateTime={refund.requestedAt}>{utcWhen(refund.requestedAt)}</time>
          {refund.progress === 'COMPLETED' && <> / completed <time dateTime={refund.completedAt}>{utcWhen(refund.completedAt)}</time></>}</p>}</>}
    </div>
    {[401,403].includes(state.error?.status) && <button className="secondary-button" onClick={() => auth.refresh()}>Check session</button>}
    <p className="checkout-small">This is a saved server snapshot. Refresh or return to this checkout to check again. Checking status never requests another refund.</p>
  </section>;
}
