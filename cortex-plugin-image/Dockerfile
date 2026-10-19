FROM docker.io/nginxinc/nginx-unprivileged:1.25-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html

EXPOSE 8443
