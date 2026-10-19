import * as React from 'react';
import {
  PageSection,
  Title,
  Card,
  CardBody,
  Spinner,
} from '@patternfly/react-core';
import {
  useK8sWatchResource,
  consoleFetchJSON,
} from '@openshift-console/dynamic-plugin-sdk';
import CortexTerminal from './CortexTerminal';
import StageErrorBoundary from './StageErrorBoundary';

/** Injected at build time by DefinePlugin from package.json's
 * consolePlugin.version — shows on the page so the deployed version is
 * visible at a glance. */
declare const CORTEX_PLUGIN_VERSION: string | undefined;
const PLUGIN_VERSION =
  typeof CORTEX_PLUGIN_VERSION !== 'undefined' ? CORTEX_PLUGIN_VERSION : '?';

/** Instance parameters — mirror of manifests/templates/cortex-instance.yaml */
const CORTEX_IMAGE = 'icr.io/vopo/cortex:latest';
/** Image containing nginx, reused as the TLS-terminating front. */
const TLS_FRONT_IMAGE = 'icr.io/vopo/cortex-plugin:0.1';
const FORWARD_PROXY_PORT = 13000; // TLS front (route passthrough target)
const ENGINE_PORT = 13001; // listener.forward_proxy_addr (localhost only)
const SESSION_API_PORT = 19095; // listener.session_api_addr
const CLUSTER_APPS_DOMAIN = 'apps.epoc000.ete14.res.ibm.com';

/** The per-user cortex engine configuration (cortex-config ConfigMap).
 * The forward proxy binds localhost only — the tls-front sidecar is the
 * sole TLS front door for it. */
const cortexConfigYaml = (userName: string) => `listener:
  forward_proxy_addr: "127.0.0.1:${ENGINE_PORT}"
  transparent_proxy_addr: ":18082"
  reverse_proxy_backend: "http://127.0.0.1:1"
  session_api_addr: ":${SESSION_API_PORT}"

tls_bridge:
  mode: disabled

pipeline:
  outbound:
    plugins:
      - name: inference-parser
      - name: a2a-parser

# generated for cluster user ${userName}
`;

/** nginx stream config: terminate TLS with the cluster wildcard cert
 * (secret cortex-tls, copied from openshift-ingress by the reconciler)
 * and tunnel to the engine's plaintext listener. */
const tlsFrontNginxConf = `daemon off;
worker_processes 1;
error_log /dev/stderr info;
pid /tmp/nginx.pid;
events { worker_connections 256; }
stream {
  server {
    listen ${FORWARD_PROXY_PORT} ssl;
    ssl_certificate /cert/tls.crt;
    ssl_certificate_key /cert/tls.key;
    proxy_pass 127.0.0.1:${ENGINE_PORT};
  }
}
`;

interface Metadata {
  name?: string;
}
interface UserObject {
  metadata?: Metadata;
}
interface DeploymentObject {
  metadata?: Metadata;
  spec?: { replicas?: number };
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
interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: Metadata & { namespace?: string; labels?: Record<string, string> };
}

/** DNS-1123-safe namespace suffix from a cluster username. */
const sanitize = (name: string): string =>
  (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'user';

const isNotFound = (e: unknown): boolean =>
  (e as { code?: number })?.code === 404;

/** Kubernetes API through the console's authenticated passthrough proxy. */
const api = (path: string) => `/api/kubernetes/${path.replace(/^\//, '')}`;

const resourcePath = (o: K8sObject, ns: string): string => {
  const name = o.metadata?.name;
  switch (`${o.apiVersion}/${o.kind}`) {
    case 'v1/ConfigMap':
      return `/api/v1/namespaces/${ns}/configmaps/${name}`;
    case 'apps/v1/Deployment':
      return `/apis/apps/v1/namespaces/${ns}/deployments/${name}`;
    case 'v1/Service':
      return `/api/v1/namespaces/${ns}/services/${name}`;
    case 'route.openshift.io/v1/Route':
      return `/apis/route.openshift.io/v1/namespaces/${ns}/routes/${name}`;
    default:
      throw new Error(`unhandled kind ${o.apiVersion}/${o.kind}`);
  }
};

const collectionPath = (o: K8sObject, ns: string): string =>
  resourcePath(o, ns).replace(/\/[^/]+$/, '');

const getJSON = <T extends object>(path: string) =>
  consoleFetchJSON(api(path)) as Promise<T>;

const postJSON = (path: string, body: object) =>
  consoleFetchJSON(api(path), 'POST', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } as RequestInit);

const patchJSON = (path: string, patches: object[]) =>
  consoleFetchJSON(api(path), 'PATCH', {
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(patches),
  } as RequestInit);

