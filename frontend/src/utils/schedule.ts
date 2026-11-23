const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Format a Date for <input type="datetime-local"> in the user's local time
 * (toISOString would give UTC, which the input then misreads as local).
 */
export const toLocalInputValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;

/** Tomorrow at the given local hour, e.g. 11 for 11:00 AM. */
export const tomorrowAt = (hour: number, now: Date = new Date()): Date => {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return date;
};

const HOUR_MS = 3600 * 1000;

/** Start of the UTC clock hour containing `ms`, the window the server counts in. */
const hourStart = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * Send time for each of `count` emails starting at `start`:
 * - `delaySeconds` apart, and
 * - at most `hourlyLimit` per hour (0 = no limit), counted per UTC clock hour
 *   (10:00-11:00, ...) like the server's limit, so the preview matches when
 *   the server actually sends. An email that would go over moves to the start
 *   of the next hour.
 */
export const buildSendTimes = (
  start: Date,
  count: number,
  delaySeconds: number,
  hourlyLimit: number
): Date[] => {
  const startMs = start.getTime();
  const delayMs = Math.max(0, delaySeconds) * 1000;
  const limit = Math.max(0, Math.floor(hourlyLimit));

  const times: Date[] = [];
  let previous = startMs - delayMs;
  let windowStart = Number.NaN;
  let sentInWindow = 0;
  for (let i = 0; i < count; i++) {
    let at = Math.max(startMs, previous + delayMs);
    if (limit > 0) {
      if (hourStart(at) !== windowStart) {
        windowStart = hourStart(at);
        sentInWindow = 0;
      }
      if (sentInWindow >= limit) {
        windowStart += HOUR_MS;
        at = windowStart;
        sentInWindow = 0;
      }
      sentInWindow++;
    }
    previous = at;
    times.push(new Date(at));
  }
  return times;
};
