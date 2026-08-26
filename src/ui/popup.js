import { formatMinutes, pluralize } from '../lib/format.js';
import { send, renderWarnings } from './shared.js';

const els = {
  total: document.getElementById('total'),
  sub: document.getElementById('sub'),
  groups: document.getElementById('groups'),
  warnings: document.getElementById('warnings'),
  analyze: document.getElementById('analyze'),
};

const TOP_GROUPS = 5;

function render(report) {
  if (!report) {
    els.groups.innerHTML = '<div class="empty">Run a summary to see where your time is parked.</div>';
    return;
  }

  els.total.textContent = formatMinutes(report.totals.minutes);
  const parts = [`${pluralize(report.totals.tabs, 'tab')} across ${pluralize(report.totals.windows, 'window')}`];
  if (report.totals.staleTabs) parts.push(`${report.totals.staleTabs} stale`);
  if (report.totals.duplicates) parts.push(`${report.totals.duplicates} duplicate`);
  els.sub.textContent = parts.join(' · ');

  renderWarnings(els.warnings, report.warnings);

  const max = report.groups[0] ? report.groups[0].minutes : 1;
  els.groups.innerHTML = '';
  for (const group of report.groups.slice(0, TOP_GROUPS)) {
    const row = document.createElement('div');
    row.className = 'grow';
    row.innerHTML = `
      <div>
        <div class="name truncate"></div>
        <div class="meta"></div>
        <div class="bar" style="width:${Math.max(6, (group.minutes / max) * 100)}%; margin-top:5px"></div>
      </div>
      <div class="time"></div>`;
    row.querySelector('.name').textContent = group.name;
    row.querySelector('.meta').textContent = `${pluralize(group.count, 'tab')} · ${group.breakdown
      .slice(0, 2)
      .map((b) => `${b.count} ${b.label.toLowerCase()}`)
      .join(', ')}`;
    row.querySelector('.time').textContent = formatMinutes(group.minutes);
    els.groups.appendChild(row);
  }

  const rest = report.groups.length - TOP_GROUPS;
  if (rest > 0) {
    const more = document.createElement('div');
    more.className = 'muted tiny';
    more.textContent = `+ ${pluralize(rest, 'more site')}`;
    els.groups.appendChild(more);
  }
}

async function analyze() {
  els.analyze.disabled = true;
  els.analyze.textContent = 'Working…';
  try {
    const res = await send({ type: 'analyze' });
    if (res.ok) render(res.report);
    else renderWarnings(els.warnings, [res.error]);
  } finally {
    els.analyze.disabled = false;
    els.analyze.textContent = 'Summarize now';
  }
}

els.analyze.addEventListener('click', analyze);
document.getElementById('dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

send({ type: 'lastReport' }).then((res) => render(res.ok ? res.report : null));
