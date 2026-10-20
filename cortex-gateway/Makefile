# Cortex gateway image (static Go binary on scratch).
#
# Tag comes from package.json at the repo root — the SAME version
# numbers every published image (app, gateway, engine), so a deployed
# cluster is described by one version string.

IMAGE = ghcr.io/galmasi/cortex-gateway
TAG   = $(shell awk -F'"' '/"version"/ {print $$4}' ../package.json)

all: build

build:
	podman build -t $(IMAGE):$(TAG) .

publish: build
	podman push $(IMAGE):$(TAG)
