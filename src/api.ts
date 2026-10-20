/**
 * Kubernetes API client for the standalone app.
 *
 * All requests are same-origin: nginx proxies /api and /apis to the
 * apiserver, so no CORS and no cross-origin credentials — the browser
 * simply sends its Bearer token, which nginx forwards. A 401 means the
 * OAuth token is gone/expired and triggers re-login.
 */
import { ClusterUser } from './auth';

export class ApiUnauthorizedError extends Error {
  constructor() {
    super('session expired');
  }
}

export const apiFetch = async <T extends object>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const resp = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (resp.status === 401) throw new ApiUnauthorizedError();
  if (resp.status === 404) {
    const e = new Error('not found') as Error & { code: number };
    e.code = 404;
    throw e;
  }
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return (await resp.json()) as T;
};

export const getCurrentUser = (token: string): Promise<ClusterUser> =>
  apiFetch<{ metadata?: { name?: string } }>(
    token,
    '/apis/user.openshift.io/v1/users/~',
  ).then((u) => ({ name: u.metadata?.name || '' }));

export const apiPatch = <T extends object>(
  token: string,
  path: string,
  patches: object[],
): Promise<T> =>
  apiFetch<T>(token, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(patches),
  });
