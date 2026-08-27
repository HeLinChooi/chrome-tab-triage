import { formatMinutes, pluralize } from '../lib/format.js';
import { send, renderWarnings, guard, requestAnalysis, budgetSegments } from './shared.js';

const els = {
  total: document.getElementById('total'),
  sub: document.getElementById('sub'),
  bar: document.getElementById('bar'),
  groups: document.getElementById('groups'),
  warnings: document.getElementById('warnings'),
  analyze: document.getElementById('analyze'),
};

function render(report) {
  if (!report || !report.totals.tabs) {
    els.bar.innerHTML = '';
    els.groups.innerHTML = '<div class="empty">Run a summary to see where your time is parked.</div>';
    return;
  }

  els.total.textContent = formatMinutes(report.totals.minutes);
  els.sub.textContent = [
    `${pluralize(report.totals.tabs, 'tab')} across ${pluralize(report.totals.windows, 'window')}`,
    pluralize(report.groups.length, 'site'),
  ].join(' · ');

  renderWarnings(els.warnings, report.warnings);

  // Same segments, same colours, same order as the dashboard.
  const segments = budgetSegments(report);
  const total = segments.reduce((sum, s) => sum + s.minutes, 0);

  els.bar.innerHTML = '';
  for (const segment of segments) {
    const cell = document.createElement('div');
    cell.style.background = segment.color;
    cell.style.flex = `${Math.max(segment.minutes / total, 0.004)} 0 0`;
    cell.title = `${segment.name} — ${formatMinutes(segment.minutes)}`;
    els.bar.appendChild(cell);
  }

  // Every segment gets a row: the list is already folded to at most seven, and
  // the last of those is the remainder, which is the one row you cannot drop.
  els.groups.innerHTML = '';
  for (const segment of segments) {
    const row = document.createElement('div');
    row.className = 'grow';
    row.innerHTML = `
      <span class="swatch"></span>
      <div><div class="name truncate"></div><div class="meta truncate"></div></div>
      <span class="time"></span>`;
    row.querySelector('.swatch').style.background = segment.color;
    row.querySelector('.name').textContent = segment.name;
    row.querySelector('.meta').textContent = [
      pluralize(segment.count, 'tab'),
      segment.breakdown
        .slice(0, 2)
        .map((b) => `${b.count} ${b.label.toLowerCase()}`)
        .join(', '),
    ]
      .filter(Boolean)
      .join(' · ');
    row.querySelector('.time').textContent = formatMinutes(segment.minutes);
    els.groups.appendChild(row);
  }
}

els.analyze.addEventListener(
  'click',
  guard(els.analyze, 'Working…', async () => {
    const res = await requestAnalysis();
    if (res.ok) render(res.report);
    else renderWarnings(els.warnings, [res.error]);
  }),
);

document.getElementById('dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

send({ type: 'lastReport' }).then((res) => render(res.ok ? res.report : null));
