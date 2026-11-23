import { useState, useEffect, useRef } from 'react';
import type { ChangeEvent, FocusEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react';
import {
  AlignCenter,
  AlignLeft,
  Bold,
  CircleAlert,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import type { EmailRecipient, Sender } from '../types';
import { dedupeRecipients, parseCSV, parseEmails } from '../utils/parseEmails';
import { buildSendTimes, toLocalInputValue, tomorrowAt } from '../utils/schedule';
import { dayLabel, groupByDay, timeLabel } from '../utils/timeline';
import { emailService } from '../services/email.service';
import { Notice, SkipLink, TopBar } from '../ui';

interface ComposeEmailProps {
  onCancel: () => void;
  onScheduled: (message: string) => void;
}

// The backend accepts up to 500 recipients per bulk request.
const BULK_CHUNK_SIZE = 500;
// The backend's limit for a recipient name.
const MAX_NAME_LENGTH = 200;
// A time picked "now" is still accepted for a moment. Same value as the
// backend's PAST_TOLERANCE_MS (email.controller.ts); keep them in step.
const PAST_TOLERANCE_MS = 2 * 60 * 1000;

const QUICK_TIMES = [
  { hour: 9, label: 'Tomorrow, 9:00 AM' },
  { hour: 13, label: 'Tomorrow, 1:00 PM' },
  { hour: 17, label: 'Tomorrow, 5:00 PM' },
];

const newDraftId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const isSafeLink = (url: string) => /^(https?:\/\/|mailto:)\S+$/i.test(url.trim());

const formatSendTime = (date: Date) =>
  date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type FormatButton = { label: string; Icon: typeof Bold; command: string; value?: string };

const FORMAT_GROUPS: FormatButton[][] = [
  [
    { label: 'Undo', Icon: Undo2, command: 'undo' },
    { label: 'Redo', Icon: Redo2, command: 'redo' },
  ],
  [
    { label: 'Bold', Icon: Bold, command: 'bold' },
    { label: 'Italic', Icon: Italic, command: 'italic' },
    { label: 'Underline', Icon: Underline, command: 'underline' },
    { label: 'Strikethrough', Icon: Strikethrough, command: 'strikeThrough' },
  ],
  [
    { label: 'Align left', Icon: AlignLeft, command: 'justifyLeft' },
    { label: 'Align center', Icon: AlignCenter, command: 'justifyCenter' },
  ],
  [
    { label: 'Bulleted list', Icon: List, command: 'insertUnorderedList' },
    { label: 'Numbered list', Icon: ListOrdered, command: 'insertOrderedList' },
    { label: 'Quote', Icon: Quote, command: 'formatBlock', value: 'blockquote' },
    { label: 'Divider', Icon: Minus, command: 'insertHorizontalRule' },
  ],
];

type Field = 'to' | 'subject' | 'body' | 'when';
type FieldErrors = Partial<Record<Field, string>>;

/** Ids for the field's error message, and for aria-describedby. */
const errorId = (field: Field) => `compose-${field}-error`;

const FieldError = ({ field, message }: { field: Field; message?: string }) =>
  message ? (
    <p id={errorId(field)} className="pane-error" style={{ margin: 0 }}>
      <CircleAlert aria-hidden="true" />
      {message}
    </p>
  ) : null;

/** Joins the ids that exist, for aria-describedby. */
const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined;

/**
 * Split typed text into addresses. Returns the valid ones and the pieces that
 * aren't addresses, so those can stay in the field to be corrected.
 */
const splitRecipients = (text: string) => {
  const valid: EmailRecipient[] = [];
  const invalid: string[] = [];
  // Commas, semicolons and new lines separate entries; spaces don't, so
  // "Jordan Lee <jordan@example.com>" stays one entry.
  for (const piece of text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const parsed = parseEmails(piece);
    // Whatever is left after taking the addresses out must not look like a
    // broken address ("name@", "@example.com").
    const rest = parsed.reduce((left, r) => left.replace(new RegExp(r.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ''), piece);
    if (parsed.length > 0 && !rest.includes('@')) valid.push(...parsed);
    else invalid.push(piece);
  }
  return { valid, invalid };
};

export const ComposeEmail = ({ onCancel, onScheduled }: ComposeEmailProps) => {
  const [subject, setSubject] = useState('');
  const [recipients, setRecipients] = useState<EmailRecipient[]>([]);
  const [recipientInput, setRecipientInput] = useState('');
  const [startTime, setStartTime] = useState('');
  const [delayBetweenEmails, setDelayBetweenEmails] = useState(0);
  const [hourlyLimit, setHourlyLimit] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [senders, setSenders] = useState<Sender[]>([]);
  const [sendersLoaded, setSendersLoaded] = useState(false);
  const [selectedSenderId, setSelectedSenderId] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  // Problems shown under the field they belong to, not in the banner.
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // The summary, announced once typing in the schedule fields has paused.
  const [announcedSummary, setAnnouncedSummary] = useState('');
  // The formatting control that is the toolbar's one Tab stop.
  const [toolIndex, setToolIndex] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const whenRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recipientInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const linkDialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<Range | null>(null);
  const isMounted = useRef(true);
  // One ID per draft: resubmitting after a partial failure can't schedule anyone twice.
  const draftId = useRef(newDraftId());

  useEffect(() => {
    isMounted.current = true;
    let ignore = false;

    emailService.getSenders().then((response) => {
      if (ignore) return;
      setSendersLoaded(true);
      if (response.success && response.data) {
        const list = response.data.senders ?? [];
        setSenders(list);
        if (list.length > 0) {
          setSelectedSenderId(list[0].id);
        } else {
          setError('No sender is available for your account. Please sign out and sign in again.');
        }
      } else {
        setError(response.error || 'Failed to load senders.');
      }
    });

    return () => {
      ignore = true;
      isMounted.current = false;
    };
  }, []);

  // Bring a new banner error into view; it sits above the form. Field errors
  // don't use the banner, so typing in a field never scrolls the page away.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  const setFieldError = (field: Field, message?: string) => {
    setFieldErrors((current) => (current[field] === message ? current : { ...current, [field]: message }));
  };

  const addRecipients = (incoming: EmailRecipient[]) => {
    setRecipients((current) => dedupeRecipients([...current, ...incoming]));
    setFieldError('to', undefined);
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same file can be uploaded again.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    try {
      const emails = await parseCSV(file);
      if (!isMounted.current) return;
      const before = recipients.length;
      const merged = dedupeRecipients([...recipients, ...emails]);
      if (merged.length > before) {
        addRecipients(emails);
        setError('');
      } else {
        setError('All emails from the file are already added.');
      }
    } catch (err) {
      if (!isMounted.current) return;
      setError(err instanceof Error ? err.message : 'Failed to read the file. Please upload a CSV or TXT file.');
    }
  };

  const handleAddRecipient = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const { valid, invalid } = splitRecipients(trimmed);
    if (valid.length > 0) addRecipients(valid);
    if (invalid.length === 0) {
      setRecipientInput('');
      return;
    }
    // Keep what isn't an address in the field, selected, so typing replaces
    // it instead of being glued onto it.
    const rest = invalid.join(', ');
    setRecipientInput(rest);
    setFieldError(
      'to',
      invalid.length === 1
        ? `"${rest}" isn't an email address. Enter one like name@example.com.`
        : `${invalid.length} entries aren't email addresses. Enter addresses like name@example.com, separated by commas.`
    );
    const field = recipientInputRef.current;
    if (field && document.activeElement === field) requestAnimationFrame(() => field.select());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddRecipient(recipientInput);
    }
  };

  const removeRecipient = (email: string) => {
    setRecipients((current) => current.filter((r) => r.email !== email));
  };

  // Toolbar controls take focus away from the editor; remember and restore the selection.
  const saveSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editorRef.current?.contains(selection.anchorNode)) {
      savedSelection.current = selection.getRangeAt(0);
    }
  };

  const restoreSelection = () => {
    editorRef.current?.focus();
    const range = savedSelection.current;
    const selection = window.getSelection();
    if (range && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  const applyFormat = (command: string, value?: string) => {
    restoreSelection();
    document.execCommand(command, false, value);
    saveSelection();
  };

  // Keep the editor's selection when a toolbar button is pressed.
  const keepEditorSelection = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  };

  const handleHeadingChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const tag = e.target.value;
    if (tag) applyFormat('formatBlock', tag);
  };

  const openLinkDialog = () => {
    saveSelection();
    setLinkUrl('');
    setLinkError('');
    linkDialog.current?.showModal();
  };

  const insertLink = () => {
    if (!isSafeLink(linkUrl)) {
      setLinkError('Enter a link that starts with https://, http:// or mailto:');
      return;
    }
    linkDialog.current?.close();
    applyFormat('createLink', linkUrl.trim());
  };

  const handleQuickSchedule = (hour: number) => {
    setStartTime(toLocalInputValue(tomorrowAt(hour)));
    setFieldError('when', undefined);
  };

  const handleSubmit = async () => {
    const editor = editorRef.current;
    const htmlBody = editor?.innerHTML ?? '';
    // innerText keeps line breaks and decodes entities, unlike stripping tags.
    const textBody = (editor?.innerText ?? '').replace(/\u00a0/g, ' ').trim();
    const trimmedSubject = subject.trim();
    const start = startTime ? new Date(startTime) : null;

    // Each problem shows under its field; focus goes to the first one, in form order.
    const problems: FieldErrors = {};
    // Text left in the To field is what wasn't an address when it was added.
    if (recipientInput.trim()) problems.to = fieldErrors.to ?? `Fix or remove "${recipientInput.trim()}".`;
    else if (recipients.length === 0) problems.to = 'Add at least one recipient, like name@example.com.';
    if (!trimmedSubject) problems.subject = 'Enter a subject.';
    if (!textBody) problems.body = 'Write a message.';
    if (!start || Number.isNaN(start.getTime())) problems.when = 'Choose when to send.';
    else if (start.getTime() < Date.now() - PAST_TOLERANCE_MS) problems.when = 'This time has passed. Choose a later time.';
    const first = (['to', 'subject', 'body', 'when'] as const).find((field) => problems[field]);
    setFieldErrors(problems);
    if (first) {
      const target = { to: recipientInputRef, subject: subjectRef, body: editorRef, when: whenRef }[first].current;
      target?.focus();
      return;
    }
    if (!start) return;
    if (!selectedSenderId) return setError('No sender is available for your account. Please sign out and sign in again.');

    setIsLoading(true);
    setError('');

    const sendTimes = buildSendTimes(start, recipients.length, delayBetweenEmails, hourlyLimit);
    const items = recipients.map((recipient, i) => ({
      recipientEmail: recipient.email,
      recipientName: recipient.name ? recipient.name.slice(0, MAX_NAME_LENGTH) : undefined,
      sendAt: sendTimes[i],
      idempotencyKey: `${draftId.current}:${recipient.email}`,
    }));

    const scheduledEmails = new Set<string>();
    const failures: string[] = [];

    // Earlier chunks take time, so the next chunk's first time may have passed.
    // Then the rest of the schedule moves later by the same amount, keeping the
    // spacing and hourly limit, instead of bunching the late ones up at "now".
    let shiftMs = 0;
    for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
      shiftMs = Math.max(shiftMs, Date.now() - items[i].sendAt.getTime());
      const chunk = items.slice(i, i + BULK_CHUNK_SIZE).map(({ sendAt, ...item }) => ({
        ...item,
        scheduledAt: new Date(sendAt.getTime() + shiftMs).toISOString(),
      }));
      const response = await emailService.scheduleBulk({
        senderId: selectedSenderId,
        subject: trimmedSubject,
        body: textBody,
        htmlBody,
        recipients: chunk,
      });

      const scheduledNow = response.data?.scheduled ?? [];
      scheduledNow.forEach((email) => scheduledEmails.add(email.recipientEmail.toLowerCase()));
      if (response.data?.failed?.length) {
        failures.push(...response.data.failed.map((f) => `${f.recipientEmail} (${f.error})`));
      } else if (!response.success && !response.data) {
        failures.push(...chunk.map((item) => item.recipientEmail));
        if (response.error) failures.unshift(response.error);
      }
      // Stop only when the request failed as a whole (network or server error,
      // or the queue is down), since the next chunks would fail the same way.
      // Per-recipient problems (an invalid address, a reused key) don't stop
      // the rest. Unsent recipients stay listed so they can be retried.
      const queueDown =
        scheduledNow.length === 0 &&
        (response.data?.failed ?? []).some((f) => f.error === 'Email queue is unavailable');
      if (!response.data || queueDown) break;
    }

    if (!isMounted.current) return;
    setIsLoading(false);

    if (scheduledEmails.size === recipients.length) {
      onScheduled(
        recipients.length === 1
          ? `Your email to ${recipients[0].email} is scheduled.`
          : `${recipients.length} emails are scheduled.`
      );
      return;
    }

    // Keep only the recipients that still need scheduling, so trying again is safe.
    setRecipients((current) => current.filter((r) => !scheduledEmails.has(r.email.toLowerCase())));
    setError(
      scheduledEmails.size > 0
        ? `${scheduledEmails.size} of ${recipients.length} emails were scheduled. The rest are still listed; try again to schedule them. ${failures.slice(0, 3).join('; ')}`
        : `No emails were scheduled. ${failures[0] ?? 'Please try again.'}`
    );
  };

  const startDate = startTime ? new Date(startTime) : null;
  const sendTimes =
    startDate && !Number.isNaN(startDate.getTime()) && recipients.length > 0
      ? buildSendTimes(startDate, recipients.length, delayBetweenEmails, hourlyLimit)
      : [];
  const summary =
    sendTimes.length === 0
      ? ''
      : sendTimes.length === 1
        ? `Sends ${formatSendTime(sendTimes[0])}.`
        : sendTimes[0].getTime() === sendTimes[sendTimes.length - 1].getTime()
          ? `${sendTimes.length} emails, all sent ${formatSendTime(sendTimes[0])}.`
          : `${sendTimes.length} emails, from ${formatSendTime(sendTimes[0])} to ${formatSendTime(sendTimes[sendTimes.length - 1])}.`;

  // Announce the summary once the schedule fields have been left alone for a
  // moment, not on every keystroke. The visible summary is not a live region.
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedSummary(summary), 1000);
    return () => window.clearTimeout(timer);
  }, [summary]);

  // The toolbar is one Tab stop; Left/Right, Home and End move inside it.
  const toolbarItems = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>('select, button') ?? []);

  const handleToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = toolbarItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    const last = items.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1;
    if (next === -1) return;
    e.preventDefault();
    setToolIndex(next);
    items[next].focus();
  };

  const handleToolbarFocus = (e: FocusEvent<HTMLDivElement>) => {
    const index = toolbarItems().indexOf(e.target as HTMLElement);
    if (index !== -1) setToolIndex(index);
  };

  // Each toolbar control's position, for its tabIndex.
  let toolPosition = 0;
  const toolTabIndex = () => (toolPosition++ === toolIndex ? 0 : -1);

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleSubmit();
  };

  return (
    <>
      <SkipLink />
      <TopBar>
        <button type="button" className="pane-btn pane-btn--plain" onClick={onCancel} disabled={isLoading}>
          Cancel
        </button>
        <h1 className="app-nav-title">New Email</h1>
        <span style={{ marginLeft: 'auto' }} />
        <button
          type="submit"
          form="compose-form"
          className="pane-btn pane-btn--filled"
          disabled={isLoading || !sendersLoaded}
          aria-busy={isLoading}
        >
          {isLoading && <span className="pane-spinner" aria-hidden="true" />}
          {isLoading ? 'Scheduling…' : 'Schedule'}
        </button>
      </TopBar>

      <main id="main" tabIndex={-1} className="pane-container app-main app-main--narrow">
        <div ref={errorRef}>{error && <Notice tone="error">{error}</Notice>}</div>

        <form id="compose-form" className="pane-stack" style={{ gap: 'var(--pane-space-6)' }} onSubmit={handleFormSubmit} noValidate>
          <section className="pane-surface app-form-card" aria-labelledby="message-heading">
            <h2 id="message-heading" className="pane-title-3">Message</h2>

            <div className="pane-field">
              <label htmlFor="compose-from" className="pane-label">From</label>
              <select
                id="compose-from"
                className="pane-select"
                value={selectedSenderId}
                onChange={(e) => setSelectedSenderId(e.target.value)}
                disabled={senders.length === 0}
              >
                {senders.map((sender) => (
                  <option key={sender.id} value={sender.id}>
                    {sender.name && sender.name !== sender.email ? `${sender.name} <${sender.email}>` : sender.email}
                  </option>
                ))}
                {senders.length === 0 && (
                  <option value="">{sendersLoaded ? 'No sender configured' : 'Loading…'}</option>
                )}
              </select>
            </div>

            <div className="pane-field">
              <div className="pane-row" style={{ justifyContent: 'space-between' }}>
                <label htmlFor="compose-to" className="pane-label">To</label>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".csv,.txt,text/csv,text/plain"
                  onChange={handleFileUpload}
                  hidden
                />
                <button
                  type="button"
                  className="pane-btn pane-btn--plain pane-btn--sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload aria-hidden="true" />
                  Import list
                </button>
              </div>
              <div className="app-chip-field" onClick={() => recipientInputRef.current?.focus()}>
                {recipients.map((recipient) => (
                  <span key={recipient.email} className="app-chip">
                    <span>{recipient.email}</span>
                    <button
                      type="button"
                      onClick={() => removeRecipient(recipient.email)}
                      aria-label={`Remove ${recipient.email}`}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </span>
                ))}
                <input
                  id="compose-to"
                  ref={recipientInputRef}
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  value={recipientInput}
                  onChange={(e) => {
                    setRecipientInput(e.target.value);
                    setFieldError('to', undefined);
                  }}
                  onKeyDown={handleKeyDown}
                  onBlur={() => handleAddRecipient(recipientInput)}
                  onFocus={(e) => {
                    // Coming back to text that wasn't an address: select it, so typing replaces it.
                    if (fieldErrors.to && e.target.value) e.target.select();
                  }}
                  placeholder={recipients.length === 0 ? 'name@example.com' : ''}
                  aria-invalid={fieldErrors.to ? true : undefined}
                  aria-describedby={describedBy(fieldErrors.to && errorId('to'), 'compose-to-hint')}
                />
              </div>
              <FieldError field="to" message={fieldErrors.to} />
              <p id="compose-to-hint" className="pane-hint" style={{ margin: 0 }}>
                Press Return or comma after each address, or import a CSV/TXT list.
                {recipients.length > 0 && ` ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`}
              </p>
            </div>

            <div className="pane-field">
              <label htmlFor="compose-subject" className="pane-label">Subject</label>
              <input
                id="compose-subject"
                ref={subjectRef}
                type="text"
                className="pane-input"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setFieldError('subject', undefined);
                }}
                aria-invalid={fieldErrors.subject ? true : undefined}
                aria-describedby={describedBy(fieldErrors.subject && errorId('subject'))}
              />
              <FieldError field="subject" message={fieldErrors.subject} />
            </div>

            <div className="pane-field">
              <span className="pane-label" id="compose-body-label">Body</span>
              <div className="app-editor">
                <div
                  className="pane-toolbar"
                  ref={toolbarRef}
                  role="toolbar"
                  aria-label="Formatting"
                  onMouseDown={keepEditorSelection}
                  onKeyDown={handleToolbarKey}
                  onFocus={handleToolbarFocus}
                >
                  <select
                    tabIndex={toolTabIndex()}
                    onChange={handleHeadingChange}
                    aria-label="Text style"
                    className="pane-select"
                    value=""
                  >
                    <option value="" disabled>Text style</option>
                    <option value="p">Body</option>
                    <option value="h1">Title</option>
                    <option value="h2">Heading</option>
                  </select>
                  {FORMAT_GROUPS.map((group, groupIndex) => (
                    <span key={groupIndex} style={{ display: 'contents' }}>
                      <span className="pane-toolbar__sep" aria-hidden="true" />
                      {group.map(({ label, Icon, command, value }) => (
                        <button
                          key={label}
                          type="button"
                          className="pane-toolbar__btn"
                          tabIndex={toolTabIndex()}
                          onClick={() => applyFormat(command, value)}
                          aria-label={label}
                          title={label}
                        >
                          <Icon aria-hidden="true" />
                        </button>
                      ))}
                    </span>
                  ))}
                  <span className="pane-toolbar__sep" aria-hidden="true" />
                  <button
                    type="button"
                    className="pane-toolbar__btn"
                    tabIndex={toolTabIndex()}
                    onClick={openLinkDialog}
                    aria-label="Insert link"
                    title="Insert link"
                  >
                    <Link aria-hidden="true" />
                  </button>
                </div>
                <div
                  ref={editorRef}
                  className="app-editor__area"
                  contentEditable
                  role="textbox"
                  aria-multiline="true"
                  aria-labelledby="compose-body-label"
                  aria-invalid={fieldErrors.body ? true : undefined}
                  aria-describedby={describedBy(fieldErrors.body && errorId('body'))}
                  data-placeholder="Write your message…"
                  onInput={() => setFieldError('body', undefined)}
                  onKeyUp={saveSelection}
                  onMouseUp={saveSelection}
                  onBlur={saveSelection}
                  suppressContentEditableWarning
                />
              </div>
              <FieldError field="body" message={fieldErrors.body} />
            </div>
          </section>

          <section className="pane-surface app-form-card" aria-labelledby="schedule-heading">
            <h2 id="schedule-heading" className="pane-title-3">Schedule</h2>

            <div className="pane-field">
              <label htmlFor="compose-when" className="pane-label">Send at</label>
              <input
                id="compose-when"
                ref={whenRef}
                type="datetime-local"
                className="pane-input"
                value={startTime}
                min={toLocalInputValue(new Date())}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setFieldError('when', undefined);
                }}
                aria-invalid={fieldErrors.when ? true : undefined}
                aria-describedby={describedBy(fieldErrors.when && errorId('when'))}
              />
              <FieldError field="when" message={fieldErrors.when} />
              <div className="app-quick">
                {QUICK_TIMES.map(({ hour, label }) => (
                  <button
                    key={hour}
                    type="button"
                    className="pane-btn pane-btn--gray pane-btn--sm"
                    onClick={() => handleQuickSchedule(hour)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="app-grid-2">
              <div className="pane-field">
                <label htmlFor="compose-delay" className="pane-label">Gap between emails</label>
                <input
                  id="compose-delay"
                  type="number"
                  inputMode="numeric"
                  className="pane-input"
                  value={delayBetweenEmails}
                  min={0}
                  onChange={(e) => setDelayBetweenEmails(Math.max(0, Number(e.target.value) || 0))}
                  aria-describedby="compose-delay-hint"
                />
                <p id="compose-delay-hint" className="pane-hint" style={{ margin: 0 }}>In seconds. 0 sends them together.</p>
              </div>
              <div className="pane-field">
                <label htmlFor="compose-hourly-limit" className="pane-label">Hourly limit</label>
                <input
                  id="compose-hourly-limit"
                  type="number"
                  inputMode="numeric"
                  className="pane-input"
                  value={hourlyLimit}
                  min={0}
                  onChange={(e) => setHourlyLimit(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  aria-describedby="compose-hourly-hint"
                />
                <p id="compose-hourly-hint" className="pane-hint" style={{ margin: 0 }}>Emails per hour. 0 means no limit.</p>
              </div>
            </div>

            {summary && <p className="app-summary">{summary}</p>}
            <p className="pane-visually-hidden" aria-live="polite">{announcedSummary}</p>
            {sendTimes.length > 1 && <SendPlan times={sendTimes} />}
          </section>
        </form>
      </main>

      <dialog
        ref={linkDialog}
        className="pane-dialog"
        aria-labelledby="link-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) linkDialog.current?.close();
        }}
      >
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            insertLink();
          }}
        >
          <div className="pane-dialog__body">
            <h2 id="link-title" className="pane-dialog__title">Insert link</h2>
            <div className="pane-field">
              <label htmlFor="link-url" className="pane-label">Address</label>
              <input
                id="link-url"
                type="url"
                className="pane-input"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  setLinkError('');
                }}
                aria-invalid={linkError ? true : undefined}
                aria-describedby={linkError ? 'link-error' : undefined}
                autoFocus
              />
              {linkError && (
                <p id="link-error" className="pane-error" style={{ margin: 0 }}>
                  <CircleAlert aria-hidden="true" />
                  {linkError}
                </p>
              )}
            </div>
          </div>
          <div className="pane-dialog__actions">
            <button type="button" className="pane-btn pane-btn--gray" onClick={() => linkDialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="pane-btn pane-btn--filled">
              Insert
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
};

