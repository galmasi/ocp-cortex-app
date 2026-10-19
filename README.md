# ocp-cortex-plugin

An OpenShift web-console **dynamic plugin** (the same extension mechanism
ACM uses to inject its pages into the console). This is the hello-world
version: a single "Cortex" page reachable from the console's left
navigation. It will grow into the per-user Cortex service control surface.

## What it does

Once installed and enabled, every user who opens the OpenShift console on
the cluster sees a **Cortex** section in the admin perspective navigation:

```
Home
Networking
...
Cortex            ← new section (from this plugin)
  Cortex          ← page at /cortex
```

The page renders "Hello, world!" with a button. No backend, no RBAC, no
cluster interaction yet — it only proves the plugin loads and renders.

## Project layout

```
ocp-cortex-plugin/
├── package.json               # includes `consolePlugin` metadata block
├── console-extensions.json    # declarative extension points (nav, page)
├── webpack.config.ts          # ConsoleRemotePlugin (module federation)
├── tsconfig.json
├── src/                       # the page components
├── cortex-plugin-image/       # console-plugin image build context
│   ├── Dockerfile             # nginx image serving the bundle
│   ├── nginx.conf             # serves it with CORS headers
│   └── dist/                  # webpack output (npm run build lands here)
├── cortex-image/              # per-user instance pod image build context
│   └── README.md              # Dockerfile owned by the image maintainer
├── scripts/
│   └── reconcile.sh           # per-user namespace + RBAC + cert copy
└── manifests/
    ├── deploy.yaml            # plugin Namespace, Deployment, Service, ConsolePlugin
    └── templates/cortex-instance.yaml  # per-user instance template
```

Key mechanics:

- `console-extensions.json` declares the extension points: a
  `console.navigation/section`, a `console.navigation/href`, and a
  `console.page/route` at `/cortex` whose component is the `$codeRef`
  `CortexPage`.
- `package.json`'s `consolePlugin` block maps that code ref to a source
  module via `exposedModules` and declares shared dependencies.
- `@openshift-console/dynamic-plugin-sdk-webpack` (the `ConsoleRemotePlugin`)
  bundles the exposed modules via webpack module federation and generates
  `cortex-plugin-image/dist/plugin-manifest.json`, which the console fetches from the plugin's
  in-cluster service.
- The console runs the plugin code inside its own session, in the user's
  browser — that is why no separate auth is needed for the plugin itself.

## Prerequisites

- Node.js 16+ and npm (tested with Node 24)
- `podman` or `docker` for the image build
- `oc` logged in to the target cluster with cluster-admin (enabling a
  plugin is a cluster-level setting)

**SDK version must match the cluster.** `@openshift-console/dynamic-plugin-sdk`
is versioned by console release (e.g. `4.22.0`). The console shares React,
PatternFly, and `@console/pluginAPI` with plugins as module-federation
singletons — a plugin built against an older SDK generation (React 17 /
PF4 / `@console/consoleUI`) fails client-side version negotiation and the
console lists it forever as *pending*. Check the cluster version with
`oc get clusterversion version` and pin both SDK packages to it.

## 1. Build the plugin bundle

```sh
npm install
npm run build
```

Output lands in `cortex-plugin-image/dist/` — notably `plugin-manifest.json`,
`plugin-entry.js`, and the exposed-module bundles.

## 2. Build the container image

```sh
podman build -t <registry>/cortex-plugin:latest cortex-plugin-image/
```

Replace `<registry>` with a registry the cluster can pull from. For the
cluster's internal registry:

```sh
# Expose the internal registry route (one-time, cluster-admin)
oc patch configs.imageregistry.operator.openshift.io/cluster \
  --type merge -p '{"spec":{"defaultRoute":true}}'
REGISTRY=$(oc get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}')
oc whoami -t | podman login $REGISTRY -u $(oc whoami) --password-stdin

podman tag cortex-plugin:latest $REGISTRY/cortex-plugin/cortex-plugin:latest
podman push $REGISTRY/cortex-plugin/cortex-plugin:latest
```

Then set that full image reference in `manifests/deploy.yaml`.

## 3. Deploy to the cluster

```sh
oc apply -f manifests/deploy.yaml
```

This creates namespace `cortex-plugin` with the Deployment, Service, and
the `ConsolePlugin` custom resource that registers the plugin.

## 4. Enable the plugin

Plugins are opt-in at the cluster level:

```sh
oc patch consoles.operator.openshift.io cluster \
  --type merge -p '{"spec":{"plugins":["cortex"]}}'
```

Wait ~1 minute for the console pods to reload, then hard-refresh the
browser (Ctrl-Shift-R). The **Cortex** section appears in the left nav.

## 5. Verify

```sh
oc get consoleplugin cortex
oc get pods -n cortex-plugin
# the manifest should be reachable through the console proxy (auth needed):
curl -k -H "Authorization: Bearer $(oc whoami -t)" \
  https://$(oc get route console -n openshift-console -o jsonpath='{.spec.host}')/api/plugins/cortex/plugin-manifest.json
```

## Troubleshooting

- **`spec.backend: Required value` on apply** — newer OpenShift (4.19+)
  wraps the service in `spec.backend.type: Service`; older clusters use
  the flat `spec.service` field. The manifest here uses the new shape.
- **`mkdir() "/var/cache/nginx/client_temp" failed (Permission denied)`** —
  OpenShift's restricted SCC runs containers with a random non-root UID.
  The base image is `nginxinc/nginx-unprivileged` for exactly this reason;
  don't switch back to the stock `nginx` image.
- **Plugin assets must be served over HTTPS** — the console requires a
  service serving certificate. This is handled by the
  `service.beta.openshift.io/serving-cert-secret-name` annotation on the
  Service, which makes the service-ca operator generate the
  `cortex-plugin-tls` Secret that nginx mounts at `/etc/nginx/certs`.

- **No nav item after enabling** — hard-refresh the browser; the plugin
  bundle is cached aggressively. Check `oc get consoleplugin cortex` shows
  the service reference, and `oc get pods -n cortex-plugin` is Running.
- **Plugin fails to load (console shows an error banner)** — look at the
  browser devtools network tab for `/api/plugins/cortex/plugin-manifest.json`.
  A 404 means the console can't reach the Service; a CORS error means the
  headers from `cortex-plugin-image/nginx.conf` are missing.
- **`console-extensions.json` schema error at build time** — the schema in
  `node_modules/@openshift-console/dynamic-plugin-sdk-webpack/schema/`
  is the source of truth for valid extension types.
- **Pin `@types/node` to v16** — newer versions break the SDK's TypeScript
  4.6-based config parser (already pinned in package.json).

## Next steps (roadmap to the full Cortex service)

1. **User identity:** SDK 1.x has no session-context hook; get the current
   user via the API's `~` shortcut:
   ```tsx
   const [user, loaded, error] = useK8sGet(UserModel, '~');
   ```
2. **Instance status:** watch the user's `Deployment`/`Route`
   (`cortex-haproxy-<username>`) with `useK8sWatchResource`.
3. **Config editor:** edit the user's `ConfigMap` (validated server-side
   with `haproxy -c`).
4. **Reconciler:** a separate controller that watches `User` objects and
   pre-provisions each user's Route/Service/Deployment/ConfigMap.
