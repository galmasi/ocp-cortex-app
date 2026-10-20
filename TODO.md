# Cortex TODO

The GUI is basically usable now (login, instance ensure/start, live
terminal). Remaining work, roughly in no particular order:

- **Login screen** — the current one is very simple; needs a proper
  design. A **logo** needs to be produced for it.
- **Image naming** — app image is still `icr.io/vopo/cortex-app:0.1`
  (renaming it to `cortex` would collide with the per-user engine
  image `icr.io/vopo/cortex:latest`); settle together with the ghcr
  move. (Route/namespace/OAuthClient rename to `cortex` is done.)
- **Cortex reverse proxy routing** — make the per-user cortex reverse
  proxy available for use (routed).
- **Container images from ghcr** instead of icr.io.
- **Repository template** — there is a repository template we need to
  adhere to eventually.
- **Cortex pod image** — fill in the code to generate it
  (`cortex-image/`); most likely by having the cortex git repo as a
  submodule.
- **Cross-cluster deployability** — make the app deployable on other
  OpenShift clusters (a must; likely a Helm chart, but any
  parameterization works). The auth scheme itself is already
  portable — the app only talks to the cluster's OAuth server and
  apiserver, so any IdP the cluster supports works. What is
  epoc000-specific and hard-coded today:
  - `oauth-openshift.apps.<domain>` and `api.<domain>:6443` upstreams
    in the nginx template
  - route host `cortex.apps.<domain>` (manifest + OAuthClient
    redirectURI)
  - the ClusterIP workaround — upstreams point at the EXTERNAL
    apiserver endpoint because pods on epoc000 cannot reach service
    ClusterIPs; a healthy cluster should use
    `https://kubernetes.default.svc:6443` (serviceaccount CA
    verification already in place). Deploy should try the in-cluster
    endpoint first and fall back to the external one.
  - `scripts/reconcile.sh` per-user namespace/RBAC plumbing.
- **Persistent storage** for cortex (per-user instance state).
- **Cortex lifecycle** — start/stop/cleanup management for per-user
  instances is unsolved.
