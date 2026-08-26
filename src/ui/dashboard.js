import { formatMinutes, formatAge, pluralize } from '../lib/format.js';
import { TASK_TYPES } from '../lib/taxonomy.js';
import { send, renderWarnings, guard } from './shared.js';

const els = {
  generated: document.getElementById('generated'),
  warnings: document.getElementById('warnings'),
  heroTotal: document.getElementById('heroTotal'),
  heroStats: document.getElementById('heroStats'),
  budget: document.getElementById('budget'),
  budgetBar: document.getElementById('budgetBar'),
  budgetLegend: document.getElementById('budgetLegend'),
  quickWins: document.getElementById('quickWins'),
  ledgerBody: document.getElementById('ledgerBody'),
  analyze: document.getElementById('analyze'),
  tooltip: document.getElementById('tooltip'),
};

/** Categorical slots, assigned in fixed order. The 7th and beyond fold into "Other". */
const SERIES_SLOTS = 6;
const seriesColor = (i) => (i < SERIES_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)');

let report = null;
let groupBy = 'site';
const collapsed = new Set(); // groups are open by default; this records the exceptions

// --- Hero ---------------------------------------------------------------

function renderHero() {
  const t = report.totals;
  els.heroTotal.textContent = formatMinutes(t.minutes);

  const stats = [
    ['Tabs', String(t.tabs)],
    ['Windows', String(t.windows)],
    ['Stale', `${t.staleTabs}`],
    ['Duplicates', String(t.duplicates)],
    ['Sites', String(report.groups.length)],
  ];
  els.heroStats.innerHTML = '';
  for (const [label, value] of stats) {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    cell.append(dt, dd);
    els.heroStats.appendChild(cell);
  }
}

// --- Budget bar ---------------------------------------------------------

/**
 * Fold the group list into at most SERIES_SLOTS named segments plus one "Other".
 * Segments narrower than a couple of pixels are unreadable, so the tail is
 * summarized rather than drawn.
 */
function budgetSegments() {
  const named = report.groups.slice(0, SERIES_SLOTS);
  const rest = report.groups.slice(SERIES_SLOTS);
  const segments = named.map((group, i) => ({
    name: group.name,
    minutes: group.minutes,
    count: group.count,
    color: seriesColor(i),
  }));

  if (rest.length) {
    segments.push({
      name: `${rest.length} other sites`,
      minutes: Math.round(rest.reduce((sum, g) => sum + g.minutes, 0) * 10) / 10,
      count: rest.reduce((sum, g) => sum + g.count, 0),
      color: 'var(--series-other)',
    });
  }
  return segments.filter((s) => s.minutes > 0);
}

function renderBudget() {
  const segments = budgetSegments();
  const total = segments.reduce((sum, s) => sum + s.minutes, 0);

  els.budget.hidden = segments.length < 2;
  if (segments.length < 2) return;

  els.budgetBar.innerHTML = '';
  els.budgetLegend.innerHTML = '';

  for (const segment of segments) {
    const share = segment.minutes / total;

    const bar = document.createElement('div');
    bar.className = 'budget-seg';
    bar.style.background = segment.color;
    bar.style.flex = `${Math.max(share, 0.004)} 0 0`;
    attachTooltip(bar, segment.name, `${formatMinutes(segment.minutes)} · ${pluralize(segment.count, 'tab')} · ${Math.round(share * 100)}% of the total`);
    els.budgetBar.appendChild(bar);

    // Identity is never carried by color alone: every segment is named here.
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = segment.color;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = segment.name;
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = `${formatMinutes(segment.minutes)} · ${Math.round(share * 100)}%`;
    item.append(swatch, who, amount);
    els.budgetLegend.appendChild(item);
  }
}

