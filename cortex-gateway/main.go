// Command cortex-gateway is the shared TLS front for all per-user
// cortex instances. See DESIGN.md, "Part 2 — gateway".
//
// One deployment per cluster:
//
//   - TLS listener :13000 — SNI demux (cortex-<user>[-r].apps…),
//     wake-on-connect: the engine Deployment is created/scaled up
//     inside the TLS handshake, so a cold start looks like a slow
//     handshake to the client. After the handshake, the plaintext
//     stream is tunneled to the user's engine pod.
//   - plain HTTP :13002 — /__cortex/* endpoints (heartbeat, provision,
//     status), reached same-origin through the app's nginx via the
//     cortex-gw edge route; never exposed on a user route.
//   - idle reaper — scales a user's Deployment to 0 once neither
//     proxy traffic nor SPA heartbeat has been seen for -idle-timeout.
//
// epoc000 quirks this works around: pods cannot reach service
// ClusterIPs, so the engine is dialed by POD IP (never through its
// Service), and Routes cannot target Services in another namespace,
// so each user namespace gets a selector-less Service + Endpoints
// pinned to this gateway's ClusterIP.
//
// The instance object set built here mirrors what src/CortexPage.tsx
// created in the SPA era; sanitize() must stay in sync with the TS
// and bash copies.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

var (
	appsDomain  = flag.String("apps-domain", "", "cluster apps domain; route hosts are cortex-<user>[-r].<domain> (default: discovered from the cluster's ingress config)")
	tlsAddr     = flag.String("tls-addr", ":13000", "TLS listener: SNI demux + proxy traffic")
	adminAddr   = flag.String("admin-addr", ":13002", "plain HTTP listener for /__cortex/*")
	idleTimeout = flag.Duration("idle-timeout", 30*time.Minute, "scale an engine to 0 after this long without traffic or heartbeat")
	wakeTimeout = flag.Duration("wake-timeout", 3*time.Minute, "max wait for a cold engine to become Ready")
	certFile    = flag.String("cert", "/cert/tls.crt", "cluster wildcard certificate")
	keyFile     = flag.String("key", "/cert/tls.key", "cluster wildcard key")
	wakeMinGap  = flag.Duration("wake-min-gap", 10*time.Second, "minimum spacing between scale-up patches per user (anti-thrash)")
)

const (
	engineFwdPort = 13001 // engine forward proxy (listener.forward_proxy_addr)
	engineRevPort = 8080  // engine reverse proxy ("Reverse server listening" :8080 — NOT
	// the transparent interceptor, which drops direct
	// connections as self-referential)
	engineTransparentPort = 18082 // transparent_proxy_addr (interception-only listener)
	sessionAPIPort        = 19095
	cortexImage           = "ghcr.io/galmasi/cortex-binaries:latest"

	gatewayNS      = "cortex"
	gatewaySvcName = "cortex-gateway" // our own Service; ClusterIP is pinned into every user's Endpoints
	userRoleName   = "cortex-user"
)

// ---------------------------------------------------------------------------
// Kubernetes REST client (in-cluster, serviceaccount credentials).
// Deliberately stdlib-only: the gateway needs GET/POST/PATCH/PUT on a
// handful of paths, not client-go.

type kube struct {
	base  string
	token string
	hc    *http.Client
}

func newKube() (*kube, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" {
		return nil, errors.New("not running in a cluster (KUBERNETES_SERVICE_HOST unset)")
	}
	const sa = "/var/run/secrets/kubernetes.io/serviceaccount"
	token, err := os.ReadFile(sa + "/token")
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(sa + "/ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("bad serviceaccount CA")
	}
	return &kube{
		base:  "https://" + net.JoinHostPort(host, port),
		token: string(token),
		hc: &http.Client{Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool},
		}},
	}, nil
}

// req issues a request with the gateway's own serviceaccount token.
func (k *kube) req(method, path string, body []byte, contentType string) (int, []byte, error) {
	return k.reqAs(method, path, body, contentType, k.token)
}

