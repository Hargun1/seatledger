const messages = {
  INVALID_CREDENTIALS: 'The email or password is incorrect. Please try again.',
  ACCOUNT_EXISTS: 'An account with this email already exists. Sign in instead.',
  INVALID_REQUEST: 'Please check your details and try again.',
  AUTH_BUSY: 'Sign-in is busy right now. Please wait a moment and try again.',
  AUTH_REQUIRED: 'Your session has ended. Please sign in again.',
  CSRF_REJECTED: 'Your session changed. Check your session before trying again.',
  ORIGIN_REJECTED: 'This address is not allowed to sign in. Open the configured SeatLedger address.',
  CONNECTION_ERROR: 'We could not reach SeatLedger. Check your connection and try again.',
  INVALID_RESPONSE: 'We could not confirm the response from SeatLedger. Please check your session.'
};

export class AuthError extends Error {
  constructor(code, status = 0, retryAfter = 0) {
    super(code === 'AUTH_RATE_LIMITED'
      ? `Too many attempts. Try again in ${retryAfter || 60} seconds.`
      : messages[code] || 'SeatLedger could not complete the request. Please try again.');
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function validSession(value) {
  return value && typeof value.user?.id === 'string' && typeof value.user.email === 'string'
    && typeof value.user.displayName === 'string' && ['CUSTOMER', 'ADMIN'].includes(value.user.role)
    && /^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) && Number.isFinite(Date.parse(value.expiresAt));
}

export async function authRequest(action, { body, csrfToken, signal } = {}) {
  const method = action === 'session' ? 'GET' : 'POST';
  const headers = method === 'POST' ? { 'Content-Type': 'application/json', 'X-SeatLedger-Client': 'web' } : {};
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let response;
  try {
    response = await fetch(`/api/auth/${action}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AuthError('CONNECTION_ERROR');
  }
  let data;
  try { data = response.status === 204 ? null : await response.json(); }
  catch { throw new AuthError('INVALID_RESPONSE', response.status >= 500 ? response.status : 0); }
  if (!response.ok) {
    const seconds = Number(response.headers.get('Retry-After'));
    throw new AuthError(data?.error, response.status, Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0);
  }
  if (action === 'logout' || action === 'logout-all') {
    if (response.status !== 204) throw new AuthError('INVALID_RESPONSE');
  } else if (!validSession(data)) throw new AuthError('INVALID_RESPONSE');
  return data;
}
