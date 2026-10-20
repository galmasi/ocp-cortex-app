import * as React from 'react';
import {
  PageSection,
  Title,
  Card,
  CardBody,
  Spinner,
} from '@patternfly/react-core';
import { apiFetch, ApiUnauthorizedError } from './api';
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