// reqAs issues a request with an arbitrary token (used to verify user
// tokens during provisioning — identity always comes from the API
// server, never from the request payload).
func (k *kube) reqAs(method, path string, body []byte, contentType, token string) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	r, err := http.NewRequest(method, k.base+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	r.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	resp, err := k.hc.Do(r)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return resp.StatusCode, b, err
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// ---------------------------------------------------------------------------
// Names: route host ⇄ user ⇄ namespace. Keep in sync with sanitize()
// in src/CortexPage.tsx and scripts/reconcile.sh.

var (
	nonsanitize = regexp.MustCompile(`[^a-z0-9-]+`)
	collapse    = regexp.MustCompile(`-+`)
)

func sanitize(name string) string {
	s := nonsanitize.ReplaceAllString(strings.ToLower(name), "-")
	s = collapse.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 63 {
		s = s[:63]
	}
	if s == "" {
		s = "user"
	}
	return s
}

func nsFor(user string) string { return "cortex-" + sanitize(user) }

// parseSNI maps a route host to (namespace, reverseProxy?). The host IS
// the namespace name with an optional "-r" suffix for the reverse
// proxy route: cortex-alice / cortex-alice-r.
func parseSNI(host string) (ns string, reverse bool, ok bool) {
	host = strings.ToLower(host)
	if d := "." + *appsDomain; d != "." && strings.HasSuffix(host, d) {
		host = strings.TrimSuffix(host, d)
	}
	if strings.HasSuffix(host, "-r") {
		host, reverse = strings.TrimSuffix(host, "-r"), true
	}
	if !strings.HasPrefix(host, "cortex-") || len(host) <= len("cortex-") {
		return "", false, false
	}
	return host, reverse, true
}

// ---------------------------------------------------------------------------
// Object paths (mirrors resourcePath() in the old CortexPage.tsx).

func metaOf(o map[string]any) map[string]any {
	m, _ := o["metadata"].(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func nameOf(o map[string]any) string { s, _ := metaOf(o)["name"].(string); return s }
func kindOf(o map[string]any) string { s, _ := o["kind"].(string); return s }

func collectionPath(o map[string]any) string {
	ns := metaOf(o)["namespace"]
	switch kindOf(o) {
	case "Namespace":
		return "/api/v1/namespaces"
	case "ConfigMap":
		return fmt.Sprintf("/api/v1/namespaces/%s/configmaps", ns)
	case "Secret":
		return fmt.Sprintf("/api/v1/namespaces/%s/secrets", ns)
	case "Service":
		return fmt.Sprintf("/api/v1/namespaces/%s/services", ns)
	case "Endpoints":
		return fmt.Sprintf("/api/v1/namespaces/%s/endpoints", ns)
	case "Deployment":
		return fmt.Sprintf("/apis/apps/v1/namespaces/%s/deployments", ns)
	case "Route":
		return fmt.Sprintf("/apis/route.openshift.io/v1/namespaces/%s/routes", ns)
	case "Role", "RoleBinding":
		return fmt.Sprintf("/apis/rbac.authorization.k8s.io/v1/namespaces/%s/%ss", ns, strings.ToLower(kindOf(o)))
	default:
		panic("unhandled kind " + kindOf(o))
	}
}

func objectPath(o map[string]any) string {
	if kindOf(o) == "Namespace" {
		return collectionPath(o) + "/" + nameOf(o)
	}
	return collectionPath(o) + "/" + nameOf(o)
}

// ---------------------------------------------------------------------------
// Per-user instance objects. Mirrors manifests/templates/cortex-instance.yaml
// (minus the tls-front sidecar, which this gateway replaces) and the
// object set CortexPage.tsx used to create client-side.

func cortexConfigYaml(user string) string {
	return fmt.Sprintf(`listener:
  # All interfaces: the shared gateway terminates TLS and dials this
  # pod's IP directly (it is NOT a sidecar — loopback would be
  # unreachable from it, which is why the old tls-front design bound
  # 127.0.0.1).
  forward_proxy_addr: ":%d"
  # The transparent interceptor (iptables-style redirection; not usable
  # as a plain reverse proxy — direct connections are dropped as
  # self-referential). Must NOT collide with the reverse server, which
  # the engine binds on :8080 by default (engineRevPort, our dial
  # target for the cortex-<user>-r route).
  transparent_proxy_addr: ":%d"
  # Default reverse proxy backend (Curvebender); user-changeable from
  # the plugin page, which rewrites this line and restarts the engine.
  reverse_proxy_backend: "https://litellm.cb.ete.res.ibm.com"
  session_api_addr: "127.0.0.1:%d"

tls_bridge:
  # Terminate agent egress TLS so the outbound pipeline (inference
  # parser, a2a) sees decrypted HTTPS. The signing CA is the
  # gateway-generated Secret cortex-ca, mounted read-only at
  # /etc/cortex/ca (tls.crt/tls.key/ca.crt) — persistent across
  # restarts, never regenerated here (generate_ca stays false so a
  # missing Secret fails loudly instead of silently forging leaves).
  mode: enabled
  ca_dir: /etc/cortex/ca
  generate_ca: false

pipeline:
  outbound:
    plugins:
      - name: inference-parser
      - name: a2a-parser

# generated for cluster user %s
`, engineFwdPort, engineTransparentPort, sessionAPIPort, user)
}

// genCA creates the engine CA — the Go equivalent of
//
//	openssl req -x509 -newkey rsa:2048 -nodes \
//	  -subj "/CN=authbridge-local-ca" -days 365 \
//	  -addext "basicConstraints=critical,CA:TRUE"
//
// (done in-process: the gateway image is FROM scratch, no openssl).
// Cortex issues its tls_bridge leaf certificates from this CA; the CA
// itself lives in Secret cortex-ca and survives restarts.
//
// One CA per gateway process: buildInstance runs on every wake, and
// RSA keygen is too slow to repeat per handshake. Existing namespaces
// keep their own Secret (ensureObject is create-if-missing), and
// cortex always reads the CA from the mount — a gateway restart never
// invalidates CAs already issued.
var (
	caOnce   sync.Once
	caCrtPEM []byte
	caKeyPEM []byte
	caGenErr error
)

// upstreamCA is the public root store handed to the engine pods. The
// engine image is FROM scratch — no /etc/ssl/certs — so its Go TLS
// (the reverse proxy's default transport, the tls_bridge re-origination
// client) would fail every public-CA certificate with "x509:
// certificate signed by unknown authority". Go's SystemCertPool honors
// SSL_CERT_FILE on Linux, so the bundle is mounted as a ConfigMap and
// named by that env var; curl/git in the engine pick it up too.
//
//go:embed upstream-ca.pem
var upstreamCA []byte

func genCA() (certPEM, keyPEM []byte, err error) {
	caOnce.Do(func() {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			caGenErr = err
			return
		}
		tmpl := &x509.Certificate{
			SerialNumber:          big.NewInt(time.Now().UnixNano()),
			Subject:               pkix.Name{CommonName: "authbridge-local-ca"},
			NotBefore:             time.Now().Add(-time.Hour), // clock-skew tolerance
			NotAfter:              time.Now().Add(365 * 24 * time.Hour),
			KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
			BasicConstraintsValid: true, // critical CA:TRUE
			IsCA:                  true,
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if err != nil {
			caGenErr = err
			return
		}
		caCrtPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		caKeyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	})
	return caCrtPEM, caKeyPEM, caGenErr
}

func (g *gateway) buildInstance(ns, user string) []map[string]any {
	san := sanitize(user)
	labels := map[string]any{"app": "cortex", "cortex-user": san}
	meta := func(name string) map[string]any {
		return map[string]any{"name": name, "namespace": ns, "labels": labels}
	}
	caCrt, caKey, err := genCA()
	if err != nil {
		// Provision cannot proceed without the CA; surface loudly.
		log.Fatalf("genCA for %s: %v", ns, err)
	}
	return []map[string]any{
		{
			"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta("cortex-config"),
			"data": map[string]any{"cortex.yaml": cortexConfigYaml(user)},
		},
		{
			// CA for the engine's tls_bridge leaf certificates.
			// ensureObject is create-if-missing, so the CA is written
			// once at first provision and never clobbered. Mounted
			// read-only at /etc/cortex/ca: cortex issues per-pod leaf
			// certs from this CA, so trust in the CA survives engine
			// restarts and pod replacement.
			"apiVersion": "v1", "kind": "Secret", "metadata": meta("cortex-ca"),
			"data": map[string]any{
				"tls.crt": base64.StdEncoding.EncodeToString(caCrt),
				"tls.key": base64.StdEncoding.EncodeToString(caKey),
				// ca.crt = the trust anchor clients load (same CA as
				// tls.crt; cortex hands it to agents).
				"ca.crt": base64.StdEncoding.EncodeToString(caCrt),
			},
		},
		{
			// Public root store for the engine (see upstreamCA above).
			"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta("cortex-upstream-ca"),
			"data": map[string]any{"ca.pem": string(upstreamCA)},
		},
		{
			"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta("cortex"),
			"spec": map[string]any{
				"replicas": 1,
				"selector": map[string]any{"matchLabels": map[string]any{"app": "cortex"}},
				"template": map[string]any{
					"metadata": map[string]any{"labels": labels},
					"spec": map[string]any{
						"containers": []any{
							map[string]any{
								// The traffic engine. Plaintext, localhost-only;
								// this gateway is its sole ingress.
								"name":    "cortex",
								"image":   cortexImage,
								"command": []any{"/cortex"},
								"args":    []any{"--config", "/etc/cortex/cortex.yaml"},
								"env": []any{map[string]any{
									// The engine's TLS trust anchor (see upstreamCA).
									"name": "SSL_CERT_FILE", "value": "/etc/cortex/upstream-ca/ca.pem",
								}},
								"volumeMounts": []any{
									map[string]any{"name": "config", "mountPath": "/etc/cortex", "readOnly": true},
									map[string]any{"name": "ca", "mountPath": "/etc/cortex/ca", "readOnly": true},
									map[string]any{"name": "upstream-ca", "mountPath": "/etc/cortex/upstream-ca", "readOnly": true},
								},
								"resources": map[string]any{
									"requests": map[string]any{"cpu": "100m", "memory": "128Mi"},
									"limits":   map[string]any{"cpu": "2", "memory": "1Gi"},
								},
							},
							map[string]any{
								// The interactive observer: detached tmux session
								// "agentop" kept alive by a supervisor loop; the
								// terminal attaches with `tmux attach -t agentop`.
								"name":    "agentop",
								"image":   cortexImage,
								"command": []any{"/bin/bash", "-c"},
								"args": []any{
									fmt.Sprintf(`tmux new -d -s agentop /agentop observe --endpoint http://127.0.0.1:%d; `+
										`tmux set-option -t agentop -w window-size manual; `+
										`while tmux has-session -t agentop 2>/dev/null; do sleep 30; done`, sessionAPIPort),
								},
								"env":   []any{map[string]any{"name": "TERM", "value": "xterm-256color"}},
								"tty":   true,
								"stdin": true,
								"resources": map[string]any{
									"requests": map[string]any{"cpu": "50m", "memory": "64Mi"},
									"limits":   map[string]any{"cpu": "1", "memory": "256Mi"},
								},
							},
						},
						"volumes": []any{
							map[string]any{"name": "config", "configMap": map[string]any{"name": "cortex-config"}},
							map[string]any{"name": "ca", "secret": map[string]any{"secretName": "cortex-ca"}},
							map[string]any{"name": "upstream-ca", "configMap": map[string]any{"name": "cortex-upstream-ca"}},
						},
					},
				},
			},
		},
		{
			// Selector-less Service: per-user Routes cannot target the
			// gateway's Service in the cortex namespace, so each user
			// namespace gets a local Service whose Endpoints (below)
			// are pinned to the gateway's ClusterIP.
			"apiVersion": "v1", "kind": "Service", "metadata": meta("cortex-gateway"),
			"spec": map[string]any{
				"ports": []any{map[string]any{"name": "proxy", "port": 13000, "protocol": "TCP"}},
			},
		},
		{
			"apiVersion": "v1", "kind": "Endpoints", "metadata": meta("cortex-gateway"),
			"subsets": []any{map[string]any{
				"addresses": addrMaps(g.gatewayAddrs()),
				// The port NAME must match the Routes' targetPort
				// ("proxy") — the endpointslice mirroring controller
				// copies it from here, and the router matches
				// backends by name (an unnamed port = empty backend).
				"ports": []any{map[string]any{"name": "proxy", "port": 13000, "protocol": "TCP"}},
			}},
		},
		{
			// Forward proxy route (passthrough: SNI names the proxy, so
			// the router routes by SNI; we terminate TLS with the
			// cluster wildcard).
			"apiVersion": "route.openshift.io/v1", "kind": "Route", "metadata": meta("cortex"),
			"spec": map[string]any{
				"host": ns + "." + *appsDomain,
				"to":   map[string]any{"kind": "Service", "name": "cortex-gateway", "weight": 100},
				"port": map[string]any{"targetPort": "proxy"},
				"tls":  map[string]any{"termination": "passthrough"},
			},
		},
		{
			// Reverse proxy route (engine's transparent_proxy listener).
			"apiVersion": "route.openshift.io/v1", "kind": "Route", "metadata": meta("cortex-r"),
			"spec": map[string]any{
				"host": ns + "-r." + *appsDomain,
				"to":   map[string]any{"kind": "Service", "name": "cortex-gateway", "weight": 100},
				"port": map[string]any{"targetPort": "proxy"},
				"tls":  map[string]any{"termination": "passthrough"},
			},
		},
	}
}

// userRBAC mirrors manifests/templates/cortex-user-rbac.yaml — the
// Role + RoleBinding granting the user rights over their own
// namespace only.
func userRBAC(ns, user string) []map[string]any {
	labels := map[string]any{"app": "cortex"}
	role := map[string]any{
		"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
		"metadata": map[string]any{"name": userRoleName, "namespace": ns, "labels": labels},
		"rules": []any{
			map[string]any{"apiGroups": []any{""}, "resources": []any{"pods", "pods/exec"}, "verbs": []any{"get", "list", "watch", "create"}},
			map[string]any{"apiGroups": []any{"apps"}, "resources": []any{"deployments"}, "verbs": []any{"get", "list", "watch", "create", "patch"}},
			map[string]any{"apiGroups": []any{""}, "resources": []any{"configmaps"}, "verbs": []any{"get", "list", "watch", "create", "patch"}},
			map[string]any{"apiGroups": []any{""}, "resources": []any{"services"}, "verbs": []any{"get", "list", "watch", "create"}},
			map[string]any{"apiGroups": []any{"route.openshift.io"}, "resources": []any{"routes"}, "verbs": []any{"get", "list", "watch", "create"}},
		},
	}
	binding := map[string]any{
		"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
		"metadata": map[string]any{"name": userRoleName, "namespace": ns, "labels": labels},
		"roleRef":  map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": userRoleName},
		"subjects": []any{map[string]any{"kind": "User", "name": user, "apiGroup": "rbac.authorization.k8s.io"}},
	}
	return []map[string]any{role, binding}
}

// ---------------------------------------------------------------------------
// Gateway state: the wildcard cert, our Service's ClusterIP, and the
// per-user idle table.

type userState struct {
	mu            sync.Mutex
	lastUse       time.Time
	conns         int
	lastWakePatch time.Time
}

type gateway struct {
	kube  *kube
	cert  *tls.Certificate
	users sync.Map // user → *userState

	addrMu    sync.Mutex
	addrs     []string // our pod IPs (what user Endpoints point at)
	addrsAsOf time.Time
}

func (g *gateway) stateFor(user string) *userState {
	stAny, _ := g.users.LoadOrStore(user, &userState{lastUse: time.Now()})
	return stAny.(*userState)
}

func (g *gateway) touch(user string) {
	st := g.stateFor(user)
	st.mu.Lock()
	st.lastUse = time.Now()
	st.mu.Unlock()
}

func (g *gateway) enter(user string) {
	st := g.stateFor(user)
	st.mu.Lock()
	st.conns++
	st.mu.Unlock()
}

func (g *gateway) exit(user string) {
	st := g.stateFor(user)
	st.mu.Lock()
	st.conns--
	if st.conns < 0 {
		st.conns = 0
	}
	st.mu.Unlock()
}

// rateAllows bounds wake PATCHes per user so a connection flooder
// cannot thrash the API server.
func (g *gateway) rateAllows(user string) bool {
	st := g.stateFor(user)
	st.mu.Lock()
	defer st.mu.Unlock()
	if time.Since(st.lastWakePatch) < *wakeMinGap {
		return false
	}
	st.lastWakePatch = time.Now()
	return true
}

// gatewayAddrs returns the current gateway pod IPs — the addresses
// the per-user Endpoints point at. The router dials endpoint
// addresses directly and never the ClusterIP, which is unreachable on
// this cluster, so the endpoints must be the pods themselves.
// Refreshed with a 30s TTL; healEndpoints converges on drift.
func (g *gateway) gatewayAddrs() []string {
	g.addrMu.Lock()
	if g.addrs != nil && time.Since(g.addrsAsOf) < 30*time.Second {
		defer g.addrMu.Unlock()
		return g.addrs
	}
	g.addrMu.Unlock()

	var addrs []string
	code, body, err := g.kube.req("GET",
		"/api/v1/namespaces/"+gatewayNS+"/pods?labelSelector="+url.QueryEscape("app="+gatewaySvcName), nil, "")
	if err == nil && code == 200 {
		var pl struct {
			Items []struct {
				Status struct {
					PodIP             string `json:"podIP"`
					ContainerStatuses []struct {
						Name  string `json:"name"`
						Ready bool   `json:"ready"`
					} `json:"containerStatuses"`
				} `json:"status"`
			} `json:"items"`
		}
		if json.Unmarshal(body, &pl) == nil {
			for _, p := range pl.Items {
				ready := false
				for _, c := range p.Status.ContainerStatuses {
					if c.Name == "gateway" && c.Ready {
						ready = true
					}
				}
				if ready && p.Status.PodIP != "" {
					addrs = append(addrs, p.Status.PodIP)
				}
			}
		}
	}
	g.addrMu.Lock()
	if len(addrs) > 0 {
		g.addrs = addrs
		g.addrsAsOf = time.Now()
	}
	defer g.addrMu.Unlock()
	return g.addrs
}

// ---------------------------------------------------------------------------
// Ensure / wake / reap.

func (g *gateway) ensureObject(o map[string]any) error {
	path := objectPath(o)
	code, _, err := g.kube.req("GET", path, nil, "")
	if err != nil {
		return err
	}
	if code == 200 {
		// Endpoints drift if our Service is ever recreated; heal them.
		if kindOf(o) == "Endpoints" {
			g.healEndpoints(path, o)
		}
		return nil
	}
	if code != 404 {
		return fmt.Errorf("get %s: %d", path, code)
	}
	code, body, err := g.kube.req("POST", collectionPath(o), mustJSON(o), "application/json")
	if err != nil {
		return err
	}
	// 409 = a concurrent wake or provision won the race; that's fine.
	if code >= 300 && code != 409 {
		return fmt.Errorf("create %s: %s", collectionPath(o), body)
	}
	return nil
}

// addrMaps converts IP strings to Endpoints address objects.
func addrMaps(ips []string) []any {
	var out []any
	for _, ip := range ips {
		out = append(out, map[string]any{"ip": ip})
	}
	return out
}

// addrsOf extracts the sorted address IPs from an Endpoints object.
func addrsOf(o map[string]any) []string {
	var ips []string
	sub, _ := o["subsets"].([]any)
	for _, s := range sub {
		m, _ := s.(map[string]any)
		addrs, _ := m["addresses"].([]any)
		for _, a := range addrs {
			am, _ := a.(map[string]any)
			ip, _ := am["ip"].(string)
			if ip != "" {
				ips = append(ips, ip)
			}
		}
	}
	sort.Strings(ips)
	return ips
}

func sameAddrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (g *gateway) healEndpoints(path string, want map[string]any) {
	code, body, err := g.kube.req("GET", path, nil, "")
	if err != nil || code != 200 {
		return
	}
	var cur map[string]any
	if json.Unmarshal(body, &cur) != nil {
		return
	}
	wantSubsets := string(mustJSON(want["subsets"]))
	curSubsets := string(mustJSON(cur["subsets"]))
	if curSubsets == wantSubsets {
		return
	}
	cur["subsets"] = want["subsets"]
	pcode, pbody, perr := g.kube.req("PUT", path, mustJSON(cur), "application/json")
	if perr != nil || pcode >= 300 {
		log.Printf("heal endpoints %s failed: %v (code %d) body: %.500s", path, perr, pcode, pbody)
		return
	}
	log.Printf("healed endpoints %s -> %s", path, wantSubsets)
}

// ensureInstance idempotently creates the full per-user object set and
// scales the Deployment up if the reaper had stopped it. Safe to call
// concurrently (races surface as 409s, tolerated above).
func (g *gateway) ensureInstance(ctx context.Context, user string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ns := nsFor(user)
	for _, o := range g.buildInstance(ns, user) {
		if err := g.ensureObject(o); err != nil {
			return err
		}
	}
	depPath := "/apis/apps/v1/namespaces/" + ns + "/deployments/cortex"
	code, body, err := g.kube.req("GET", depPath, nil, "")
	if err != nil {
		return err
	}
	if code == 404 {
		return nil // created just above; nothing to scale
	}
	if code >= 300 {
		return fmt.Errorf("get deployment cortex/%s: %s", ns, body)
	}
	var d struct {
		Spec struct {
			Replicas *int `json:"replicas"`
		} `json:"spec"`
	}
	if json.Unmarshal(body, &d) != nil {
		return nil
	}
	if d.Spec.Replicas != nil && *d.Spec.Replicas == 0 && g.rateAllows(user) {
		patch := []byte(`[{"op":"replace","path":"/spec/replicas","value":1}]`)
		code, body, err := g.kube.req("PATCH", depPath, patch, "application/json-patch+json")
		if err != nil {
			return err
		}
		if code >= 300 {
			return fmt.Errorf("scale up cortex/%s: %s", ns, body)
		}
		log.Printf("woke %s", ns)
	}
	return nil
}

// waitForEngine blocks until a pod of the user's Deployment has a
// Ready "cortex" container, returning its POD IP (pods on this cluster
// cannot reach service ClusterIPs, so we never dial the Service).
func (g *gateway) waitForEngine(ctx context.Context, ns string) (string, error) {
	path := "/api/v1/namespaces/" + ns + "/pods?labelSelector=" + url.QueryEscape("app=cortex")
	for {
		code, body, err := g.kube.req("GET", path, nil, "")
		if err == nil && code == 200 {
			var pl struct {
				Items []struct {
					Metadata struct {
						DeletionTimestamp *string `json:"deletionTimestamp"`
					} `json:"metadata"`
					Status struct {
						PodIP             string `json:"podIP"`
						ContainerStatuses []struct {
							Name  string `json:"name"`
							Ready bool   `json:"ready"`
						} `json:"containerStatuses"`
					} `json:"status"`
				} `json:"items"`
			}
			if json.Unmarshal(body, &pl) == nil {
				for _, p := range pl.Items {
					// A pod being reaped is briefly still "ready" with
					// its old IP — dialing it fails. Only live pods.
					if p.Metadata.DeletionTimestamp != nil {
						continue
					}
					for _, c := range p.Status.ContainerStatuses {
						if c.Name == "cortex" && c.Ready && p.Status.PodIP != "" {
							return p.Status.PodIP, nil
						}
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("engine in %s not ready: %v", ns, ctx.Err())
		case <-time.After(time.Second):
		}
	}
}

// reapLoop scales engines to 0 for users idle past -idle-timeout with
// no live connections. Only users the gateway has seen (heartbeat or
// connection) are tracked; instances never touched by the gateway are
// left as they are.
// healLoop keeps every user namespace's cortex-gateway Endpoints pinned
// to the current gateway pod IPs. Those Endpoints are selector-less
// (per-user Routes cannot target a Service in the cortex namespace), so
// they are written only at provision time — a gateway rollout changes
// pod IPs and leaves every user route pointing at dead pods, and the
// wake path that would heal them runs through those very routes.
// Chicken-and-egg; break it from inside the gateway.
func (g *gateway) healLoop() {
	for range time.Tick(30 * time.Second) {
		code, body, err := g.kube.req("GET",
			"/api/v1/namespaces?labelSelector="+url.QueryEscape("cortex-user"), nil, "")
		if err != nil || code != 200 {
			continue
		}
		var nl struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
			} `json:"items"`
		}
		if json.Unmarshal(body, &nl) != nil {
			continue
		}
		meta := map[string]any{"name": "cortex-gateway"}
		want := map[string]any{
			"apiVersion": "v1", "kind": "Endpoints", "metadata": meta,
			"subsets": []any{map[string]any{
				"addresses": addrMaps(g.gatewayAddrs()),
				// Port NAME must match the Routes' targetPort ("proxy").
				"ports": []any{map[string]any{"name": "proxy", "port": 13000, "protocol": "TCP"}},
			}},
		}
		for _, ns := range nl.Items {
			meta["namespace"] = ns.Metadata.Name
			g.healEndpoints("/api/v1/namespaces/"+ns.Metadata.Name+"/endpoints/cortex-gateway", want)
		}
	}
}

func (g *gateway) reapLoop() {
	for range time.Tick(time.Minute) {
		cutoff := time.Now().Add(-*idleTimeout)
		g.users.Range(func(k, v any) bool {
			user, st := k.(string), v.(*userState)
			st.mu.Lock()
			idle := st.conns == 0 && st.lastUse.Before(cutoff)
			st.mu.Unlock()
			if !idle {
				return true
			}
			ns := nsFor(user)
			patch := []byte(`[{"op":"replace","path":"/spec/replicas","value":0}]`)
			code, _, err := g.kube.req("PATCH",
				"/apis/apps/v1/namespaces/"+ns+"/deployments/cortex",
				patch, "application/json-patch+json")
			if err == nil && code < 300 {
				log.Printf("reaped %s (idle > %s)", ns, *idleTimeout)
			}
			return true
		})
	}
}

// ---------------------------------------------------------------------------
// TLS listener: wake happens inside the handshake.

func (g *gateway) serveTLS(l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			log.Print(err)
			continue
		}
		go g.handleTLSConn(conn)
	}
}

func (g *gateway) handleTLSConn(raw net.Conn) {
	defer raw.Close()
	// Cover the handshake (and any wake it triggers) with the wake
	// timeout, then clear it for the proxied stream.
	_ = raw.SetDeadline(time.Now().Add(*wakeTimeout))
	tlsConn := tls.Server(raw, &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			ns, _, ok := parseSNI(hello.ServerName)
			if !ok {
				return nil, fmt.Errorf("unrecognized host %q", hello.ServerName)
			}
			user := strings.TrimPrefix(ns, "cortex-")
			g.touch(user)
			ctx, cancel := context.WithTimeout(context.Background(), *wakeTimeout)
			defer cancel()
			if err := g.ensureInstance(ctx, user); err != nil {
				return nil, err
			}
			if _, err := g.waitForEngine(ctx, ns); err != nil {
				return nil, err
			}
			return g.cert, nil
		},
	})
	if err := tlsConn.Handshake(); err != nil {
		// Wake failure or client hangup; the client sees a failed (or
		// very slow) handshake. Nothing else to do.
		return
	}
	_ = raw.SetDeadline(time.Time{})
	ns, reverse, ok := parseSNI(tlsConn.ConnectionState().ServerName)
	if !ok {
		return
	}
	g.proxyConn(tlsConn, ns, reverse)
}

