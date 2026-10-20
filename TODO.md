# Cortex TODO

The GUI is basically usable now (login, instance ensure/start, live
terminal). Remaining work, roughly in no particular order:

- **Login screen** — the current one is very simple; needs a proper
  design. A **logo** needs to be produced for it.
- **Rename application** `cortex-app` → `cortex` (image name, cluster
  namespace/deployment/route, OAuthClient, repo dir naming).
- **Cortex reverse proxy routing** — make the per-user cortex reverse
  proxy available for use (routed).
- **Container images from ghcr** instead of icr.io.
- **Repository template** — there is a repository template we need to
  adhere to eventually.
- **Cortex pod image** — fill in the code to generate it
  (`cortex-image/`); most likely by having the cortex git repo as a
  submodule.
- **Persistent storage** for cortex (per-user instance state).
- **Cortex lifecycle** — start/stop/cleanup management for per-user
  instances is unsolved.
