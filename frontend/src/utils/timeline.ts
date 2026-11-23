/* Day and time labels shared by the mailbox timeline and the compose preview. */

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Same local day <=> same key. */
export const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** "Today", "Tomorrow", "Yesterday", otherwise "Monday, Nov 24" (with the year if it differs). */
export const dayLabel = (date: Date, now: Date = new Date()) => {
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
};

export const timeLabel = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Group items that are already in time order into consecutive days. */
export const groupByDay = <T>(items: T[], dateOf: (item: T) => Date) => {
  const groups: { key: string; date: Date; items: T[] }[] = [];
  for (const item of items) {
    const date = dateOf(item);
    const key = dayKey(date);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, date, items: [item] });
  }
  return groups;
};
