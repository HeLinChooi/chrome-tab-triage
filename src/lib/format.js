/** Display formatting helpers. Pure. */

/** "1h 20m", "45m", "< 1m". */
export function formatMinutes(minutes) {
  if (!minutes || minutes < 0.5) return '< 1m';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "3 days ago", "just now". */
export function formatAge(timestamp, now = Date.now()) {
  if (!timestamp) return 'unknown';
  const mins = (now - timestamp) / 60000;
  if (mins < 2) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One-line headline for the morning notification. */
export function headline(report) {
  return `${pluralize(report.totals.tabs, 'tab')} ≈ ${formatMinutes(report.totals.minutes)} to clear`;
}

/** Second line of the notification: where the time actually is. */
export function subhead(report) {
  const top = report.groups[0];
  const bits = [];
  if (top) bits.push(`${top.name} is the biggest at ${formatMinutes(top.minutes)}`);
  if (report.totals.staleTabs > 0) {
    bits.push(`${pluralize(report.totals.staleTabs, 'tab')} untouched for a month`);
  }
  return bits.join(' · ');
}