const HOUR_MS = 3600 * 1000;
const PLAN_ROWS = 6;

/** "at 3:12 PM", "tomorrow at 3:12 PM", "Monday, Nov 24 at 3:12 PM". */
const endingAt = (date: Date) => {
  const day = dayLabel(date);
  if (day === 'Today') return `at ${timeLabel(date)}`;
  return `${day === 'Tomorrow' ? 'tomorrow' : day} at ${timeLabel(date)}`;
};

/**
 * Where a batch lands, one row per clock hour (the window the hourly limit is
 * counted in), on the same rail as the Scheduled timeline. Long plans show the
 * first hours and say how much follows.
 */
const SendPlan = ({ times }: { times: Date[] }) => {
  const hours: { first: Date; last: Date; count: number }[] = [];
  for (const time of times) {
    const last = hours[hours.length - 1];
    if (last && Math.floor(last.first.getTime() / HOUR_MS) === Math.floor(time.getTime() / HOUR_MS)) {
      last.last = time;
      last.count++;
    } else {
      hours.push({ first: time, last: time, count: 1 });
    }
  }
  const shown = hours.slice(0, PLAN_ROWS);
  const hidden = hours.slice(PLAN_ROWS);
  const hiddenCount = hidden.reduce((sum, hour) => sum + hour.count, 0);
  const end = times[times.length - 1];

  return (
    <div className="app-timeline app-timeline--plan">
      {groupByDay(shown, (hour) => hour.first).map((day) => (
        <section key={day.key} aria-labelledby={`plan-${day.key}`}>
          <h3 id={`plan-${day.key}`} className="app-timeline__day">
            {dayLabel(day.date)}
          </h3>
          <ul className="app-timeline__list">
            {day.items.map((hour) => (
              <li key={hour.first.getTime()} className="app-tl-row app-plan-row">
                <span className="app-tl-row__time">{timeLabel(hour.first)}</span>
                <span className="app-tl-dot" aria-hidden="true" />
                <span className="app-plan-row__text">
                  {hour.count === 1 ? '1 email' : `${hour.count} emails`}
                  {hour.count > 1 && (
                    <small>
                      {hour.first.getTime() === hour.last.getTime()
                        ? 'All at once'
                        : `Last one at ${timeLabel(hour.last)}`}
                    </small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hidden.length > 0 && (
        <p className="app-plan-more">
          Then {hiddenCount} more over {hidden.length} {hidden.length === 1 ? 'hour' : 'hours'}, ending {endingAt(end)}.
        </p>
      )}
    </div>
  );
};
