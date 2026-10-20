# Cortex standalone app

Per-user Cortex service control surface as a **standalone web app**,
using the cluster's own IAM (the OpenShift OAuth server — the same
login the console uses). Replaces the earlier OpenShift console
dynamic plugin (retired; see git history).

Served at `https://cortex.apps.epoc000.ete14.res.ibm.com`.
(`cortex.apps.<domain>` is the console itself on this cluster.)

## Layout

```
├── index template + src/        # React SPA (PatternFly, xterm.js)
│   ├── main.tsx                 # entry: auth gate -> CortexPage
│   ├── auth.ts                  # OAuth authorization-code flow
│   ├── api.ts                   # same-origin Kubernetes REST client
│   ├── CortexPage.tsx           # per-user instance ensure/start + UI
│   └── CortexTerminal.tsx       # tmux attach over exec WS (+resize)
├── cortex-app-image/            # app image build context (nginx)
│   ├── Dockerfile               # nginx-unprivileged, envsubst template
│   ├── nginx.conf.template      # SPA + OAuth exchange + API/WS proxy
│   └── dist/                    # webpack output lands here
├── cortex-image/                # per-user instance pod image (owner-
│   └── README.md                # maintained Dockerfile, not in repo)
├── manifests/
│   ├── cortex.yaml          # ns, Deployment, Service, Route
│   ├── oauthclient.yaml         # OAuthClient template (cluster-admin)
│   ├── deploy.yaml              # RETIRED plugin deploy (history)
│   └── templates/cortex-instance.yaml  # per-user instance reference
└── scripts/reconcile.sh         # per-user ns + RBAC + cert copies
```

## Architecture

The browser talks only to the app's own origin. nginx is the backend:

| Path | nginx does |
|---|---|
| `/` | serves the SPA (deep links fall back to index.html) |
| `/auth/exchange` | adds the OAuth client Basic-auth header (secret from `Secret cortex-oauth`, envsubst'ed into the config at startup) and forwards to the OAuth server's `/oauth/token` |
| `/api`, `/apis` | proxies to `kubernetes.default.svc:6443`, forwarding the browser's Bearer token (TLS verified against the serviceaccount CA) |
| `/ws/…` | exec/attach WebSockets; browsers cannot set headers on WebSocket, so the token rides as `?access_token=` and is moved into `Authorization` here. Prefix stripped. |

### Auth flow (authorization code)

1. No/invalid token → "Log in with OpenShift" → redirect to
   `oauth-openshift…/oauth/authorize` (`client_id=cortex`,
   `scope=user:full`, random `state`).
2. Cluster login page (same IdP as the console) → back to
   `/auth/callback?code=…&state=…`.
3. SPA POSTs the code to `/auth/exchange`; nginx adds the client
   secret and exchanges it; the access token lands in sessionStorage.
4. All API calls carry the user's own Bearer token — **per-user RBAC
   is enforced by the API server**, not by the app.

The client secret exists only in the `cortex-oauth` Secret and the
`cortex` OAuthClient; never in git or the JS bundle.

### Terminal

Exec (`tmux attach -t agentop`) over the `v5.channel.k8s.io`
WebSocket via `/ws/`. Kubernetes does not apply channel-4 resizes on
the WS exec path (PTY stays 0x0), so resizing is driven by a second
exec running `tmux resize-window` plus `stty` on each client tty —
see the comments in `CortexTerminal.tsx`.

## Deploy

```sh
npm install
npm run build                                   # -> cortex-app-image/dist
podman build -t icr.io/vopo/cortex-app:0.1 cortex-app-image/
podman push  icr.io/vopo/cortex-app:0.1
oc rollout restart deployment/cortex -n cortex
```

Bump `"version"` in package.json on every deploy (shown on the page).

Cluster-side prerequisites (one-time, cluster-admin — already applied
on epoc000):

- `manifests/cortex.yaml` applied
- `OAuthClient cortex` with a secret; matching
  `Secret cortex/cortex-oauth` with
  `OAUTH_BASIC = base64("cortex:<secret>")`
- `Secret cortex/cortex-tls` — copy of the router's wildcard
  cert (same procedure as `scripts/reconcile.sh`)

## Troubleshooting

- **`[oauth exchange: …]` on login** — the `cortex-oauth` Secret no
  longer matches the OAuthClient secret; regenerate both together.
- **401 loop** — token expired; "log out" and back in.
- **Terminal empty / no resize** — see `CortexTerminal.tsx` comments;
  resize execs are logged to the browser console as
  `[cortex] resize CxR`.
- The per-user instance itself (engine, tls-front, route, cert
  plumbing) is unchanged from the plugin era — see
  `manifests/templates/cortex-instance.yaml` and `DESIGN.md`.