// dialEngine connects to an engine pod. With tls_bridge enabled cortex
// autogenerates its own certificate per pod and serves TLS — we cannot
// pin a per-pod cert, so verification is skipped: this hop is the
// private pod network, to a pod IP we ourselves resolved inside the
// user's namespace, and the plain-TCP dial it replaces carried no
// verification either. Engines still running without tls_bridge answer
// the TLS handshake with garbage (or nothing): on handshake failure we
// fall back to a plain connection, so old and new engines coexist.
func (g *gateway) dialEngine(ip string, port int) (net.Conn, error) {
	addr := net.JoinHostPort(ip, strconv.Itoa(port))
	raw, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, err
	}
	tlsBackend := tls.Client(raw, &tls.Config{InsecureSkipVerify: true}) //nolint:gosec
	_ = tlsBackend.SetDeadline(time.Now().Add(5 * time.Second))
	if err := tlsBackend.Handshake(); err == nil {
		_ = tlsBackend.SetDeadline(time.Time{})
		return tlsBackend, nil
	}
	raw.Close()
	return net.DialTimeout("tcp", addr, 10*time.Second)
}

// proxyConn tunnels the decrypted stream to the user's engine pod.
func (g *gateway) proxyConn(tlsConn *tls.Conn, ns string, reverse bool) {
	defer tlsConn.Close()
	user := strings.TrimPrefix(ns, "cortex-")
	port := engineFwdPort
	if reverse {
		port = engineRevPort
	}
	g.enter(user)
	defer g.exit(user)
	// Normally already Ready (the handshake waited); this is a cheap
	// fast-exit poll that also yields the pod IP.
	ctx, cancel := context.WithTimeout(context.Background(), *wakeTimeout)
	defer cancel()
	ip, err := g.waitForEngine(ctx, ns)
	if err != nil {
		log.Printf("proxy %s: %v", ns, err)
		return
	}
	backend, err := g.dialEngine(ip, port)
	if err != nil {
		// Stale pod IP (pod replaced between lookup and dial): refresh
		// once and retry before giving up.
		log.Printf("dial %s:%d failed (%v); refreshing", ip, port, err)
		ip, err = g.waitForEngine(ctx, ns)
		if err != nil {
			log.Printf("proxy %s: %v", ns, err)
			return
		}
		backend, err = g.dialEngine(ip, port)
		if err != nil {
			log.Printf("dial %s:%d: %v", ip, port, err)
			return
		}
	}
	defer backend.Close()
	// io.Copy from the bufio.Reader includes any peeked/buffered bytes.
	br := &touchReader{r: tlsConn, g: g, user: user}
	done := make(chan struct{}, 1)
	go func() { _, _ = io.Copy(backend, br); done <- struct{}{} }()
	go func() { _, _ = io.Copy(tlsConn, backend); done <- struct{}{} }()
	<-done
}