/**
 * The per-user instance. Mirrors manifests/templates/cortex-instance.yaml.
 *
 *   ConfigMap cortex-config    engine config (localhost forward proxy)
 *   ConfigMap cortex-tls-front nginx TLS-terminator config
 *   Secret    cortex-tls       cluster wildcard cert (reconciler-copied;
 *                              users cannot read/write secrets)
 *   Deployment cortex          cortex engine + agentop + tls-front
 *   Service   cortex           ClusterIP, TLS port 13000
 *   Route     cortex           passthrough on cortex-<user>.<apps-domain>
 *
 * Why the sidecar: the router routes HTTP by Host header, which in proxy
 * requests names the TARGET, not the proxy — so proxy traffic can only
 * enter via SNI (passthrough), and whoever terminates TLS must hold the
 * cluster wildcard key to present the cluster's cert.
 */
const buildObjects = (ns: string, userName: string): K8sObject[] => {
  const sanitized = sanitize(userName);
  const labels = { app: 'cortex', 'cortex-user': sanitized };
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cortex-config', namespace: ns, labels },
      data: { 'cortex.yaml': cortexConfigYaml(userName) },
    } as K8sObject,
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cortex-tls-front', namespace: ns, labels },
      data: { 'nginx.conf': tlsFrontNginxConf },
    } as K8sObject,
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'cortex', namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'cortex' } },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                // The traffic engine. Plaintext, localhost-only; the
                // tls-front sidecar is its sole ingress.
                name: 'cortex',
                image: CORTEX_IMAGE,
                command: ['/cortex'],
                args: ['--config', '/etc/cortex/cortex.yaml'],
                volumeMounts: [
                  { name: 'config', mountPath: '/etc/cortex', readOnly: true },
                ],
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '2', memory: '1Gi' },
                },
              },
              {
                // The interactive observer. PID 1 is a supervisor that
                // starts a detached tmux session named "agentop" running
                // the traffic-viewer TUI and keeps the pod alive while
                // the session exists. The console terminal connects with
                // `tmux attach -t agentop` over exec, so every connect
                // gets a full repaint (tmux keeps screen state
                // server-side) and closing the terminal kills nothing.
                // window-size manual lets the client resize the session
                // via `tmux resize-window` (channel-4 resize is not
                // applied on the WS exec path on this cluster).
                name: 'agentop',
                image: CORTEX_IMAGE,
                command: ['/bin/bash', '-c'],
                args: [
                  `tmux new -d -s agentop /agentop observe --endpoint http://127.0.0.1:${SESSION_API_PORT};` +
                    ' tmux set-option -t agentop -w window-size manual;' +
                    ' while tmux has-session -t agentop 2>/dev/null; do sleep 30; done',
                ],
                env: [{ name: 'TERM', value: 'xterm-256color' }],
                tty: true,
                stdin: true,
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '1', memory: '256Mi' },
                },
              },
              {
                // TLS front: terminates with the cluster wildcard cert
                // (secret cortex-tls) and tunnels to the engine.
                name: 'tls-front',
                image: TLS_FRONT_IMAGE,
                command: ['nginx', '-c', '/etc/tls-front/nginx.conf'],
                ports: [
                  { containerPort: FORWARD_PROXY_PORT, name: 'forward-proxy' },
                ],
                volumeMounts: [
                  { name: 'tls', mountPath: '/cert', readOnly: true },
                  { name: 'tls-front-conf', mountPath: '/etc/tls-front', readOnly: true },
                ],
                resources: {
                  requests: { cpu: '10m', memory: '32Mi' },
                  limits: { cpu: '500m', memory: '128Mi' },
                },
              },
            ],
            volumes: [
              { name: 'config', configMap: { name: 'cortex-config' } },
              { name: 'tls-front-conf', configMap: { name: 'cortex-tls-front' } },
              { name: 'tls', secret: { secretName: 'cortex-tls' } },
            ],
          },
        },
      },
    } as K8sObject,
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'cortex', namespace: ns, labels },
      spec: {
        selector: { app: 'cortex' },
        ports: [
          {
            name: 'forward-proxy',
            port: FORWARD_PROXY_PORT,
            targetPort: FORWARD_PROXY_PORT,
          },
        ],
      },
    } as K8sObject,
    {
      // Passthrough: the router peeks SNI (which names the PROXY, so it
      // routes correctly, unlike the Host header of proxy requests) and
      // tunnels TLS to tls-front, which presents the cluster wildcard.
      apiVersion: 'route.openshift.io/v1',
      kind: 'Route',
      metadata: { name: 'cortex', namespace: ns, labels },
      spec: {
        host: `cortex-${sanitized}.${CLUSTER_APPS_DOMAIN}`,
        to: { kind: 'Service', name: 'cortex', weight: 100 },
        port: { targetPort: 'forward-proxy' },
        tls: { termination: 'passthrough' },
      },
    } as K8sObject,
  ];
};

