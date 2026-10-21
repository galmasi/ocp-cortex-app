#!/usr/bin/env bash
# Remove EVERY cortex object from a cluster — the mirror of
# scripts/deploy.sh. Leaves the cluster as if cortex was never there:
#
#   - every per-user namespace (label cortex-user), with all the
#     instances the gateway provisioned
#   - namespace cortex (app + gateway, routes, services, secrets
#     cortex-oauth / cortex-tls, SA, PDB)
#   - cluster-scoped: ClusterRole + ClusterRoleBinding cortex-gateway,
#     OAuthClient cortex
#
# Also drops the locally rendered manifests (manifests/rendered/).
#
# Requires: oc, cluster-admin login.
set -euo pipefail

cd "$(dirname "$0")/.."

oc whoami >/dev/null || { echo "not logged in" >&2; exit 1; }

USER_NS=$(oc get ns -l cortex-user -o name)
if [ -n "$USER_NS" ]; then
  echo "deleting user namespaces: $USER_NS"
  oc delete $USER_NS --wait=false
else
  echo "no user namespaces"
fi

# Cluster-scoped first, then the namespaces (oc delete of a namespace
# finalizes asynchronously; both are fired and awaited below).
oc delete clusterrole cortex-gateway --ignore-not-found
oc delete clusterrolebinding cortex-gateway --ignore-not-found
oc delete oauthclient cortex --ignore-not-found
oc delete ns cortex --wait=false

echo "waiting for namespaces to terminate…"
PENDING="$USER_NS namespace/cortex"
for i in $(seq 1 60); do
  LEFT=""
  for ns in $PENDING; do
    oc get "$ns" >/dev/null 2>&1 && LEFT="$LEFT $ns"
  done
  [ -z "$LEFT" ] && break
  sleep 10
done
if [ -n "$LEFT" ]; then
  echo "still terminating after 10m:$LEFT" >&2
  echo "check for finalizer issues: oc get $LEFT -o yaml" >&2
  exit 1
fi

rm -rf manifests/rendered
echo "cluster clean."
