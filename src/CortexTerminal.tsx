import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface CortexTerminalProps {
  namespace: string;
  pod: string;
  container: string;
  /** OAuth access token; browsers cannot set Authorization headers on
   * WebSocket, so it rides as ?access_token= and nginx injects the
   * header when proxying to the apiserver. */
  token: string;
}

/**
 * Interactive terminal attached to the agentop container's tmux session.
 *
 * Transport: the console backend's Kubernetes passthrough proxy
 * (/api/kubernetes/...), authenticated by the browser session. The
 * WebSocket uses the v5.channel.k8s.io binary subprotocol, where every
 * frame is prefixed with a channel byte:
 *   0 = stdin, 1 = stdout, 2 = stderr, 3 = error, 4 = terminal resize
 *
 * The container's PID 1 is a supervisor (bash) that starts a detached
 * tmux session named "agentop" running the TUI, so we connect with
 * exec (`tmux attach -t agentop`) rather than attach (which would show
 * the supervisor's silent stdout). tmux keeps the screen state
 * server-side, so every connect gets a full repaint and closing the
 * terminal doesn't kill anything.
 *
 * Sizing: Kubernetes does NOT apply the channel-4 resize on the
 * WebSocket path (empirically verified on this cluster — the exec/attach
 * PTY stays 0x0), and with it at 0x0 tmux defaults the session to 80x24.
 * The session's window-size is "manual", so instead we drive sizing by
 * opening a second, short-lived exec that runs
 * `tmux resize-window -t agentop -x <cols> -y <rows>` directly against
 * the tmux server socket — no keystrokes injected into the session.
 */
