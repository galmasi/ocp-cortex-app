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
