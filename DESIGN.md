# Cortex per-user instance — design notes

Goal: when a user opens the Cortex tab, a pod is started **on demand, for
that user only**, and the terminal connects to it. Each instance is
customized by a per-user ConfigMap (ports, image, environment).

## Recommendation: one namespace per user, `cortex-<username>`

Three options were considered for where per-user pods live:

| Option | Exec isolation | Cost |
|---|---|---|
| Shared namespace `cortex` | **Broken** — RBAC `pods/exec` is namespace-scoped and cannot select pods by owner; any user granted exec could shell into anyone's pod | none |
| Per-user namespace `cortex-<user>` | **Natural** — a Role bound to the user in their namespace limits exec to exactly their own pod | more objects to manage |
| Shared namespace + `resourceNames` | Unworkable — pod names contain ReplicaSet hashes, not predictable at RBAC time | — |

Per-user namespace wins because Kubernetes authorization is
**namespace-scoped**, not pod-owner-scoped. The plugin's exec WebSocket
carries the logged-in user's identity, so the cluster — not our code —
enforces "you can only touch your own instance." A per-user namespace
also gives free per-user ResourceQuotas, and deterministic DNS/URLs:

```
namespace:  cortex-alice
deployment: cortex            (same name in every user namespace)
configmap:  cortex-config     (per-user customization)
service:    cortex
route:      cortex-alice.apps.epoc000.ete14.res.ibm.com
```

Username sanitization: lower-case, non-`[a-z0-9-]` → `-`, collapse runs,
trim to 63 bytes, hash-suffix on collision.

## Mechanics of starting the pod on demand

Division of labor:

1. **Reconciler (server-side, ahead of time):** watches `User` objects;
   for each registered user creates the namespace `cortex-<user>`, the
   Role/RoleBinding from `cortex-user-rbac.yaml`, and a skeleton
   `cortex-config` ConfigMap. This is the only component needing
   cluster-level permissions (create namespaces). No pods are started.

2. **Plugin (client-side, on tab open):** runs as the logged-in user and
   performs the "on demand" part with ordinary API calls — all
   authorized by the namespace Role:
   - `useK8sWatchResource({kind: 'User', name: '~'})` → identity
   - GET Deployment `cortex` in `cortex-<user>`:
     - **404** → CREATE it from the instance template (below), filling
       in values from the user's ConfigMap
     - **replicas 0** (stopped by the idle reaper) → PATCH to 1
   - watch pods with selector `app=cortex` until one is Ready (~seconds
     if image is cached on the node)
   - connect the existing `CortexTerminal` to that pod

3. **Idle reaper (server-side):** scales Deployments to 0 after
   inactivity (pod CPU/network via metrics, or a heartbeat written by
   the terminal connection). Never deletes the ConfigMap — user
   customization survives; the pod is the disposable part.

Everything the plugin does is idempotent (GET-then-CREATE/PATCH), so
double-clicks, concurrent tabs, and retries are harmless.

## The per-user ConfigMap

`cortex-config` in each user namespace holds the customization the pod
is generated from:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cortex-config
  namespace: cortex-alice
data:
  # image: override the default instance image
  image: "icr.io/vopo/cortex-box:latest"
  # ports: the (single, unprivileged) port the instance serves on
  port: "8080"
  # extra env, rendered into the Deployment as-is
  CORTEX_GREETING: "hello alice"
