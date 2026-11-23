/**
 * Hour windows are in UTC, so every process (and every DST change) agrees on them.
 */

const pad = (n: number) => String(n).padStart(2, '0');

const hourWindowKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(
    date.getUTCHours()
  )}`;

/** Current hour window key, format YYYY-MM-DD-HH (UTC). */
export const getCurrentHourWindow = (now: Date = new Date()): string => hourWindowKey(now);

/** Start of the next UTC hour. */
export const getNextHourTimestamp = (now: Date = new Date()): Date => {
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return next;
};

/** Seconds left in the current hour window. */
export const getSecondsUntilNextHour = (now: Date = new Date()): number =>
  Math.max(1, Math.ceil((getNextHourTimestamp(now).getTime() - now.getTime()) / 1000));