// touchReader refreshes the user's idle timer as bytes flow (at most
// once per 30s — the timer is minute-granularity anyway).
type touchReader struct {
	r    io.Reader
	g    *gateway
	user string
	last time.Time
}

func (t *touchReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 && time.Since(t.last) > 30*time.Second {
		t.last = time.Now()
		t.g.touch(t.user)
	}
	return n, err
}

// ---------------------------------------------------------------------------
// Admin surface (plain HTTP :13002, same-origin via the app nginx and
// the cortex-gw edge route — never exposed on a user route).

// handleHeartbeat: "the console page is open". Unauthenticated by
// design — it only ever keeps an instance alive / wakes it, and grants
// no access. Also triggers instance ensure (page open ⇒ pod wanted).
func (g *gateway) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	user := r.URL.Query().Get("user")
	if user == "" {
		http.Error(w, "user required", http.StatusBadRequest)
		return
	}
	g.touch(user)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := g.ensureInstance(ctx, user); err != nil {
			log.Printf("heartbeat ensure %s: %v", user, err)
		}
	}()
	_, _ = w.Write([]byte("ok"))
}

// handleProvision: first-login namespace + RBAC + instance bootstrap.
// Identity comes from the caller's own token, verified by the API
// server — never from the request body.
func (g *gateway) handleProvision(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		http.Error(w, "Authorization: Bearer required", http.StatusUnauthorized)
		return
	}
	code, body, err := g.kube.reqAs("GET", "/apis/user.openshift.io/v1/users/~", nil, "", token)
	if err != nil || code != 200 {
		http.Error(w, "token not accepted by the API server", http.StatusUnauthorized)
		return
	}
	var u struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
	}
	if json.Unmarshal(body, &u) != nil || u.Metadata.Name == "" {
		http.Error(w, "bad user object", http.StatusInternalServerError)
		return
	}
	user := u.Metadata.Name
	ns := nsFor(user)

	// Namespace (cluster-scoped; the one thing the user's own token
	// cannot do, and the reason this endpoint exists).
	nsObj := map[string]any{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]any{
			"name":   ns,
			"labels": map[string]any{"app": "cortex", "cortex-user": sanitize(user)},
		},
	}
	if err := g.ensureObject(nsObj); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for _, o := range userRBAC(ns, user) {
		if err := g.ensureObject(o); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := g.ensureInstance(ctx, user); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(mustJSON(map[string]any{"user": user, "namespace": ns}))
}