const CortexTerminal: React.FC<CortexTerminalProps> = ({
  namespace,
  pod,
  container,
  token,
}) => {
  const divRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const div = divRef.current;
    if (!div) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize: 12,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(div);
    fit.fit();

    // Same-origin proxy: nginx forwards /ws/... to the apiserver with
    // the Bearer token from ?access_token= (browsers cannot set headers
    // on WebSocket), stripping the /ws prefix.
    // NOTE: the WebSocket constructor REQUIRES an absolute ws:// or
    // wss:// URL — a relative path throws SyntaxError before any
    // request is made.
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${wsProto}://${window.location.host}` +
      `/ws/api/v1/namespaces/${encodeURIComponent(namespace)}` +
      `/pods/${encodeURIComponent(pod)}/exec`;
    // exec takes the command as repeated ?command= query params.
    // NOTE: build the query with encodeURIComponent, NOT URLSearchParams —
    // URLSearchParams uses the x-www-form-urlencoded serializer, which
    // percent-encodes "~" to %7E and thus corrupts sha256~ OAuth tokens
    // (encodeURIComponent leaves ~ unescaped).
    const execUrl = (cmd: string[]) => {
      const q = [
        `container=${encodeURIComponent(container)}`,
        'stdout=1',
        'stderr=1',
        `access_token=${encodeURIComponent(token)}`,
        ...cmd.map((c) => `command=${encodeURIComponent(c)}`),
      ];
      return `${base}?${q.join('&')}`;
    };
    const ws = new WebSocket(
      execUrl(['tmux', 'attach', '-t', 'agentop']) + '&stdin=1&tty=true',
      'v5.channel.k8s.io',
    );
    ws.binaryType = 'arraybuffer';

    let open = true;

    // Resize the tmux session AND every attached client's PTY.
    //
    // Two sizes matter and both are wrong without this: the session
    // (window-size manual, resized via `tmux resize-window`) and the
    // attached tmux client's own terminal. Kubernetes does not apply
    // channel-4 resizes on the WebSocket exec path (verified on this
    // cluster), so the exec PTY is 0x0 and tmux renders into an 80x24
    // box no matter how big the session or xterm.js are. tmux reports
    // its clients' ttys (`list-clients`), and `stty` can set another
    // pty's winsize via stdin redirect — the SIGWINCH makes the client
    // re-read its size and repaint at full size.
    // Debounced so browser drag-resizes don't open an exec per step.
    let resizeTimer: number | undefined;
    const resizeSession = () => {
      const dims = fit.proposeDimensions();
      if (!dims) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!open) return;
        // eslint-disable-next-line no-console
        console.debug('[cortex] resize', dims.cols, 'x', dims.rows);
        const script =
          `tmux resize-window -t agentop -x ${dims.cols} -y ${dims.rows}; ` +
          `for t in $(tmux list-clients -t agentop -F '#{client_tty}'); ` +
          `do stty cols ${dims.cols} rows ${dims.rows} < $t; done`;
        const rz = new WebSocket(execUrl(['bash', '-c', script]), 'v5.channel.k8s.io');
        // Surface failures instead of swallowing them, so a broken
        // resize path is diagnosable from the terminal itself.
        rz.onmessage = (ev: MessageEvent) => {
          const d = new Uint8Array(ev.data as ArrayBuffer);
          if (d[0] === 3) {
            term.write(
              `\r\n\x1b[31m[resize error] ${new TextDecoder().decode(d.subarray(1))}\x1b[0m\r\n`,
            );
          }
        };
        rz.onerror = () =>
          term.write('\r\n\x1b[31m[resize exec websocket error]\x1b[0m\r\n');
      }, 300);
    };

    ws.onopen = () => {
      // Match the tmux session to the on-screen terminal right away,
      // and once more after the attach has settled (guards against a
      // race with session creation on a fresh pod).
      resizeSession();
      window.setTimeout(resizeSession, 1500);
    };

    // Terminal query responder. TUIs (bubbletea/termenv) probe the
    // terminal at startup — OSC 11 (background color) and CSI 6n (cursor
    // position) — and block until an answer arrives. A real terminal
    // emulator answers; xterm.js does not, so we answer for it. Without
    // this, full-screen TUIs like `agentop observe` hang forever at
    // "initializing…" even though everything else works.
    let recent = ''; // rolling tail of the pod's output, for query matching
    const sendString = (s: string) => {
      const buf = new Uint8Array(s.length + 1);
      buf[0] = 0;
      for (let i = 0; i < s.length; i++) buf[i + 1] = s.charCodeAt(i);
      ws.send(buf);
    };
    const answerQueries = (payload: Uint8Array) => {
      recent = (recent + new TextDecoder().decode(payload)).slice(-64);
      // OSC 11 query (BEL- or ST-terminated) -> report a black background
      if (/\x1b\]11;\?(?:\x07|\x1b\\)/.test(recent)) {
        sendString('\x1b]11;rgb:0000/0000/0000\x1b\\');
        recent = '';
      }
      // Primary device attributes -> claim VT102 with no extensions
      if (/\x1b\[c/.test(recent)) {
        sendString('\x1b[?6c');
        recent = '';
      }
      // Cursor position report -> home
      if (/\x1b\[6n/.test(recent)) {
        sendString('\x1b[1;1R');
        recent = '';
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const channel = data[0];
      const payload = data.subarray(1);
      switch (channel) {
        case 1: // stdout
        case 2: // stderr
          answerQueries(payload);
          term.write(payload);
          break;
        case 3: // error channel
          term.write(`\r\n\x1b[31m[exec error] ${new TextDecoder().decode(payload)}\x1b[0m\r\n`);
          break;
      }
    };

    ws.onerror = () =>
      term.write('\r\n\x1b[31m[socket error]\x1b[0m\r\n');
    ws.onclose = () => {
      if (open) term.write('\r\n\x1b[31m[connection closed]\x1b[0m\r\n');
    };

    // Keystrokes -> stdin (channel 0 prefix).
    const dataSub = term.onData((input) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const buf = new Uint8Array(input.length + 1);
      buf[0] = 0;
      for (let i = 0; i < input.length; i++) buf[i + 1] = input.charCodeAt(i);
      ws.send(buf);
    });

    // Keep the tmux session sized to the on-screen terminal.
    const resizeSub = term.onResize(() => resizeSession());
    const onWindowResize = () => fit.fit();
    window.addEventListener('resize', onWindowResize);

    return () => {
      open = false;
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', onWindowResize);
      resizeSub.dispose();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [namespace, pod, container, token]);

  return (
    <div
      ref={divRef}
      style={{
        height: '480px',
        padding: '4px',
        backgroundColor: '#000',
      }}
    />
  );
};

export default CortexTerminal;
