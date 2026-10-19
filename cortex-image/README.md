# cortex-image

Build context for the per-user Cortex instance pod image
(`icr.io/vopo/cortex:latest` — the image the plugin's Deployment runs
as containers `cortex` and `agentop`).

Contents must provide, on ubuntu (bash available):

- `/cortex`   — the traffic engine (started with `--config
  /etc/cortex/cortex.yaml`)
- `/agentop`  — the observer CLI (`observe`, `cost`, `pipeline`,
  `pricing` subcommands)
- `tmux`      — the agentop container's TUI runs inside a detached tmux
  session (see buildObjects() in src/CortexPage.tsx)

The Dockerfile is maintained by the image owner and is not generated
from this repo.