type Phase = 'identity' | 'checking' | 'starting' | 'ready' | 'error';

/**
 * Cortex page — per-user instance.
 *
 * On open: identify the logged-in user (GET users/~), ensure the user's
 * cortex-<username> namespace holds the full instance (ConfigMap,
 * Deployment with cortex+agentop containers, Service, Route), wait for
 * the agentop container to become Ready, then attach the terminal to it.
 */
const CortexPage: React.FC = () => {
  const [phase, setPhase] = React.useState<Phase>('identity');
  const [error, setError] = React.useState<string | null>(null);
  const [userName, setUserName] = React.useState('');
  const ensuredRef = React.useRef<string | null>(null);

  // Who is logged in? GET users/~ — the server-side '~' shortcut resolves
  // to the current user. (A named watch on '~' would list-and-filter for a
  // literal user named '~', which does not exist.)
  React.useEffect(() => {
    let cancelled = false;
    consoleFetchJSON(api('/apis/user.openshift.io/v1/users/~'))
      .then((u: UserObject) => {
        if (!cancelled) setUserName(u?.metadata?.name || '');
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(`identity: ${String(e?.message || e)}`);
          setPhase('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ns = userName ? `cortex-${sanitize(userName)}` : '';

  // Watch the instance pods (only once the namespace is known).
  const [pods] = useK8sWatchResource<PodObject[]>(
    ns
      ? {
          kind: 'Pod',
          isList: true,
          namespace: ns,
          selector: { matchLabels: { app: 'cortex' } },
          optional: true,
        }
      : null,
  );

  const agentopStatus = (pods || []).map((p) =>
    p.status?.containerStatuses?.find((c) => c.name === 'agentop'),
  );
  const readyPod = (pods || []).find((p) =>
    p.status?.containerStatuses?.some((c) => c.name === 'agentop' && c.ready),
  );
  const pendingPod = (pods || []).find(
    (p) =>
      !p.status?.containerStatuses?.some((c) => c.name === 'agentop' && c.ready),
  );

  // Ensure-started: idempotent GET -> CREATE for each object, then scale
  // the Deployment up if the idle reaper had stopped it.
  React.useEffect(() => {
    if (!userName || !ns || ensuredRef.current === ns) return;
    ensuredRef.current = ns;
    let cancelled = false;

    (async () => {
      setPhase('checking');
      try {
        const objects = buildObjects(ns, userName);
        for (const o of objects) {
          const path = resourcePath(o, ns);
          try {
            await getJSON(path);
          } catch (e) {
            if (!isNotFound(e)) throw e;
            await postJSON(collectionPath(o, ns), o);
          }
        }
        // objects: [config, tls-front-conf, deployment, service, route]
        const deployment = await getJSON<DeploymentObject>(
          resourcePath(objects[2], ns),
        );
        if (!deployment.spec?.replicas) {
          // Stopped by the idle reaper — wake it up.
          await patchJSON(resourcePath(objects[1], ns), [
            { op: 'replace', path: '/spec/replicas', value: 1 },
          ]);
        }
        setPhase('starting');
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
  }, [userName, ns]);

  React.useEffect(() => {
    if (phase === 'starting' && readyPod) setPhase('ready');
  }, [phase, readyPod]);

  const waitingReason =
    pendingPod?.status?.containerStatuses?.find((c) => c.name === 'agentop')
      ?.state?.waiting?.reason ||
    agentopStatus.find((c) => c?.state?.waiting?.reason)?.state?.waiting
      ?.reason ||
    pendingPod?.status?.phase ||
    '';

  const routeHost = userName
    ? `cortex-${sanitize(userName)}.${CLUSTER_APPS_DOMAIN}`
    : '';
  return (
    <>
      <PageSection>
        <Title headingLevel="h1" size="2xl">
          Cortex{' '}
          <span style={{ fontSize: '13px', fontWeight: 'normal' }}>
            (plugin v{PLUGIN_VERSION})
          </span>
        </Title>
      </PageSection>
      <PageSection>
        <Card>
          <CardBody>
            {!userName ? (
              <div style={{ marginBottom: '16px', fontSize: '13px' }}>
                identifying user…
              </div>
            ) : (
              <div style={{ marginBottom: '16px', fontSize: '13px' }}>
                user <code>{userName}</code> — instance{' '}
                <code>{ns}/cortex</code>
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
                key={`${ns}/${readyPod.metadata?.name}`}
                namespace={ns}
                pod={readyPod.metadata?.name || ''}
                container="agentop"
              />
            </StageErrorBoundary>
          </Card>
        )}
      </PageSection>
    </>
  );
};

export default CortexPage;
