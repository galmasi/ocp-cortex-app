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
import './app.css';

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
        <PageSection>
          <Card>
            <CardBody>
              <p>Sign in with your cluster credentials to use Cortex.</p>
              <Button variant="primary" onClick={() => startLogin()}>
                Log in with OpenShift
              </Button>
            </CardBody>
          </Card>
        </PageSection>
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
