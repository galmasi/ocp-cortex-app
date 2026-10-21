#!/usr/bin/env bash
# Deploy the Cortex standalone app + gateway to an OpenShift cluster.
#
# Everything cluster-specific is discovered or parameterized here:
# the apps domain comes from the cluster's ingress config, the SPA
# derives the OAuth server from its own origin, and the gateway
# discovers the domain at startup. Nothing needs editing per cluster.
#
# Usage:
#   scripts/deploy.sh [--external-api]
#
#   --external-api   nginx dials the EXTERNAL apiserver endpoint
#                    (https://api.<cluster>:6443) instead of the
#                    in-cluster service. Needed on clusters where pods
#                    cannot reach service ClusterIPs (epoc000 does);
#                    healthy clusters should NOT use this.
#
# Requires: oc, cluster-admin login, jq.
#
# Idempotent: re-running only re-applies manifests; existing
# OAuthClient/secret/cert objects are left alone.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$PWD
RENDERED=manifests/rendered

# --- defaults / flags -------------------------------------------------------
APP_IMAGE=${APP_IMAGE:-ghcr.io/galmasi/cortex-app}
GATEWAY_IMAGE=${GATEWAY_IMAGE:-ghcr.io/galmasi/cortex-gateway}
VERSION=$(awk -F'"' '/"version"/ {print $4}' package.json)
EXTERNAL_API=0
while [ $# -gt 0 ]; do
  case $1 in
    --external-api) EXTERNAL_API=1 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

# --- preflight --------------------------------------------------------------
for tool in oc jq; do
  command -v $tool >/dev/null || { echo "need $tool in PATH" >&2; exit 1; }
done
oc whoami >/dev/null || { echo "not logged in" >&2; exit 1; }

# --- cluster discovery ------------------------------------------------------
APPS_DOMAIN=$(oc get ingress.config cluster -o jsonpath='{.spec.domain}')
[ -n "$APPS_DOMAIN" ] || { echo "cluster has no apps domain?" >&2; exit 1; }

if [ "$EXTERNAL_API" = 1 ]; then
  # e.g. https://api.epoc000.ete14.res.ibm.com:6443 -> host, keep port
  SERVER=$(oc whoami --show-server)
  API_UPSTREAM=${SERVER#https://}; API_UPSTREAM=${API_UPSTREAM%%/*}
  API_UPSTREAM_HOST=${API_UPSTREAM%%:*}
  API_UPSTREAM_PORT=${API_UPSTREAM##*:}
else
  API_UPSTREAM_HOST=kubernetes.default.svc
  API_UPSTREAM_PORT=443
fi

echo "apps domain : $APPS_DOMAIN"
echo "api upstream: $API_UPSTREAM_HOST:$API_UPSTREAM_PORT"
echo "images      : $APP_IMAGE:$VERSION, $GATEWAY_IMAGE:$VERSION"

# --- render -----------------------------------------------------------------
# Plain sed with __TOKEN__ markers — deliberately NOT envsubst, because
# cortex.template.yaml embeds the nginx ${OAUTH_BASIC} template that
# must reach the cluster untouched.
mkdir -p $RENDERED
for t in cortex gateway; do
  sed -e "s|__APPS_DOMAIN__|$APPS_DOMAIN|g" \
      -e "s|__API_UPSTREAM__|$API_UPSTREAM_HOST|g" \
      -e "s|__API_UPSTREAM_PORT__|$API_UPSTREAM_PORT|g" \
      -e "s|__APP_IMAGE__|$APP_IMAGE:$VERSION|g" \
      -e "s|__GATEWAY_IMAGE__|$GATEWAY_IMAGE:$VERSION|g" \
      manifests/$t.template.yaml > $RENDERED/$t.yaml
done

# --- namespace + secrets + OAuthClient FIRST -------------------------------
# The Route references Secret cortex-tls (externalCertificate) and the
# router must already be authorized to read it (router-cert-reader),
# so these exist before the manifests are applied.

oc create namespace cortex 2>/dev/null || true

if ! oc get oauthclient cortex >/dev/null 2>&1; then
  OAUTH_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
  oc process -f manifests/oauthclient.yaml \
    -p DOMAIN="$APPS_DOMAIN" -p SECRET="$OAUTH_SECRET" | oc apply -f -
  oc create secret generic cortex-oauth -n cortex \
    --from-literal=OAUTH_BASIC=$(printf 'cortex:%s' "$OAUTH_SECRET" | base64 -w0)
  echo "created OAuthClient cortex + Secret cortex/cortex-oauth"
else
  echo "OAuthClient cortex exists — leaving it (and cortex-oauth) alone"
fi

if ! oc get secret cortex-tls -n cortex >/dev/null 2>&1; then
  # The wildcard cert the ROUTER serves (ingresscontroller default);
  # the gateway terminates per-user route TLS with it.
  CERT_NAME=$(oc get ingresscontroller default -n openshift-ingress-operator \
    -o jsonpath='{.spec.defaultCertificate.name}')
  if [ -z "$CERT_NAME" ]; then
    echo "ERROR: ingresscontroller has no defaultCertificate, and there" >&2
    echo "is no Secret cortex/cortex-tls. Create it manually (wildcard" >&2
    echo "cert for *.$APPS_DOMAIN) and re-run." >&2
    exit 1
  else
    oc get secret "$CERT_NAME" -n openshift-ingress -o json \
      | jq 'del(.metadata.namespace,.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields) | .metadata.name="cortex-tls"' \
      | oc apply -n cortex -f -
    echo "copied router cert $CERT_NAME -> Secret cortex/cortex-tls"
  fi
fi

# --- apply rendered manifests ----------------------------------------------
# Retry once: the router-cert-reader RoleBinding lands moments before
# the Route references the secret, and RBAC propagation can lag.
for attempt in 1 2; do
  if oc apply -f $RENDERED/cortex.yaml && oc apply -f $RENDERED/gateway.yaml; then
    break
  fi
  if [ $attempt = 2 ]; then echo "manifest apply failed" >&2; exit 1; fi
  echo "apply failed — waiting 10s for RBAC propagation, retrying…"
  sleep 10
done

# --- wait -------------------------------------------------------------------
oc rollout status deployment/cortex-gateway -n cortex --timeout=300s
oc rollout status deployment/cortex -n cortex --timeout=300s

echo
echo "Cortex: https://cortex.$APPS_DOMAIN  (v$VERSION)"