```

The plugin can GET/CREATE/PATCH this ConfigMap (it's in the user's
namespace, authorized by the Role), which gives users a safe knob
without granting them Deployment rights: the Deployment **template
itself** stays reconciler/plugin-owned; a ConfigMap change triggers a
plugin-side `oc rollout restart` equivalent (PATCH the Deployment's
template annotation) on next connect.

## Objects

- `templates/cortex-instance.yaml` — OpenShift Template (parameterized
  by USERNAME) producing the ConfigMap + Deployment + Service + Route.
  Process with:
  ```sh
  oc process -f templates/cortex-instance.yaml -p USERNAME=alice | oc apply -f -
  ```
  In production the *plugin* emits the same objects via the API instead
  of `oc process`; the template doubles as the reference manifest.
- `templates/cortex-user-rbac.yaml` — the Role + RoleBinding granting
  the user exactly: exec/get/list pods, get/create/patch deployments,
  get/create/patch configmaps — all within their own namespace only.
- `templates/cortex-reconciler-rbac.yaml` — ClusterRole + binding for
  the reconciler ServiceAccount: watch Users, create namespaces.

## Instance image

The instance image is `icr.io/vopo/cortex:latest`, entrypoint `/agentop`.
The terminal connects by exec'ing `/bin/sh` in the running container, so
the image must ship a shell alongside `/agentop` (if it doesn't, the
fallback is a debug sidecar that does).

---

# Part 2 — gateway: idle reaping and wake-on-use

**Definition of "in use"** (per user, either counts):

1. The Cortex console page is open in a browser (SPA heartbeat).
2. Traffic is flowing through the user's proxy route.

When **neither** has happened for the idle timeout (default 30 min),
the user's engine Deployment is scaled to 0. The moment the proxy is
used again — including a cold, scaled-to-zero instance — the engine is
started and the client's connection is held open until it is Ready.
To the client this is a slow TLS handshake (seconds, if the image is
cached on a node); no retry logic is needed anywhere.

## Why a shared, always-on gateway

A Deployment at replicas=0 has no endpoints; the router would return
503 and nothing would ever see the packet that should have woken the
engine. Something must always be listening. That role is filled by
**one shared `cortex-gateway` Deployment** (single small pod, one per
cluster) which **replaces the per-user `tls-front` sidecar**:

- Every user's Route (`cortex-<user>.apps.<domain>`, passthrough)
  points at the gateway's Service. SNI names the user, so the gateway
  demuxes per user — the same SNI-routing insight the tls-front
  sidecar exploited, centralized instead of per-pod.
- The gateway terminates TLS itself (cluster wildcard cert, held once
  in a single secret instead of N per-user copies — the reconciler's
  per-namespace cert copy goes away) and forwards plaintext to the
  engine's Service, exactly as tls-front does today.
- Because it terminates TLS, it can also intercept HTTP on that
  connection: `GET /__cortex/heartbeat` (and `/__cortex/status`) are
  answered by the gateway directly; everything else (proxy CONNECT /
  traffic) is tunneled to the engine.

Net always-on cost is *lower* than today: one gateway pod replaces one
tls-front sidecar per user.

## Wake path (connection to a sleeping engine)

1. Client opens TLS to `cortex-<user>.apps...`; router passes it to the
   gateway (SNI peek at the router is unchanged).
2. Gateway parses SNI → user → namespace `cortex-<user>`.
3. In the TLS `GetCertificate` callback (i.e. *during* the handshake,
   before the client has anything but a wait), the gateway checks the
   Deployment's replicas; if 0, PATCH to 1 (or CREATE if missing —
   same idempotent ensure the SPA does, so either side can win).
4. Watch pods until the engine container is Ready; return the wildcard
   cert; the handshake completes and the now-plaintext stream is
   proxied to the engine Service.
5. Any error (timeout, quota) → TLS alert / 503; the SPA shows the
   waiting state it already has.

Wake is unauthenticated beyond "you opened a TLS connection" — the
same exposure the proxy route has today; a connection alone grants
nothing without the engine's own proxy credentials. The gateway
rate-limits wake PATCHes per user (e.g. one per 10 s) so a wake-flooder
cannot thrash the apiserver.

## Idle table and the heartbeat

The gateway keeps a per-user record:

```
user → { lastTraffic, lastHeartbeat, wakingSince, deploymentState }
```

- `lastTraffic` — updated on every byte proxied for that user.
- `lastHeartbeat` — the SPA pings
  `GET https://cortex-<user>.apps.../__cortex/heartbeat` once a minute
  while the page is open (heartbeat also implies wake, so a user whose
  engine was reaped gets it back on page open — replacing the SPA's
  current scale-up PATCH, which stays as a harmless duplicate).
- A sweep loop (every minute) scales to 0 any user for whom
  `now - max(lastTraffic, lastHeartbeat) > idleTimeout`, and for whom
  no live connection or in-flight wake exists. Terminal execs ride the
  app origin, not the gateway, but the page hosting the terminal is
  heartbeating, so an open terminal keeps its engine alive.

The heartbeat endpoint is unauthenticated by design (it only ever
*keeps alive* / wakes — it grants no access). Persistent abuse is
bounded by the same rate limit.

## Objects and RBAC

- `cortex-gateway` Deployment + Services in the `cortex` namespace
  (alongside the app), `manifests/gateway.yaml`. Single container, Go
  binary, stdlib-only (TLS/SNI demux, wake, stream proxy, idle table,
  plain REST K8s client). 2 replicas + PDB — it is the one shared
  component. See `cortex-gateway/main.go`.
