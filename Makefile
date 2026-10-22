# Root Makefile — builds/publishes all three images with one command.
# Each sub-Makefile derives its tag from package.json, so a deployed
# cluster is described by one version string.
#
#   make          # build app, gateway and engine-binaries images
#   make publish  # build and push all three

SUBMAKES = cortex-app-image cortex-gateway cortex-pod-image

all: build

build:
	@for d in $(SUBMAKES); do \
		echo "== $$d =="; \
		$(MAKE) -C $$d build || exit 1; \
	done

publish:
	@for d in $(SUBMAKES); do \
		echo "== $$d =="; \
		$(MAKE) -C $$d publish || exit 1; \
	done

# Only the SPA bundle (cortex-app-image/dist/, webpack output) and the
# engine Go binaries (cortex-pod-image/bin/) are generated in-tree;
# the gateway image has no byproducts. Both are gitignored.
clean:
	@${RM} -rf cortex-app-image/dist
	@$(MAKE) -C cortex-pod-image clean

.PHONY: all build publish clean
