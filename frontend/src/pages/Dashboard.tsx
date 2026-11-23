import { useState, useEffect, useCallback, useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  CalendarClock,
  ChevronLeft,
  Clock,
  LogOut,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  SquarePen,
  Sun,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { ComposeEmail } from './ComposeEmail';
import { useAuth } from '../auth';
import { emailService } from '../services/email.service';
import type { Email, EmailStats, PaginatedResponse, ApiResponse } from '../types';
import { Avatar, Notice, SkipLink, StatusBadge, TopBar } from '../ui';
import { dayLabel, groupByDay, timeLabel } from '../utils/timeline';

type Folder = 'scheduled' | 'sent' | 'failed';

interface ListState {
  emails: Email[];
  page: number;
  totalPages: number;
}

const EMPTY_LIST: ListState = { emails: [], page: 1, totalPages: 1 };
const EMPTY_LISTS: Record<Folder, ListState> = { scheduled: EMPTY_LIST, sent: EMPTY_LIST, failed: EMPTY_LIST };

// How often the dashboard refreshes itself, so sent emails move folders without a manual refresh.
const POLL_INTERVAL_MS = 30_000;

// Below this width the list and the detail share one column (matches app.css).
const SPLIT_QUERY = '(max-width: 1079px)';

const FOLDERS: {
  id: Folder;
  label: string;
  Icon: typeof Clock;
  load: (page: number, signal?: AbortSignal) => Promise<ApiResponse<PaginatedResponse<Email>>>;
  count: (stats: EmailStats) => number;
  empty: { title: string; text: string };
}[] = [
  {
    id: 'scheduled',
    label: 'Scheduled',
    Icon: Clock,
    load: emailService.getScheduledEmails,
    count: (s) => s.totalScheduled,
    empty: { title: 'Nothing scheduled', text: 'Emails you schedule wait here until they go out.' },
  },
  {
    id: 'sent',
    label: 'Sent',
    Icon: Send,
    load: emailService.getSentEmails,
    count: (s) => s.totalSent,
    empty: { title: 'No sent emails yet', text: 'Delivered emails appear here.' },
  },
  {
    id: 'failed',
    label: 'Failed',
    Icon: TriangleAlert,
    load: emailService.getFailedEmails,
    count: (s) => s.totalFailed,
    empty: { title: 'No failed emails', text: "Emails that couldn't be delivered appear here, ready to retry." },
  },
];

const startOfDay = (date: Date, addDays = 0) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + addDays).getTime();

/** Whole days from today: 0 today, 1 tomorrow, -1 yesterday. */
const dayOffset = (date: Date) => Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);

const timeOf = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const dateOf = (date: Date, withYear: boolean) =>
  date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: withYear || date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });

const parseDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "Today, 9:41 AM", "Tomorrow, 11:00 AM", "Yesterday, …" or "Nov 23, 3:00 PM". */
const formatWhen = (value: string | null | undefined, withYear = false) => {
  const date = parseDate(value);
  if (!date) return '';
  const days = dayOffset(date);
  const day =
    days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : dateOf(date, withYear);
  return `${day}, ${timeOf(date)}`;
};

/**
 * Short form for list rows, like Mail: "9:41 AM" today, otherwise the day.
 * Upcoming emails keep their time, since when they go out is the point.
 */
const formatShort = (value: string | null | undefined, upcoming: boolean) => {
  const date = parseDate(value);
  if (!date) return '';
  const days = dayOffset(date);
  if (days === 0) return timeOf(date);
  const day = days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : dateOf(date, false);
  return upcoming ? `${day} ${timeOf(date)}` : day;
};

const whenOf = (email: Email) => (email.status === 'SENT' ? email.sentAt || email.scheduledAt : email.scheduledAt);

const toListState = (response: ApiResponse<PaginatedResponse<Email>>, previous?: ListState): ListState | null => {
  if (!response.success || !response.data) return null;
  const { data, page, totalPages } = response.data;
  return {
    // Appending a page can repeat a row that moved between pages; keep the first copy.
    emails: previous
      ? [...previous.emails, ...data.filter((email) => !previous.emails.some((e) => e.id === email.id))]
      : data,
    page,
    totalPages,
  };
};