- Secret `cortex/cortex-tls` — the wildcard cert, mounted once by the
  gateway (the per-user `cortex-tls` copies and the reconciler's cert
  logic are retired).
- ClusterRole `cortex-gateway` (see the manifest): create namespaces
  and RoleBindings (provisioning first-time users — the one power the
  user's own token cannot have), and get/create/patch the instance
  objects cluster-wide. No pods/exec anywhere.
- Per-user objects, all created by the gateway (the SPA no longer
  creates anything): ConfigMap `cortex-config`, Deployment `cortex`
  (cortex + agentop containers — **no tls-front sidecar**), Route
  `cortex` and Route `cortex-r` (reverse proxy, host
  `cortex-<user>-r.<domain>`), plus a selector-less Service
  `cortex-gateway` + Endpoints in each user namespace — the standard
  cross-namespace workaround, since an OpenShift Route cannot target a
  Service in another namespace. The Endpoints are pinned to the
  gateway Service's ClusterIP and healed by the gateway if it drifts.
- There is **no per-user engine Service** anymore: the gateway dials
  the engine's **pod IP** directly (learned from the Ready-pod poll it
  already does). The engine Service had no other consumer. Likewise
  the per-user Endpoints point at the **gateway pod IPs**, not the
  gateway Service's ClusterIP — HAProxy dials endpoint addresses
  directly, and ClusterIPs are unreachable on this cluster. The
  gateway refreshes them (30s TTL) and heals per-user Endpoints on
  drift. The Endpoints port must be **named** ("proxy", matching the
  Routes' targetPort) with `protocol: TCP` — an unnamed port yields an
  empty HAProxy backend, because the endpointslice mirroring
  controller copies names from the Endpoints object.
- Engine listeners (verified against icr.io/vopo/cortex:latest): the
  forward proxy config must bind **all interfaces** (`:13001`), not
  the old sidecar-era `127.0.0.1:13001` — the gateway is a separate
  pod. The **reverse proxy** is the engine's own listener on **:8080**
  (the `cortex-<user>-r` route's dial target); `transparent_proxy_addr`
  (:18082) is an iptables-interception listener that drops direct
  connections and is not routable. The wake path skips terminating
  pods (a reaped pod is briefly still "ready" at its old IP) and
  retries once on a stale-IP dial failure.
- Three OpenShift admissions bit during rollout, each with its
  permission escape hatch added to the gateway ClusterRole: custom
  route hosts need `routes/custom-host` `create`; cross-namespace
  endpoint addresses need `endpoints/restricted` `create`; and the
  ClusterRole must be a **superset of the user Role** (RBAC refuses to
  grant permissions the granter lacks — provision creates that Role),
  plus `update` verbs for the Endpoints heal PUTs.

## Provisioning new users (first login)

`POST /__cortex/provision`, called by the SPA on first open with the
user's Bearer token (the gateway verifies it against the API server's
`users/~` — identity never comes from the request body). The gateway
then creates the namespace (labeled `cortex-user=<sanitized>`), the
user's Role/RoleBinding (`cortex-user-rbac.yaml` equivalent, embedded
in the gateway), and the instance object set. Idempotent, so every
login can call it. The SPA follows with heartbeats, which also ensure
the instance — replacing the SPA-era client-side object creation
entirely.

The admin surface (`/__cortex/heartbeat`, `/provision`, `/status`) is
plain HTTP on the gateway's :13002, reached **same-origin through the
app's nginx** via the `cortex-gw` edge route — not via a ClusterIP
(pods can't reach them on this cluster) and not via user routes
(which don't exist before first provisioning). nginx forwards the
`Authorization` header; the heartbeat is unauthenticated by design
(it only ever keeps an instance alive, and grants no access).

## What moves where (from Part 1)

| Concern | Before | After |
|---|---|---|
| TLS termination | per-user tls-front sidecar + N cert copies | shared gateway + 1 cert |
| Scale-up on page open | SPA PATCH replicas=1 | SPA heartbeat → gateway ensure/wake |
| Scale-to-0 on idle | unsolved | gateway sweep |
| Wake on proxy use | impossible (503) | gateway holds handshake during wake |
| Engine pod contents | cortex + agentop + tls-front | cortex + agentop |

Rejected alternatives: Knative Serving (right semantics, heavy new
dependency); dumb proxy + external reaper (no wake-on-use); never
reaping (fails the cost goal).

