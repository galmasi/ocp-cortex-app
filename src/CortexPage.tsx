import * as React from 'react';
import {
  PageSection,
  Title,
  Card,
  CardBody,
  CardTitle,
  Spinner,
  FormSelect,
  FormSelectOption,
  TextInput,
  Button,
} from '@patternfly/react-core';
import { apiFetch, apiPatch, ApiUnauthorizedError } from './api';
import { ClusterUser, logout } from './auth';
import CortexTerminal from './CortexTerminal';
import StageErrorBoundary from './StageErrorBoundary';

/** Injected at build time by DefinePlugin from package.json's version —
 * shows on the page so the deployed version is visible at a glance. */
declare const CORTEX_PLUGIN_VERSION: string | undefined;
const APP_VERSION =
  typeof CORTEX_PLUGIN_VERSION !== 'undefined' ? CORTEX_PLUGIN_VERSION : '?';

const CLUSTER_APPS_DOMAIN = 'apps.epoc000.ete14.res.ibm.com';
/** "Page open" counts as in use — the gateway's idle reaper keeps the
 * instance alive while these arrive (and reaps it when they stop). */
const HEARTBEAT_MS = 60_000;

/** Reverse proxy backend choices (the engine's cortex.yaml
 * `reverse_proxy_backend`). The engine reads its config at startup, so
 * a change rewrites the ConfigMap and restarts the Deployment. */
const CUSTOM_BACKEND = '__custom__';
const BACKEND_CHOICES = [
  {
    value: 'https://ete-litellm.ai-models.vpc-int.res.ibm.com',
    label: 'Internal LiteLLM gateway (vpc-int)',
  },
  {
    value: 'https://ete-litellm.ai-models.vpc.res.ibm.com',
    label: 'External LiteLLM gateway (vpc)',
  },
];
const BACKEND_RE = /reverse_proxy_backend:\s*"([^"]*)"/;

interface Metadata {
  name?: string;
}
interface PodObject {
  metadata?: Metadata;
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      state?: { waiting?: { reason?: string } };
    }>;
  };
}

/** DNS-1123-safe namespace suffix from a cluster username. Must stay
 * in sync with sanitize() in cortex-gateway/main.go. */