// handleStatus: idle-table dump for debugging.
func (g *gateway) handleStatus(w http.ResponseWriter, r *http.Request) {
	type row struct {
		User    string    `json:"user"`
		LastUse time.Time `json:"lastUse"`
		Conns   int       `json:"conns"`
	}
	var rows []row
	g.users.Range(func(k, v any) bool {
		st := v.(*userState)
		st.mu.Lock()
		defer st.mu.Unlock()
		rows = append(rows, row{User: k.(string), LastUse: st.lastUse, Conns: st.conns})
		return true
	})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(mustJSON(map[string]any{"users": rows, "gatewayAddrs": g.gatewayAddrs()}))
}

// ---------------------------------------------------------------------------
// exec relay (websocket <-> SPDY)

// Some clusters (epoc001: OpenShift 4.20 behind an API middlebox) 403
// every websocket-upgrade request to the apiserver's exec/attach
// endpoints — even in-cluster, even for admin, even for oc itself (oc
// silently falls back to SPDY, which the middlebox allows). Browsers
// cannot speak SPDY, so the SPA cannot exec directly on such clusters.
//
// This endpoint is the shim: the browser opens a websocket to the
// gateway speaking the SAME v5.channel.k8s.io framing it would use
// against the apiserver, and the gateway runs the exec over SPDY with
// the USER's token — the apiserver still enforces that user's RBAC,
// and this gateway gains no privilege it did not have.

