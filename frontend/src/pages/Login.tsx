import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { GoogleAuth, useAuth } from '../auth';
import { Notice } from '../ui';

export const Login = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/dashboard', { replace: true });
    }
  }, [user, navigate, location.state]);

  return (
    <main id="main" className="app-login">
      <div className="app-login__panel pane-surface">
        <span className="app-login__mark" aria-hidden="true">
          <CalendarClock />
        </span>
        <h1 className="pane-title-1">Email Scheduler</h1>
        <p className="pane-secondary">Write once, and send it on your schedule.</p>

        {error && <Notice tone="error">{error}</Notice>}

        <GoogleAuth onError={setError} />

        <p className="pane-footnote pane-secondary">
          Sign in with Google. Only your name and email address are used.
        </p>
      </div>
    </main>
  );
};
