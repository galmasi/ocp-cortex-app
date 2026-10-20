# Cortex app image (nginx + SPA bundle).
#
# The SPA bundle (cortex-app-image/dist/) is produced by `npm run build`
# at the repo root — webpack writes straight into this directory — so
# the default target builds it first. The tag tracks package.json's
# "version", which must be bumped every deploy (it shows on the page).

IMAGE = ghcr.io/galmasi/cortex-app
TAG   = $(shell awk -F'"' '/"version"/ {print $$4}' ../package.json)

all: build

build:
	npm --prefix .. run build
	podman build -t $(IMAGE):$(TAG) .

publish: build
	podman push $(IMAGE):$(TAG)
