# Cortex TODO

The GUI is basically usable now (login, instance ensure/start, live
terminal). Remaining work, roughly in no particular order:

- **Login screen** — the current one is very simple; needs a proper
  design. A **logo** needs to be produced for it.
- **Image naming** — app image is still `icr.io/vopo/cortex-app:0.1`
  (renaming it to `cortex` would collide with the per-user engine
  image `icr.io/vopo/cortex:latest`); settle together with the ghcr
  move. (Route/namespace/OAuthClient rename to `cortex` is done.)
- **Cortex reverse proxy routing** — DONE: the gateway serves the
  reverse proxy on `cortex-<user>-r.<domain>` (SNI `-r` suffix) and
  tunnels to the engine's own reverse-proxy listener (:8080).
- **Container images from ghcr** instead of icr.io.
- **Repository template** — there is a repository template we need to
  adhere to eventually.
- **Cortex pod image** — fill in the code to generate it
  (`cortex-image/`); most likely by having the cortex git repo as a
  submodule.
- **Remove the cluster-name (epoc000) dependency** — nothing should
  hard-code the cluster's name or domain; derive it at deploy/run time
  (`oc get ingress.config cluster -o jsonpath={.spec.domain}` gives
  the apps domain; the API endpoint comes from the in-cluster config).
  Current hard-codings to eliminate:
  - `apps.epoc000.ete14.res.ibm.com` in `CortexPage.tsx`
    (`CLUSTER_APPS_DOMAIN`), `manifests/cortex.yaml` +
    `manifests/gateway.yaml` (route hosts), the nginx template
    (cortex-gw upstream), and `cortex-gateway`'s `-apps-domain` flag
    (could be discovered from the ingress config at startup instead)
  - `api.epoc000.ete14.res.ibm.com:6443` nginx upstreams (see the
    ClusterIP workaround below)
  - `cortex-gateway`'s in-cluster apiserver dial is already
    cluster-agnostic (KUBERNETES_SERVICE_HOST), as is the
    ClusterIP-unreachability workaround (pod-IP endpoints)
- **Cross-cluster deployability** — make the app deployable on other
  OpenShift clusters (a must; likely a Helm chart, but any
  parameterization works). The auth scheme itself is already
  portable — the app only talks to the cluster's OAuth server and
  apiserver, so any IdP the cluster supports works. Mostly subsumed
  by removing the cluster-name dependency above; additionally:
  - route host `cortex.apps.<domain>` (manifest + OAuthClient
    redirectURI)
  - the ClusterIP workaround — upstreams point at the EXTERNAL
    apiserver endpoint because pods on epoc000 cannot reach service
    ClusterIPs; a healthy cluster should use
    `https://kubernetes.default.svc:6443` (serviceaccount CA
    verification already in place). Deploy should try the in-cluster
    endpoint first and fall back to the external one.
  - the epoc000 admissions/RBAC quirks the gateway already handles
    (`routes/custom-host`, `endpoints/restricted`, pod-IP endpoints)
    should be verified on a healthy cluster.
- **Persistent storage** for cortex (per-user instance state).
- **Cortex lifecycle** — DONE in design: the shared cortex-gateway
  (DESIGN.md Part 2) provisions on first login, wakes on proxy use,
  and reaps after idle. Implemented in `cortex-gateway/` +
  `manifests/gateway.yaml`; still needs cluster rollout + testing.
  Cleanup of namespaces for *deleted* cluster users remains unsolved
  (User-object watch or periodic sweep).
