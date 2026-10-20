/**
 * OAuth authorization-code flow against the cluster's OAuth server
 * (the same IAM the OpenShift console uses), with the code-for-token
 * exchange proxied by our nginx (it holds the client secret — a secret
 * that must never ship in the browser bundle).
 *
 * Flow:
 *   1. No/invalid token -> redirect the browser to /oauth/authorize
 *      (cluster login page), with a random `state` for CSRF protection.
 *   2. OAuth server redirects back to /auth/callback?code=...&state=...
 *   3. The callback page POSTs the code to /auth/exchange; nginx adds
 *      the client Basic-auth header and forwards to /oauth/token.
 *   4. The access token lands in sessionStorage and is used as a
 *      Bearer credential for all API calls (same-origin via /api proxy).
 */

const TOKEN_KEY = 'cortex.access_token';

export const OAUTH_AUTHORIZE_URL =
  'https://oauth-openshift.apps.epoc000.ete14.res.ibm.com/oauth/authorize';
export const OAUTH_SCOPE = 'user:full';

/** The cluster user behind the current token (from the API server). */
export interface ClusterUser {
  name: string;
}

export const getStoredToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

const storeToken = (token: string) => {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode etc. — token lives in memory for this tab only */
  }
};

export const clearToken = () => {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

const randomState = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Redirect the browser to the cluster login page. Never returns. */
export const startLogin = (): void => {
  const state = randomState();
  try {
    sessionStorage.setItem('cortex.oauth_state', state);
  } catch {
    /* state check degrades to skipped */
  }
  const params = new URLSearchParams({
    client_id: 'cortex-app',
    response_type: 'code',
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: OAUTH_SCOPE,
    state,
  });
  window.location.href = `${OAUTH_AUTHORIZE_URL}?${params}`;
};

export const logout = (): void => {
  clearToken();
  window.location.href = '/';
};

/**
 * Handle the OAuth callback on /auth/callback. Verifies state, exchanges
 * the code via the nginx proxy, stores the token, then redirects home.
 * Resolves null when there is nothing to do (not a callback request).
 */
export const handleCallback = async (): Promise<string | null> => {
  const q = new URLSearchParams(window.location.search);
  const code = q.get('code');
  const state = q.get('state');
  const error = q.get('error');
  if (error) throw new Error(`oauth: ${q.get('error_description') || error}`);
  if (!code) return null; // not a callback — normal page load

  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem('cortex.oauth_state');
    sessionStorage.removeItem('cortex.oauth_state');
  } catch {
    /* ignore */
  }
  if (expected && state !== expected) throw new Error('oauth: state mismatch');

  // The secret lives in nginx; the browser only ever sees the code.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${window.location.origin}/auth/callback`,
  });
  const resp = await fetch('/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await resp.json()) as { access_token?: string; error_description?: string };
  if (!resp.ok || !data.access_token) {
    throw new Error(`oauth exchange: ${data.error_description || resp.status}`);
  }
  storeToken(data.access_token);
  window.history.replaceState({}, '', '/');
  return data.access_token;
};
