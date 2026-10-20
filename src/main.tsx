import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Page,
  PageSection,
  Card,
  CardBody,
  Spinner,
  Button,
} from '@patternfly/react-core';
import CortexPage from './CortexPage';
import { getStoredToken, handleCallback, startLogin, logout } from './auth';
import { getCurrentUser, ApiUnauthorizedError } from './api';
import { ClusterUser } from './auth';
import logoUrl from './rossoctl.png';
// PatternFly component styles — without this, Buttons/Cards/etc. render
// unstyled (white, flat).
import '@patternfly/react-core/dist/styles/base.css';
import './app.css';

// Injected at build time by DefinePlugin from package.json's version
// (same as on CortexPage — shown pre-login so the deployed version is
// visible without logging in).
declare const CORTEX_PLUGIN_VERSION: string | undefined;
const APP_VERSION =
  typeof CORTEX_PLUGIN_VERSION !== 'undefined' ? CORTEX_PLUGIN_VERSION : '?';

type AuthPhase =
  | { kind: 'boot' }
  | { kind: 'logged-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; token: string; user: ClusterUser };

/**
 * Auth gate for the standalone app. Restores the OAuth token from
 * sessionStorage (validating it against the API server), runs the
 * OAuth callback exchange when arriving back from the cluster login
 * page, and kicks off the login redirect otherwise.
 */
const App: React.FC = () => {
  const [phase, setPhase] = React.useState<AuthPhase>({ kind: 'boot' });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // OAuth callback (arriving back from the login page)?
        const fromCallback = await handleCallback();
        const token = fromCallback || getStoredToken();
        if (!token) {
          if (!cancelled) setPhase({ kind: 'logged-out' });
          return;
        }
        const user = await getCurrentUser(token);
        if (!cancelled) setPhase({ kind: 'ready', token, user });
      } catch (e) {
        if (!cancelled) setPhase({ kind: 'error', message: String((e as Error)?.message || e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSessionExpired = () => {
    logout(); // clears the token and reloads to the logged-out state
  };

  // sidebar={null} is required: without an EXPLICIT null, PatternFly keeps
  // the sidebar grid track reserved (~290px of dead white space on the
  // left, like an un-collapsible nav column).
  return (
    <Page sidebar={null}>
      {phase.kind === 'boot' && (
        <PageSection>
          <Spinner size="lg" />
        </PageSection>
      )}
      {phase.kind === 'logged-out' && (
        <>
          {/* Logo spans the top of the page, centered, scaling with the
              viewport (up to its natural size). */}
          <PageSection>
            <img
              src={logoUrl}
              alt="Cortex"
              style={{
                display: 'block',
                margin: '0 auto',
                width: 'min(100%, 720px)',
              }}
            />
          </PageSection>
          <PageSection>
            <Card>
              <CardBody>
                <p>Sign in with your cluster credentials to use Cortex.</p>
                <Button
                  variant="primary"
                  style={{ width: '100%', marginTop: '8px' }}
                  onClick={() => startLogin()}
                >
                  Log in with OpenShift
                </Button>
                <p style={{ marginTop: '16px', color: 'var(--pf-v5-global--Color--200)' }}>
                  v{APP_VERSION}
                </p>
              </CardBody>
            </Card>
          </PageSection>
        </>
      )}
      {phase.kind === 'error' && (
        <PageSection>
          <Card>
            <CardBody>
              <pre style={{ color: 'red', margin: 0 }}>{phase.message}</pre>
              <Button
                variant="secondary"
                style={{ marginTop: '16px' }}
                onClick={() => {
                  logout();
                }}
              >
                Start over
              </Button>
            </CardBody>
          </Card>
        </PageSection>
      )}
      {phase.kind === 'ready' && (
        <CortexPage
          token={phase.token}
          user={phase.user}
          onSessionExpired={onSessionExpired}
        />
      )}
    </Page>
  );
};

const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<App />);
