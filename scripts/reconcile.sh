#!/usr/bin/env bash
# Cortex reconciliation — stopgap for the future operator.
#
# For every registered cluster user (oc get users), ensures:
#   - namespace cortex-<sanitized-username> exists
#   - the cortex-user Role/RoleBinding is applied in that namespace
#   - secret cortex-tls exists (copy of the router's wildcard cert, so
#     each instance's tls-front sidecar can present the cluster cert;
#     clients trust it with no custom CA)
#
# Idempotent: safe to run repeatedly (e.g. from a CronJob).
#
# NOTE: the sanitization here must stay in sync with sanitize() in
# src/CortexPage.tsx — the plugin derives the same namespace name
# client-side from the logged-in user.
#
# Usage: KUBECONFIG=<cluster> ./reconcile.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RBAC_TEMPLATE="$SCRIPT_DIR/../manifests/templates/cortex-user-rbac.yaml"
# The router's wildcard cert (CN *.epoc000.ete14.res.ibm.com, Let's Encrypt
# signed, SANs cover *.apps.epoc000...). Update if the cluster cert rotates.
CLUSTER_CERT_SECRET="secret/xaas-postinstall-cert-secret-certpolicy-aws-route53-prod"
CLUSTER_CERT_NS="openshift-ingress"

sanitize() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9-]/-/g' -e 's/-\+/-/g' -e 's/^-\+//;s/-\+$//' \
    | cut -c1-63
}

for USER in $(oc get users -o jsonpath='{.items[*].metadata.name}'); do
  NS="cortex-$(sanitize "$USER")"

  if oc get namespace "$NS" >/dev/null 2>&1; then
    echo "$USER -> $NS (exists)"
  else
    oc create namespace "$NS" >/dev/null
    echo "$USER -> $NS (created)"
  fi

  sed -e "s/\${NAMESPACE}/$NS/" -e "s/\${USER}/$USER/" "$RBAC_TEMPLATE" \
    | oc apply -f - >/dev/null
  echo "  rbac ok"

  # Copy the cluster wildcard cert if missing or changed (ignore errors —
  # the cert source requires admin; instances without it stay plaintext).
  if ! oc -n "$NS" get secret cortex-tls >/dev/null 2>&1 \
     || ! diff <(oc -n "$NS" get secret cortex-tls -o json 2>/dev/null) \
               <(oc -n "$CLUSTER_CERT_NS" get "$CLUSTER_CERT_SECRET" \
                  -o json | jq --arg ns "$NS" \
                  'del(.metadata.namespace,.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.annotations,.metadata.ownerReferences) | .metadata.name="cortex-tls" | .metadata.namespace=$ns') >/dev/null 2>&1; then
    oc -n "$CLUSTER_CERT_NS" get "$CLUSTER_CERT_SECRET" -o json \
      | jq --arg ns "$NS" \
        'del(.metadata.namespace,.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.annotations,.metadata.ownerReferences) | .metadata.name="cortex-tls" | .metadata.namespace=$ns' \
      | oc apply -f - >/dev/null 2>&1 \
      && echo "  cert ok" || echo "  cert SKIPPED (no read access to $CLUSTER_CERT_NS/$CLUSTER_CERT_SECRET)"
  else
    echo "  cert ok (unchanged)"
  fi
done