export const Dashboard = () => {
  const { user, logout } = useAuth();
  const [folder, setFolder] = useState<Folder>('scheduled');
  const [isComposing, setIsComposing] = useState(false);
  const [selected, setSelected] = useState<Email | null>(null);
  const [lists, setLists] = useState<Record<Folder, ListState>>(EMPTY_LISTS);
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [actionError, setActionError] = useState('');
  const [isActing, setIsActing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Moves the timeline's "now" line. Local only, no requests.
  const [now, setNow] = useState(() => Date.now());
  const fetchController = useRef<AbortController | null>(null);
  // Folders showing more than page 1. Refreshes only reload page 1, so they
  // leave these folders alone (stats and the other folders still update).
  const extraPages = useRef(new Set<Folder>());
  const cancelDialog = useRef<HTMLDialogElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // The list is one Tab stop: this row (or the selected one, or the first) takes it.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Refreshing and moving the "now" line wait while focus is in the list, so
  // nothing shifts under someone reading or moving through it.
  const focusInList = () => Boolean(listRef.current?.contains(document.activeElement));

  /**
   * Reload the stats and the first page of every folder, except folders with
   * extra pages loaded. A newer call cancels an older one. Callers that want
   * the spinner set isLoading themselves.
   */
  const fetchData = useCallback(() => {
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;

    return Promise.all([
      Promise.all(FOLDERS.map((f) => f.load(1, controller.signal))),
      emailService.getEmailStats(controller.signal),
    ]).then(([folderResults, statsRes]) => {
      if (controller.signal.aborted) return;
      setLists((prev) => {
        const next = { ...prev };
        FOLDERS.forEach((f, i) => {
          // Checked when the results arrive, so a refresh that was already
          // running when "Load more" was clicked can't wipe the loaded pages.
          if (extraPages.current.has(f.id)) return;
          const list = toListState(folderResults[i]);
          if (list) next[f.id] = list;
        });
        return next;
      });
      if (statsRes.success && statsRes.data) setStats(statsRes.data);
      const failed = [...folderResults, statsRes].find((res) => !res.success);
      setError(failed ? failed.error || 'Failed to load emails' : '');
      setIsLoading(false);
    });
  }, []);

  // isLoading starts true, so the first load shows the spinner.
  useEffect(() => {
    fetchData();
    return () => fetchController.current?.abort();
  }, [fetchData]);

  // Refresh in the background while the mailbox is on screen. Hidden tabs
  // don't poll (each refresh is 4 requests, which count toward the API's rate
  // limit); a tab that becomes visible again refreshes right away.
  useEffect(() => {
    if (isComposing) return;
    let timer: number | undefined;
    const start = () => {
      if (timer === undefined) {
        timer = window.setInterval(() => {
          if (!focusInList()) fetchData();
        }, POLL_INTERVAL_MS);
      }
    };
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchData();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isComposing, fetchData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!focusInList()) setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reload = () => {
    extraPages.current.clear();
    setIsLoading(true);
    fetchData();
  };

  const loadMore = async () => {
    const current = folder;
    const config = FOLDERS.find((f) => f.id === current)!;
    setIsLoadingMore(true);
    // Added before the request, so a refresh that finishes meanwhile can't
    // replace the list the new page is about to be appended to.
    const hadExtraPages = extraPages.current.has(current);
    extraPages.current.add(current);
    const response = await config.load(lists[current].page + 1);
    if (response.success && response.data) {
      // Append to whatever the list is now, not to the snapshot from before the request.
      setLists((prev) => ({ ...prev, [current]: toListState(response, prev[current]) ?? prev[current] }));
    } else {
      // Nothing was added, so the folder goes back to refreshing normally.
      if (!hadExtraPages) extraPages.current.delete(current);
      setError(response.error || 'Failed to load more emails');
    }
    setIsLoadingMore(false);
  };

  const isSplit = () => window.matchMedia(SPLIT_QUERY).matches;

  const openEmail = (email: Email) => {
    setSelected(email);
    setActionError('');
    // When the detail replaces the list, move focus to it so keyboard and
    // screen reader users land on what just opened.
    if (isSplit()) requestAnimationFrame(() => detailHeading.current?.focus());
  };

  const closeEmail = () => {
    const id = selected?.id;
    setSelected(null);
    setActionError('');
    if (id) requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const switchFolder = (next: Folder) => {
    setFolder(next);
    setSelected(null);
    setActionError('');
  };

  const confirmCancel = async () => {
    if (!selected) return;
    setIsActing(true);
    const response = await emailService.cancelScheduledEmail(selected.id);
    setIsActing(false);
    cancelDialog.current?.close();
    if (response.success) {
      setSuccess(`The email to ${selected.recipientEmail} was cancelled.`);
      setSelected(null);
      reload();
    } else {
      setActionError(response.error || 'Failed to cancel the email');
    }
  };

  const handleRetry = async (email: Email) => {
    setIsActing(true);
    const response = await emailService.retryFailedEmail(email.id);
    setIsActing(false);
    if (response.success) {
      setSuccess(`The email to ${email.recipientEmail} will be sent again now.`);
      switchFolder('scheduled');
      reload();
    } else {
      setActionError(response.error || 'Failed to retry the email');
    }
  };

  const matchesSearch = (email: Email) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      email.recipientEmail?.toLowerCase().includes(query) ||
      email.subject?.toLowerCase().includes(query) ||
      Boolean(email.recipientName?.toLowerCase().includes(query))
    );
  };

  const activeFolder = FOLDERS.find((f) => f.id === folder)!;
  const activeList = lists[folder];
  const visibleEmails = activeList.emails.filter(matchesSearch);
  const tabStopId =
    [activeRowId, selected?.id].find((id) => id && visibleEmails.some((email) => email.id === id)) ??
    visibleEmails[0]?.id;
  const countOf = (f: (typeof FOLDERS)[number]) => (stats ? f.count(stats) : lists[f.id].emails.length);

  const mailRow = (email: Email, onTimeline: boolean) => {
    const when = parseDate(whenOf(email));
    return (
      <button
        type="button"
        ref={(el) => {
          if (el) rowRefs.current.set(email.id, el);
          else rowRefs.current.delete(email.id);
        }}
        className={`app-mail-row${onTimeline ? ' app-tl-row' : ''}`}
        aria-current={selected?.id === email.id ? 'true' : undefined}
        tabIndex={email.id === tabStopId ? 0 : -1}
        onFocus={() => setActiveRowId(email.id)}
        onClick={() => openEmail(email)}
      >
        {onTimeline && (
          <>
            {/* The day is in the heading above, so the rail shows only the time.
                Screen readers moving row by row still hear the day. */}
            <span className="app-tl-row__time">
              {when && <span className="pane-visually-hidden">{dayLabel(when, new Date(now))}, </span>}
              {when ? timeLabel(when) : ''}
            </span>
            <span
              className={`app-tl-dot${email.status === 'RETRYING' ? ' app-tl-dot--retrying' : ''}${
                when && when.getTime() <= now ? ' app-tl-dot--due' : ''
              }`}
              aria-hidden="true"
            />
          </>
        )}
        <span className="app-mail-row__text">
          <span className="app-mail-row__top">
            <span className="app-mail-row__name">{email.recipientName || email.recipientEmail}</span>
            {!onTimeline && <span className="app-mail-row__time">{formatShort(whenOf(email), false)}</span>}
          </span>
          <span className="app-mail-row__subject">
            {email.status === 'RETRYING' && (
              <span className="app-mail-row__flag">
                <RotateCcw aria-hidden="true" />
                Retrying ·
              </span>
            )}
            {email.status === 'SCHEDULED' && onTimeline && when && when.getTime() <= now && (
              <span className="app-mail-row__flag app-mail-row__flag--due">Sending now ·</span>
            )}
            {email.subject || 'No subject'}
          </span>
          <span className="app-mail-row__preview">{email.body?.slice(0, 200) || 'No content'}</span>
        </span>
      </button>
    );
  };

  // Up/Down move through the list and open each email, like Mail; Home and End
  // jump to the ends. Tab leaves the list.
  const handleListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = visibleEmails.findIndex((email) => rowRefs.current.get(email.id) === document.activeElement);
    if (index === -1) return;
    const target =
      e.key === 'ArrowDown' ? index + 1
      : e.key === 'ArrowUp' ? index - 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? visibleEmails.length - 1
      : null;
    if (target === null) return;
    const next = visibleEmails[target];
    if (!next) return;
    e.preventDefault();
    rowRefs.current.get(next.id)?.focus();
    if (!isSplit()) openEmail(next);
  };

  // ---- Compose -------------------------------------------------------------
  if (isComposing) {
    return (
      <ComposeEmail
        onCancel={() => setIsComposing(false)}
        onScheduled={(message) => {
          setSuccess(message);
          switchFolder('scheduled');
          setIsComposing(false);
          reload();
        }}
      />
    );
  }

  const compose = () => {
    setSuccess('');
    setIsComposing(true);
  };

  // ---- Mailbox ---------------------------------------------------------------
  return (
    <>
      <SkipLink />
      <TopBar fluid>
        <span className="pane-nav__brand">
          <span className="app-brand-mark" aria-hidden="true">
            <CalendarClock />
          </span>
          Scheduler
        </span>
        <div className="app-nav-actions">
          <div className="app-account">
            <Avatar name={user?.name} picture={user?.picture} />
            <span className="app-account__name">{user?.name || user?.email}</span>
          </div>
          <button type="button" className="pane-btn pane-btn--plain" onClick={logout} aria-label="Log out">
            <LogOut aria-hidden="true" />
            <span className="app-hide-narrow" aria-hidden="true">Log out</span>
          </button>
        </div>
      </TopBar>

      <div className="app-shell" data-view={selected ? 'detail' : 'list'}>
        {/* ---- Sidebar ---- */}
        <nav className="app-sidebar" aria-label="Mailboxes">
          <button type="button" className="pane-btn pane-btn--filled app-sidebar__compose" onClick={compose}>
            <SquarePen aria-hidden="true" />
            <span>New email</span>
          </button>

          <ul className="app-folders">
            {FOLDERS.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="app-folder"
                  aria-current={folder === f.id ? 'page' : undefined}
                  onClick={() => switchFolder(f.id)}
                >
                  <f.Icon aria-hidden="true" />
                  <span className="app-folder__label">{f.label}</span>
                  <span className="app-folder__count">{countOf(f)}</span>
                </button>
              </li>
            ))}
          </ul>

          {stats && (
            <p className="app-sidebar__today">
              <Sun aria-hidden="true" />
              {stats.pendingToday === 0
                ? 'Nothing else goes out today'
                : `${stats.pendingToday} ${stats.pendingToday === 1 ? 'email goes' : 'emails go'} out later today`}
            </p>
          )}
        </nav>

        <main id="main" tabIndex={-1} className="app-panes">
          {/* ---- List ---- */}
          <section className="app-pane app-pane--list" aria-labelledby="list-title" aria-busy={isLoading}>
            <header className="app-pane__header">
              <div className="app-pane__title">
                <h1 id="list-title">{activeFolder.label}</h1>
                <p>
                  {isLoading ? 'Loading…' : `${countOf(activeFolder)} ${countOf(activeFolder) === 1 ? 'email' : 'emails'}`}
                </p>
              </div>
              <div className="app-pane__actions">
                <button
                type="button"
                className="pane-btn pane-btn--plain pane-btn--icon app-only-phone"
                onClick={compose}
                aria-label="New email"
                title="New email"
              >
                <SquarePen aria-hidden="true" />
              </button>
              <button
                type="button"
                className="pane-btn pane-btn--plain pane-btn--icon"
                onClick={reload}
                aria-label="Refresh"
                title="Refresh"
                disabled={isLoading}
              >
                <RefreshCw aria-hidden="true" />
              </button>
              </div>
            </header>

            <div className="app-pane__search">
              <div className="pane-search">
                <Search aria-hidden="true" />
                <label htmlFor="email-search" className="pane-visually-hidden">
                  Search {activeFolder.label.toLowerCase()} emails
                </label>
                <input
                  id="email-search"
                  type="search"
                  className="pane-input"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {(success || error) && (
              <div className="app-pane__notices">
                {success && <Notice tone="success">{success}</Notice>}
                {error && <Notice tone="error">{error}</Notice>}
              </div>
            )}

            <div className="app-pane__scroll">
              {isLoading ? (
                <div className="app-center" style={{ padding: 'var(--pane-space-16)' }}>
                  <span className="pane-spinner app-spinner-lg" aria-label="Loading emails" role="status" />
                </div>
              ) : visibleEmails.length === 0 ? (
                <div className="app-empty">
                  <activeFolder.Icon aria-hidden="true" />
                  <p className="pane-headline">{searchQuery ? 'No matching emails' : activeFolder.empty.title}</p>
                  <p className="pane-secondary">
                    {searchQuery ? 'Try a different name, address or subject.' : activeFolder.empty.text}
                  </p>
                  {!searchQuery && folder === 'scheduled' && (
                    <button type="button" className="pane-btn pane-btn--tinted" onClick={compose}>
                      New email
                    </button>
                  )}
                </div>
              ) : (
                <div ref={listRef} onKeyDown={handleListKey}>
                  {folder === 'scheduled' ? (
                    <ScheduledTimeline
                      emails={visibleEmails}
                      now={now}
                      complete={activeList.page >= activeList.totalPages}
                      renderRow={(email) => mailRow(email, true)}
                    />
                  ) : (
                    <ul className="app-mail-list" aria-label={`${activeFolder.label} emails`}>
                      {visibleEmails.map((email) => (
                        <li key={email.id}>{mailRow(email, false)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!isLoading && activeList.page < activeList.totalPages && !searchQuery && (
                <div className="app-center">
                  <button
                    type="button"
                    className="pane-btn pane-btn--gray pane-btn--sm"
                    onClick={loadMore}
                    disabled={isLoadingMore}
                    aria-busy={isLoadingMore}
                  >
                    {isLoadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* ---- Detail ---- */}
          <section className="app-pane app-pane--detail" aria-label="Email">
            {selected ? (
              <EmailDetail
                email={selected}
                folderLabel={activeFolder.label}
                from={user?.name ? `${user.name} <${user.email}>` : user?.email || ''}
                headingRef={detailHeading}
                actionError={actionError}
                isActing={isActing}
                onBack={closeEmail}
                onCancel={() => cancelDialog.current?.showModal()}
                onRetry={() => handleRetry(selected)}
              />
            ) : (
              <div className="app-empty app-pane__placeholder">
                <Mail aria-hidden="true" />
                <p className="pane-headline">No email selected</p>
                <p className="pane-secondary">Choose an email from the list to see it here.</p>
              </div>
            )}
          </section>
        </main>
      </div>

      <dialog
        ref={cancelDialog}
        className="pane-dialog"
        aria-labelledby="cancel-title"
        aria-describedby="cancel-text"
        onClick={(e) => {
          // A click on the backdrop (the dialog element itself) closes it.
          if (e.target === e.currentTarget && !isActing) cancelDialog.current?.close();
        }}
      >
        <div className="pane-dialog__body">
          <h2 id="cancel-title" className="pane-dialog__title">Cancel this email?</h2>
          <p id="cancel-text" className="pane-dialog__text">
            The email to {selected?.recipientEmail} won't be sent. This can't be undone.
          </p>
        </div>
        <div className="pane-dialog__actions">
          <button
            type="button"
            className="pane-btn pane-btn--gray"
            onClick={() => cancelDialog.current?.close()}
            disabled={isActing}
            autoFocus
          >
            Keep
          </button>
          <button
            type="button"
            className="pane-btn pane-btn--danger"
            onClick={confirmCancel}
            disabled={isActing}
            aria-busy={isActing}
          >
            Cancel email
          </button>
        </div>
      </dialog>
    </>
  );
};

const EmailDetail = ({
  email,
  folderLabel,
  from,
  headingRef,
  actionError,
  isActing,
  onBack,
  onCancel,
  onRetry,
}: {
  email: Email;
  folderLabel: string;
  from: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  actionError: string;
  isActing: boolean;
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) => {
  const isPending = email.status === 'SCHEDULED' || email.status === 'RETRYING';
  return (
    <article className="app-detail-pane">
      <div className="app-detail-pane__bar">
        <button type="button" className="pane-btn pane-btn--plain app-only-split" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          {folderLabel}
        </button>
        <span className="app-detail-pane__spacer" />
        {isPending && (
          <button type="button" className="pane-btn pane-btn--danger pane-btn--sm" onClick={onCancel} disabled={isActing}>
            <Trash2 aria-hidden="true" />
            Cancel email
          </button>
        )}
        {email.status === 'FAILED' && (
          <button
            type="button"
            className="pane-btn pane-btn--filled pane-btn--sm"
            onClick={onRetry}
            disabled={isActing}
            aria-busy={isActing}
          >
            <RotateCcw aria-hidden="true" />
            Retry now
          </button>
        )}
      </div>

      <div className="app-detail-pane__content">
        {actionError && <Notice tone="error">{actionError}</Notice>}

        <header className="app-detail-pane__header">
          <StatusBadge status={email.status} />
          <h2 ref={headingRef} tabIndex={-1} className="pane-title-2">
            {email.subject || 'No subject'}
          </h2>
        </header>

        <div className="app-detail-pane__people">
          <Avatar name={email.recipientName || email.recipientEmail} large />
          <dl className="app-meta">
            <dt>To</dt>
            <dd>{email.recipientName ? `${email.recipientName} <${email.recipientEmail}>` : email.recipientEmail}</dd>
            <dt>From</dt>
            <dd>{from}</dd>
            <dt>{email.status === 'SENT' ? 'Sent' : email.status === 'FAILED' ? 'Was due' : 'Sends'}</dt>
            <dd>{formatWhen(whenOf(email), true)}</dd>
            {email.attemptCount > 1 && (
              <>
                <dt>Attempts</dt>
                <dd>{email.attemptCount}</dd>
              </>
            )}
          </dl>
        </div>

        {email.errorMessage && email.status !== 'SENT' && <Notice tone="error">{email.errorMessage}</Notice>}

        <hr className="pane-separator" />

        <div className="app-body">{email.body}</div>
      </div>
    </article>
  );
};

type TimelineEntry = { kind: 'email'; email: Email; at: Date } | { kind: 'now'; at: Date };

/**
 * Scheduled emails on a day timeline, soonest first, with a "now" line between
 * what is already due and what is still to come. Today always gets a heading
 * when the line falls there, so you can see where you are.
 */
const ScheduledTimeline = ({
  emails,
  now,
  complete,
  renderRow,
}: {
  emails: Email[];
  now: number;
  /** Every scheduled email is loaded, so nothing comes after the last one. */
  complete: boolean;
  renderRow: (email: Email) => ReactNode;
}) => {
  const nowDate = new Date(now);
  const entries: TimelineEntry[] = emails.map((email) => ({
    kind: 'email',
    email,
    at: parseDate(email.scheduledAt) ?? nowDate,
  }));
  // The list may be cut off by paging: only place the line if it falls inside what's loaded.
  const nowIndex = entries.findIndex((entry) => entry.at.getTime() > now);
  if (nowIndex !== -1) entries.splice(nowIndex, 0, { kind: 'now', at: nowDate });
  else if (complete && entries.length > 0) entries.push({ kind: 'now', at: nowDate });

  return (
    <div className="app-timeline">
      {groupByDay(entries, (entry) => entry.at).map((day) => (
        <section key={day.key} aria-labelledby={`day-${day.key}`}>
          <h2 id={`day-${day.key}`} className="app-timeline__day">
            {dayLabel(day.date, nowDate)}
          </h2>
          <ul className="app-timeline__list">
            {day.items.map((entry) =>
              entry.kind === 'now' ? (
                <li key="now" className="app-tl-now">
                  <span className="app-tl-now__time">
                    <span className="pane-visually-hidden">Now, </span>
                    {timeLabel(entry.at)}
                  </span>
                  <span className="app-tl-now__line" aria-hidden="true" />
                </li>
              ) : (
                <li key={entry.email.id}>{renderRow(entry.email)}</li>
              )
            )}
          </ul>
        </section>
      ))}
    </div>
  );
};