function attachTooltip(el, name, detail) {
  el.addEventListener('mouseenter', () => {
    els.tooltip.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tt-name';
    title.textContent = name;
    const body = document.createElement('div');
    body.className = 'tt-detail';
    body.textContent = detail;
    els.tooltip.append(title, body);
    els.tooltip.hidden = false;
  });
  el.addEventListener('mousemove', (event) => {
    const pad = 14;
    const width = els.tooltip.offsetWidth;
    const left = Math.min(event.clientX + pad, window.innerWidth - width - 8);
    els.tooltip.style.left = `${left}px`;
    els.tooltip.style.top = `${event.clientY + pad}px`;
  });
  el.addEventListener('mouseleave', () => {
    els.tooltip.hidden = true;
  });
}

// --- Quick wins ---------------------------------------------------------

function renderQuickWins() {
  const stale = report.items.filter((t) => t.stale);
  const dupes = duplicateTabs(report.items);
  const ids = new Set([...stale, ...dupes].map((t) => t.id));

  els.quickWins.hidden = ids.size === 0;
  if (!ids.size) return;

  const minutes = report.items.filter((t) => ids.has(t.id)).reduce((sum, t) => sum + t.minutes, 0);
  const detail = [
    dupes.length ? pluralize(dupes.length, 'duplicate') : '',
    stale.length ? `${pluralize(stale.length, 'tab')} untouched for a month` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  els.quickWins.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'qw-label';
  label.textContent = `Quick wins — ${formatMinutes(minutes)}`;
  const info = document.createElement('span');
  info.className = 'qw-detail';
  info.textContent = detail;

  const closeAll = document.createElement('button');
  closeAll.textContent = `Close all ${ids.size}`;
  closeAll.addEventListener('click', guard(closeAll, 'Closing…', () => closeMany([...ids].map((id) => report.items.find((t) => t.id === id)))));

  els.quickWins.append(label, info, closeAll);
  if (dupes.length) {
    const closeDupes = document.createElement('button');
    closeDupes.textContent = `Close ${pluralize(dupes.length, 'duplicate')}`;
    closeDupes.addEventListener('click', guard(closeDupes, 'Closing…', () => closeMany(dupes)));
    els.quickWins.appendChild(closeDupes);
  }
}

/** Every copy after the first occurrence of a URL. */
function duplicateTabs(items) {
  const seen = new Set();
  const dupes = [];
  for (const item of items) {
    const key = (item.url || '').split('#')[0];
    if (seen.has(key)) dupes.push(item);
    else seen.add(key);
  }
  return dupes;
}

// --- Ledger -------------------------------------------------------------

/** The ledger groups, in the same order and colors as the budget bar. */
function ledgerGroups() {
  if (groupBy === 'task') {
    return report.taskTypes.map((bucket, i) => ({
      key: `task:${bucket.type}`,
      name: bucket.label,
      mix: bucket.hint,
      minutes: bucket.minutes,
      color: seriesColor(i),
      tabs: report.items.filter((t) => t.taskType === bucket.type).sort((a, b) => b.minutes - a.minutes),
    }));
  }
  return report.groups.map((group, i) => ({
    key: `site:${group.name}`,
    name: group.name,
    mix: group.breakdown.map((b) => `${b.count} ${b.label.toLowerCase()}`).join(', '),
    minutes: group.minutes,
    color: seriesColor(i),
    tabs: group.tabs,
  }));
}

function renderLedger() {
  els.ledgerBody.innerHTML = '';
  if (!report.items.length) {
    els.ledgerBody.innerHTML = '<div class="empty">No tabs to triage.</div>';
    return;
  }

  for (const group of ledgerGroups()) {
    const section = document.createElement('div');
    section.className = 'lgroup';

    const head = document.createElement('div');
    head.className = 'lgroup-head';
    head.innerHTML = `
      <span class="swatch"></span>
      <div><span class="name"></span><span class="mix"></span></div>
      <span class="count"></span>
      <span class="time"></span>`;
    head.querySelector('.swatch').style.background = group.color;
    head.querySelector('.name').textContent = group.name;
    head.querySelector('.mix').textContent = group.mix;
    head.querySelector('.count').textContent = pluralize(group.tabs.length, 'tab');
    head.querySelector('.time').textContent = formatMinutes(group.minutes);
    head.addEventListener('click', () => {
      if (collapsed.has(group.key)) collapsed.delete(group.key);
      else collapsed.add(group.key);
      renderLedger();
    });
    section.appendChild(head);

    if (!collapsed.has(group.key)) {
      for (const tab of group.tabs) section.appendChild(tabRow(tab));
    }
    els.ledgerBody.appendChild(section);
  }
}

function tabRow(tab) {
  const row = document.createElement('div');
  row.className = 'tabrow';
  row.innerHTML = `
    <img class="favicon" alt="" />
    <div style="min-width:0">
      <div class="title truncate"></div>
      <div class="why truncate"></div>
    </div>
    <span class="pill"></span>
    <span class="time"></span>
    <span class="row-actions">
      <button class="go">open</button>
      <button class="close">close</button>
    </span>`;

  // Keep the column, drop the empty grey box: plenty of tabs have no icon.
  const icon = row.querySelector('.favicon');
  if (tab.favIconUrl) {
    icon.src = tab.favIconUrl;
    icon.addEventListener('error', () => {
      icon.removeAttribute('src');
      icon.style.visibility = 'hidden';
    });
  } else {
    icon.style.visibility = 'hidden';
  }

  row.querySelector('.title').textContent = tab.title;
  row.querySelector('.why').textContent = [tab.reason, formatAge(tab.lastAccessed, report.generatedAt)]
    .filter(Boolean)
    .join(' · ');

  const pill = row.querySelector('.pill');
  pill.textContent = (TASK_TYPES[tab.taskType] || TASK_TYPES.unknown).label;
  if (tab.stale) pill.classList.add('stale');

  row.querySelector('.time').textContent = formatMinutes(tab.minutes);
  row.querySelector('.go').addEventListener('click', () => send({ type: 'focusTab', tabId: tab.id }));
  row.querySelector('.close').addEventListener('click', async () => {
    await send({ type: 'closeTabs', tabIds: [tab.id] });
    row.remove();
  });
  return row;
}

async function closeMany(tabs) {
  const list = tabs.filter(Boolean);
  if (!list.length) return;
  const total = formatMinutes(list.reduce((sum, t) => sum + t.minutes, 0));
  if (!confirm(`Close ${pluralize(list.length, 'tab')}? That clears ${total} of estimated work.`)) return;
  await send({ type: 'closeTabs', tabIds: list.map((t) => t.id) });
  await refresh();
}

// --- Wiring -------------------------------------------------------------

function renderAll() {
  if (!report) {
    els.ledgerBody.innerHTML = '<div class="empty">No summary yet — hit Re-analyze.</div>';
    return;
  }
  const engine = report.engine === 'claude' ? 'Claude' : 'local heuristics';
  const source = report.pageAccess && report.pageAccess.enabled ? 'page text' : 'titles and URLs only';
  els.generated.textContent = `${new Date(report.generatedAt).toLocaleString()} · ${engine} · ${source}`;
  renderWarnings(els.warnings, report.warnings);
  renderHero();
  renderBudget();
  renderQuickWins();
  renderLedger();
}

async function refresh() {
  const res = await send({ type: 'analyze' });
  if (res.ok) {
    report = res.report;
    renderAll();
  } else {
    renderWarnings(els.warnings, [res.error]);
  }
}

els.analyze.addEventListener('click', guard(els.analyze, 'Working…', refresh));
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

for (const button of document.querySelectorAll('#groupBy button')) {
  button.addEventListener('click', () => {
    groupBy = button.dataset.group;
    collapsed.clear();
    for (const other of document.querySelectorAll('#groupBy button')) {
      other.classList.toggle('active', other === button);
    }
    renderLedger();
  });
}

send({ type: 'lastReport' }).then((res) => {
  report = res.ok ? res.report : null;
  renderAll();
  if (!report) refresh();
});
