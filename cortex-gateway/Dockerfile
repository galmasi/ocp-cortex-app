# cortex-gateway — see DESIGN.md "Part 2 — gateway".
FROM docker.io/library/golang:1.22 AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/cortex-gateway .

FROM scratch
COPY --from=build /out/cortex-gateway /cortex-gateway
# No system CA store needed: the apiserver is reached with the
# serviceaccount CA, and the engine pods by plain TCP.
ENTRYPOINT ["/cortex-gateway"]