var wsUpgrader = websocket.Upgrader{
	Subprotocols: []string{"v5.channel.k8s.io", "v4.channel.k8s.io"},
	// Browsers send Origin (https://cortex.<apps-domain>) while nginx
	// rewrites Host to the cortex-gw route, so gorilla's default
	// same-host check rejects every browser connection. Allow origins
	// on this cluster's apps domain (and non-browser clients, which
	// send no Origin) — the exec itself is authorized by the user's
	// token, which the apiserver validates.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		return err == nil && u.Host != "" &&
			(strings.HasSuffix(u.Host, "."+*appsDomain) || u.Host == *appsDomain)
	},
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
}

// wsTermQueue feeds remotecommand's resize channel from channel-4
// websocket frames.
type wsTermQueue struct {
	ch chan remotecommand.TerminalSize
}

func (q *wsTermQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q.ch
	if !ok {
		return nil
	}
	return &s
}

func (g *gateway) handleExec(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ns, pod, container, token := q.Get("ns"), q.Get("pod"), q.Get("container"), q.Get("access_token")
	cmds := q["command"]
	if ns == "" || pod == "" || token == "" || len(cmds) == 0 {
		http.Error(w, "ns, pod, command, access_token required", http.StatusBadRequest)
		return
	}

	ws, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("exec: websocket upgrade: %v", err)
		return
	}
	defer ws.Close()
	log.Printf("exec: relay %s/%s container=%s cmd=%q", ns, pod, container, cmds)

	// SPDY executor with the user's token (in-cluster apiserver, SA CA).
	cfg, err := rest.InClusterConfig()
	if err != nil {
		log.Printf("exec: in-cluster config: %v", err)
		return
	}
	cfg.BearerToken = token
	cfg.BearerTokenFile = ""

	execURL, err := url.Parse(cfg.Host)
	if err != nil {
		log.Printf("exec: apiserver url: %v", err)
		return
	}
	execURL.Path = fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/exec", ns, pod)
	v := url.Values{}
	for _, c := range cmds {
		v.Add("command", c)
	}
	v.Set("container", container)
	v.Set("stdin", strconv.FormatBool(q.Get("stdin") != ""))
	// Always ask the apiserver for stdout+stderr: with either absent,
	// client-go's SPDY stream setup blocks forever waiting for the
	// stream the apiserver never opens (verified empirically — same
	// class of hang as Stdin below). The browser just ignores the
	// channel frames it did not ask for.
	v.Set("stdout", "true")
	v.Set("stderr", "true")
	v.Set("tty", strconv.FormatBool(q.Get("tty") != ""))
	execURL.RawQuery = v.Encode()

	exec, err := remotecommand.NewSPDYExecutor(cfg, "POST", execURL)
	if err != nil {
		log.Printf("exec: spdy executor: %v", err)
		return
	}

	// Channel framing matches v5.channel.k8s.io: every frame's first
	// byte is the channel (0 stdin, 1 stdout, 2 stderr, 3 error,
	// 4 resize). Writes are serialized; reads happen in this loop only.
	var wmu sync.Mutex
	send := func(ch byte, data []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		buf := make([]byte, len(data)+1)
		buf[0] = ch
		copy(buf[1:], data)
		_ = ws.WriteMessage(websocket.BinaryMessage, buf)
	}

	stdinR, stdinW := io.Pipe()
	queue := &wsTermQueue{ch: make(chan remotecommand.TerminalSize, 4)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	streamDone := make(chan error, 1)
	go func() {
		opts := remotecommand.StreamOptions{
			Stdout:            writerFunc(func(p []byte) (int, error) { send(1, p); return len(p), nil }),
			Stderr:            writerFunc(func(p []byte) (int, error) { send(2, p); return len(p), nil }),
			Tty:               q.Get("tty") != "",
			TerminalSizeQueue: queue,
		}
		// Only wire Stdin when the caller asked for it: with stdin
		// absent from the exec request the apiserver never opens the
		// input stream, and a non-nil Stdin makes remotecommand block
		// forever waiting for it (verified empirically).
		if q.Get("stdin") != "" {
			opts.Stdin = stdinR
		}
		err := exec.StreamWithContext(ctx, opts)
		stdinW.Close() // unblocks a pending stdin write
		streamDone <- err
	}()

	go func() {
		// When the exec finishes, tell the browser why (error channel
		// 3, like the apiserver would) and close the websocket.
		err := <-streamDone
		log.Printf("exec: stream finished: %v", err)
		if err != nil {
			send(3, []byte(err.Error()))
		}
		_ = ws.Close()
	}()

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			cancel()
			return
		}
		if len(data) == 0 {
			continue
		}
		switch data[0] {
		case 0: // stdin
			if _, err := stdinW.Write(data[1:]); err != nil && !errors.Is(err, io.ErrClosedPipe) {
				log.Printf("exec: stdin: %v", err)
			}
		case 4: // terminal resize {"Width":n,"Height":n}
			var s struct {
				Width  uint16 `json:"Width"`
				Height uint16 `json:"Height"`
			}
			if err := json.Unmarshal(data[1:], &s); err == nil && (s.Width > 0 || s.Height > 0) {
				select {
				case queue.ch <- remotecommand.TerminalSize{Width: s.Width, Height: s.Height}:
				default: // drop rather than block the read loop; latest wins anyway
				}
			}
		}
	}
}

