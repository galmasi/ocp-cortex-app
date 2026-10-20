CORTEX_IMAGE=ghcr.io/galmasi/cortex-binaries
# Tag comes from package.json at the repo root — the SAME version
# numbers every published image (app, gateway, engine).
CORTEX_TAG=$(shell awk -F'"' '/"version"/ {print $$4}' ../package.json)

all: build

publish: build
	@podman push ${CORTEX_IMAGE}:${CORTEX_TAG}
	@podman tag ${CORTEX_IMAGE}:${CORTEX_TAG} ${CORTEX_IMAGE}:latest
	@podman push ${CORTEX_IMAGE}:latest


build: build-cortex build-agentop
	@podman build -t ${CORTEX_IMAGE}:${CORTEX_TAG} .

# Binaries land in bin/ (NOT inside the submodule — cmd/agentop is a Go
# package directory, so a binary can never sit at cortex/cmd/agentop,
# which is where the old -o flags wrote them, one level too deep).
build-agentop:
	@cd cortex && go build -o ../bin/agentop ./cmd/agentop

build-cortex:
	@cd cortex && go build -tags $$(go -C scripts/profile-tags run . full) -o ../bin/cortex ./cmd/cortex

clean:
	@${RM} -rf bin




