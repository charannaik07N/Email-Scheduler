import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Clock, RotateCcw, Send, TriangleAlert } from 'lucide-react';
import type { EmailStatus } from '../types';

/* Small building blocks shared by the pages, styled with Pane classes. */

const STATUS: Record<EmailStatus, { label: string; className: string; Icon: typeof Clock }> = {
  SCHEDULED: { label: 'Scheduled', className: 'pane-badge--accent', Icon: Clock },
  RETRYING: { label: 'Retrying', className: 'app-badge--warning', Icon: RotateCcw },
  SENT: { label: 'Sent', className: 'app-badge--success', Icon: Send },
  FAILED: { label: 'Failed', className: 'app-badge--danger', Icon: TriangleAlert },
};

/** Status shown with an icon and a word, never by color alone. */
export const StatusBadge = ({ status }: { status: EmailStatus }) => {
  const { label, className, Icon } = STATUS[status];
  return (
    <span className={`pane-badge app-badge ${className}`}>
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
};

export const Avatar = ({
  name,
  picture,
  large = false,
}: {
  name?: string | null;
  picture?: string;
  large?: boolean;
}) => {
  const className = `app-avatar${large ? ' app-avatar--lg' : ''}`;
  if (picture) {
    return <img src={picture} alt="" className={className} referrerPolicy="no-referrer" />;
  }
  return (
    <span className={className} aria-hidden="true">
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
};

export const Notice = ({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: ReactNode;
}) => (
  <div className={`app-notice app-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
    <p>{children}</p>
  </div>
);

/** Sticky glass top bar. Only primary-label text sits on it. */
export const TopBar = ({ children, fluid = false }: { children: ReactNode; fluid?: boolean }) => (
  <header className="pane-nav pane-glass">
    <div className={`pane-nav__inner pane-container${fluid ? ' app-nav-fluid' : ''}`} style={{ position: 'relative' }}>
      {children}
    </div>
  </header>
);

export const SkipLink = () => (
  <a className="pane-skip-link" href="#main">
    Skip to content
  </a>
);