const sanitize = (name: string): string =>
  (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'user';

type Phase = 'checking' | 'starting' | 'error';

export interface CortexPageProps {
  token: string;
  user: ClusterUser;
  onSessionExpired: () => void;
}

/**
 * Cortex page — per-user instance.
 *
 * Instance lifecycle is owned by the shared cortex-gateway (see
 * DESIGN.md Part 2): on first open the page asks it to provision the
 * namespace + RBAC + instance (POST /__cortex/provision, proxied
 * same-origin by nginx; the user's token proves identity), then
 * heartbeats once a minute while the page is open — page open and
 * proxy traffic both keep the engine alive, and the gateway reaps it
 * when neither has been seen for a while. Here we only poll pods
 * until the agentop container is Ready and attach the terminal.
 */
const CortexPage: React.FC<CortexPageProps> = ({ token, user, onSessionExpired }) => {
  const [phase, setPhase] = React.useState<Phase>('checking');
  const [error, setError] = React.useState<string | null>(null);
  const [readyPod, setReadyPod] = React.useState<string | null>(null);
  const [waitingReason, setWaitingReason] = React.useState('');
  const provisionedRef = React.useRef<string | null>(null);

  // Reverse proxy backend: current value from the ConfigMap, the
  // FormSelect's value ('__custom__' when typing), and save state.
  const [backend, setBackend] = React.useState<string | null>(null);
  const [backendChoice, setBackendChoice] = React.useState<string>('');
  const [customBackend, setCustomBackend] = React.useState('');
  const [backendMsg, setBackendMsg] = React.useState('');
  const [savingBackend, setSavingBackend] = React.useState(false);

  const userName = user.name;
  const ns = userName ? `cortex-${sanitize(userName)}` : '';

  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiUnauthorizedError) {
        onSessionExpired();
        throw e;
      }
      throw e;
    }
  };

  // Provision on first open: the gateway creates the namespace (with
  // this user's Role/RoleBinding — the one thing our own token cannot
  // do) and the instance objects, idempotently.
  React.useEffect(() => {
    if (!userName || provisionedRef.current === userName) return;
    provisionedRef.current = userName;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/__cortex/provision', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          throw new Error(
            `provision failed: ${resp.status} ${await resp.text()}`,
          );
        }
        if (!cancelled) setPhase('starting');
      } catch (e) {
        if (!cancelled) {
          setError(String((e as Error)?.message || e));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userName, token]);

  // Heartbeat while the page is open: keeps the idle reaper at bay and
  // (re)starts the instance if it was reaped while we were away.
  React.useEffect(() => {
    if (!userName) return;
    const beat = () =>
      fetch(`/__cortex/heartbeat?user=${encodeURIComponent(userName)}`).catch(
        () => {},
      );
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [userName]);

  // Poll pod state until the agentop container is Ready.
  React.useEffect(() => {
    if (phase !== 'starting' || !ns) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await guarded(() =>
          apiFetch<{ items?: PodObject[] }>(
            token,
            `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent('app=cortex')}`,
          ),
        );
        const pods = (list.items || [])
          .filter((p) => !p.metadata?.name?.includes('debug'))
          .sort((a, b) =>
            String(a.metadata?.name).localeCompare(String(b.metadata?.name)),
          );
        const ready = pods.find((p) =>
          p.status?.containerStatuses?.some((c) => c.name === 'agentop' && c.ready),
        );
        const pending = pods.find(
          (p) =>
            !p.status?.containerStatuses?.some((c) => c.name === 'agentop' && c.ready),
        );
        if (cancelled) return;
        if (ready) {
          setReadyPod(ready.metadata?.name || null);
          return; // stop polling
        }
        if (pending) {
          setWaitingReason(
            pending.status?.containerStatuses?.find((c) => c.name === 'agentop')
              ?.state?.waiting?.reason ||
              pending.status?.phase ||
              '',
          );
        }
      } catch (e) {
        if (e instanceof ApiUnauthorizedError) return;
        if (!cancelled) setError(String((e as Error)?.message || e));
      }
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, ns, token]);

  const routeHost = userName ? `cortex-${sanitize(userName)}.${CLUSTER_APPS_DOMAIN}` : '';

  // Load the current reverse proxy backend from the instance's
  // ConfigMap once the namespace exists (provisioned above).
  React.useEffect(() => {
    if (!ns || phase === 'checking') return;
    let cancelled = false;
    (async () => {
      try {
        const cm = await guarded(() =>
          apiFetch<{ data?: Record<string, string> }>(
            token,
            `/api/v1/namespaces/${ns}/configmaps/cortex-config`,
          ),
        );
        const yaml = cm.data?.['cortex.yaml'] || '';
        const m = yaml.match(BACKEND_RE);
        if (!cancelled && m) {
          setBackend(m[1]);
          setBackendChoice(
            BACKEND_CHOICES.some((c) => c.value === m[1]) ? m[1] : CUSTOM_BACKEND,
          );
          setCustomBackend(
            BACKEND_CHOICES.some((c) => c.value === m[1]) ? '' : m[1],
          );
        }
      } catch (e) {
        if (e instanceof ApiUnauthorizedError) return;
        // Non-fatal: the selector just starts empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ns, phase, token]);

  /** Rewrite `reverse_proxy_backend` in the ConfigMap and restart the
   * engine so it picks the new value up (it reads config at startup).
   * The user's own token is authorized for both operations. */
  const saveBackend = async (value: string) => {
    if (!ns || !value) return;
    setSavingBackend(true);
    setBackendMsg('');
    try {
      const cmPath = `/api/v1/namespaces/${ns}/configmaps/cortex-config`;
      const cm = await guarded(() =>
        apiFetch<{ data?: Record<string, string> }>(token, cmPath),
      );
      const yaml = cm.data?.['cortex.yaml'] || '';
      if (!BACKEND_RE.test(yaml)) {
        throw new Error('cortex.yaml has no reverse_proxy_backend line');
      }
      const next = yaml.replace(
        BACKEND_RE,
        `reverse_proxy_backend: "${value}"`,
      );
      await guarded(() =>
        apiPatch(token, cmPath, [
          { op: 'replace', path: '/data/cortex.yaml', value: next },
        ]),
      );
      // Give the kubelet a moment to sync the mounted ConfigMap before
      // the restarted engine reads it, then do a rollout restart
      // (template annotation, like `kubectl rollout restart`).
      await new Promise((r) => setTimeout(r, 3000));
      await guarded(() =>
        apiFetch(token, `/apis/apps/v1/namespaces/${ns}/deployments/cortex`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({
            spec: {
              template: {
                metadata: {
                  annotations: { 'cortex.io/restartedAt': new Date().toISOString() },
                },
              },
            },
          }),
        }),
      );
      setBackend(value);
      setBackendMsg('saved — engine restarting');
    } catch (e) {
      if (e instanceof ApiUnauthorizedError) return;
      setBackendMsg(`failed: ${String((e as Error)?.message || e)}`);
    } finally {
      setSavingBackend(false);
    }
  };

  return (
    <>
      <PageSection>
        <Title headingLevel="h1" size="2xl">
          Cortex{' '}
          <span style={{ fontSize: '13px', fontWeight: 'normal' }}>
            (v{APP_VERSION})
          </span>
          <span style={{ float: 'right', fontSize: '13px', fontWeight: 'normal' }}>
            {userName ? (
              <>
                <code>{userName}</code>{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    logout();
                  }}
                  style={{ fontSize: '13px' }}
                >
                  log out
                </a>
              </>
            ) : null}
          </span>
        </Title>
        {/* TODO: this will become a link to a page served by this app
            for installing/configuring claude code instances to point
            at the per-user proxy. */}
        <p style={{ fontSize: '13px', color: '#6a6e73', marginTop: '4px' }}>
          place holder -- user instructions
        </p>
      </PageSection>
      {/* Reduced left gutter; keep a matching right gutter so the
          terminal doesn't abut the browser edge. */}
      <PageSection style={{ paddingLeft: '8px', paddingRight: '16px' }}>
        <Card>
          <CardBody>
            {!userName ? (
              <div style={{ marginBottom: '16px', fontSize: '13px' }}>
                identifying user…
              </div>
            ) : (
              <div style={{ marginBottom: '16px', fontSize: '13px' }}>
                user <code>{userName}</code> — instance <code>{ns}/cortex</code>
                {routeHost && (
                  <>
                    {' '}
                    — proxy <code>https://{routeHost}</code>
                  </>
                )}
              </div>
            )}

            {phase === 'error' && (
              <pre style={{ color: 'red', margin: 0 }}>{error}</pre>
            )}
            {phase !== 'error' && !readyPod && (
              <div>
                <Spinner size="sm" />{' '}
                {phase === 'checking'
                  ? 'checking instance…'
                  : `starting instance${waitingReason ? ` (${waitingReason})` : ''}…`}
              </div>
            )}
          </CardBody>
        </Card>

        {ns && backend !== null && (
          <Card style={{ marginTop: '16px' }}>
            <CardTitle>Reverse proxy backend</CardTitle>
            <CardBody>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <FormSelect
                  aria-label="Reverse proxy backend"
                  value={backendChoice}
                  onChange={(_e, v) => {
                    setBackendChoice(v);
                    setBackendMsg('');
                    if (v !== CUSTOM_BACKEND) void saveBackend(v);
                  }}
                  style={{ maxWidth: '380px' }}
                >
                  {BACKEND_CHOICES.map((c) => (
                    <FormSelectOption key={c.value} value={c.value} label={c.label} />
                  ))}
                  <FormSelectOption value={CUSTOM_BACKEND} label="Custom…" />
                </FormSelect>
                {backendChoice === CUSTOM_BACKEND && (
                  <>
                    <TextInput
                      aria-label="Custom backend URL"
                      placeholder="https://…"
                      value={customBackend}
                      onChange={(_e, v) => setCustomBackend(v)}
                      style={{ maxWidth: '380px' }}
                    />
                    <Button
                      variant="secondary"
                      isDisabled={savingBackend || !customBackend.trim()}
                      onClick={() => void saveBackend(customBackend.trim())}
                    >
                      Apply
                    </Button>
                  </>
                )}
                {savingBackend && <Spinner size="sm" />}
              </div>
              {backendMsg && (
                <p style={{ marginTop: '8px', fontSize: '13px' }}>{backendMsg}</p>
              )}
              <p style={{ marginTop: '8px', fontSize: '13px', color: '#6a6e73' }}>
                Backend the engine's reverse proxy forwards to
                (<code>cortex-{'<user>'}-r.{CLUSTER_APPS_DOMAIN}</code>). Current:{' '}
                <code>{backend}</code>. Changing it restarts your engine.
              </p>
            </CardBody>
          </Card>
        )}

        {readyPod && (
          <Card style={{ marginTop: '16px' }}>
            <StageErrorBoundary title="Terminal">
              <CortexTerminal
                key={`${ns}/${readyPod}`}
                namespace={ns}
                pod={readyPod}
                container="agentop"
                token={token}
              />
            </StageErrorBoundary>
          </Card>
        )}
      </PageSection>
    </>
  );
};

export default CortexPage;