// writerFunc adapts a func into an io.Writer.
type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// ---------------------------------------------------------------------------
// main

// discoverAppsDomain reads the cluster's ingress config — the same
// place `oc get ingress.config cluster` reports. Used when
// -apps-domain is not given, so the gateway is cluster-agnostic by
// default.
func discoverAppsDomain(k *kube) (string, error) {
	var cfg struct {
		Spec struct {
			Domain string `json:"domain"`
		} `json:"spec"`
	}
	code, body, err := k.req("GET", "/apis/config.openshift.io/v1/ingresses/cluster", nil, "")
	if err != nil {
		return "", err
	}
	if code != 200 {
		return "", fmt.Errorf("ingress.config/cluster: %d %s", code, body)
	}
	if err := json.Unmarshal([]byte(body), &cfg); err != nil || cfg.Spec.Domain == "" {
		return "", fmt.Errorf("ingress.config/cluster: no spec.domain (%s)", body)
	}
	return cfg.Spec.Domain, nil
}

func main() {
	flag.Parse()
	k, err := newKube()
	if err != nil {
		log.Fatal(err)
	}
	if *appsDomain == "" {
		if *appsDomain, err = discoverAppsDomain(k); err != nil {
			log.Fatalf("-apps-domain not given and discovery failed: %v", err)
		}
	}
	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Fatal(err)
	}
	g := &gateway{kube: k, cert: &cert}

	go g.reapLoop()
	go g.healLoop()

	adminMux := http.NewServeMux()
	adminMux.HandleFunc("/__cortex/heartbeat", g.handleHeartbeat)
	adminMux.HandleFunc("/__cortex/provision", g.handleProvision)
	adminMux.HandleFunc("/__cortex/status", g.handleStatus)
	adminMux.HandleFunc("/__cortex/exec", g.handleExec)
	go func() {
		log.Fatal(http.ListenAndServe(*adminAddr, adminMux))
	}()

	l, err := net.Listen("tcp", *tlsAddr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("cortex-gateway: tls %s admin %s apps-domain %s idle %s",
		*tlsAddr, *adminAddr, *appsDomain, *idleTimeout)
	g.serveTLS(l)
}
