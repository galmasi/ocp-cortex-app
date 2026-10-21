# Cortex TODO

The GUI is basically usable now (login, instance ensure/start, live
terminal). Remaining work, roughly in no particular order:

- **TLS trust for in-engine clients (serious, not urgent)** — the
  gateway serves the router's Let's Encrypt wildcard cert on the
  per-user proxy routes, and browsers are happy, but agents running
  INSIDE the engine (e.g. Claude) apparently do not trust it. Unclear
  yet whether it's the LE chain served without intermediates, a
  missing system CA store in the engine image (Ubuntu 26.04 should
  have ca-certificates — verify it's installed), or SNI/proxy
  specifics. Reproduce with curl inside the engine pod, then fix
  (serve the full chain from `cortex-tls`, or install
  ca-certificates in the image).

- **Login screen** — logo (rossoctl.png) and version are on the page
  now; a proper overall design pass is still wanted.
- **Image naming** — app image is still `icr.io/vopo/cortex-app:0.1`
  (renaming it to `cortex` would collide with the per-user engine
  image `icr.io/vopo/cortex:latest`); settle together with the ghcr
  move. (Route/namespace/OAuthClient rename to `cortex` is done.)
- **Cortex reverse proxy routing** — DONE: the gateway serves the
  reverse proxy on `cortex-<user>-r.<domain>` (SNI `-r` suffix) and
  tunnels to the engine's own reverse-proxy listener (:8080).
- **Container images from ghcr** instead of icr.io — DONE: all three
  images are on `ghcr.io/galmasi/...` (public packages; per-image
  Makefiles for build/publish; `oc apply -k manifests/` deploys, with
  image overrides via kustomize). Remaining icr references are in
  retired/reference manifests only.
- **Repository template** — there is a repository template we need to
  adhere to eventually.
- **Cortex pod image** — fill in the code to generate it
  (`cortex-image/`); most likely by having the cortex git repo as a
  submodule.
- **Remove the cluster-name (epoc000) dependency** — DONE (0.14.0):
  `scripts/deploy.sh` discovers the apps domain from the cluster's
  ingress config, renders `manifests/*.template.yaml` (sed on
  `__TOKEN__`s, not envsubst — the nginx `${OAUTH_BASIC}` template
  must survive), creates the OAuthClient + `cortex-oauth` + `cortex-tls`
  (copied from the ingresscontroller's defaultCertificate) if missing,
  and applies. The SPA derives the OAuth server from its own origin;
  the gateway discovers the apps domain at startup (`-apps-domain`
  still overrides). Remaining epoc000-isms, all deliberate:
  - `--external-api` (nginx dials the external apiserver endpoint
    instead of `kubernetes.default.svc:443`) — needed only where pods
    cannot reach service ClusterIPs
  - the pod-IP Endpoints workaround (harmless on healthy clusters,
    just unnecessary)
  - the `routes/custom-host` + `endpoints/restricted` permissions
    (stock OpenShift restricts these too; harmless where it doesn't)
  - verified on epoc001 (0.15.x): in-cluster apiserver works, but a
    middlebox in front of it 403s websocket-upgrade execs — handled by
    the gateway exec relay (`/__cortex/exec`, WS<->SPDY with the
    user's token); the SPA falls back to it automatically.
- **Cross-cluster deployability** — DONE via `scripts/deploy.sh` on
  two clusters now: epoc000 (demo, frozen — do not redeploy) and
  epoc001 (main development box). Cluster quirks found so far: epoc000
  pods cannot reach service ClusterIPs (`--external-api`); epoc001's
  apiserver path blocks WS exec upgrades (gateway relay handles it).
  A Helm chart could replace deploy.sh later if parameterization
  outgrows sed.
- **Persistent storage** for cortex (per-user instance state).
- **Cortex lifecycle** — DONE in design: the shared cortex-gateway
  (DESIGN.md Part 2) provisions on first login, wakes on proxy use,
  and reaps after idle. Implemented in `cortex-gateway/` +
  `manifests/gateway.yaml`; still needs cluster rollout + testing.
  Cleanup of namespaces for *deleted* cluster users remains unsolved
  (User-object watch or periodic sweep).
