# Cortex gateway image (static Go binary on scratch).

IMAGE = ghcr.io/galmasi/cortex-gateway
TAG   = 0.4

all: build

build:
	podman build -t $(IMAGE):$(TAG) .

publish: build
	podman push $(IMAGE):$(TAG)
