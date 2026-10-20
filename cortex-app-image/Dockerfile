FROM docker.io/nginxinc/nginx-unprivileged:1.25-alpine

# The template is a COMPLETE nginx config (daemon/events/http), so the
# envsubst output must replace the main config, not land in conf.d/
# (where it would be http-included and "daemon" would be illegal).
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx

# nginx.conf.template is NOT baked in — it is mounted from ConfigMap
# cortex-nginx-template (see manifests/cortex-app.yaml) so config
# changes deploy without an image rebuild. cortex-app-image/nginx.conf.template
# in the repo is the source of truth for that ConfigMap.
# dist/ contains the hashed bundle AND a generated index.html that
# references it (scripts/hash-index.mjs) — cache-safe deploys.
COPY dist /usr/share/nginx/html

EXPOSE 8443
