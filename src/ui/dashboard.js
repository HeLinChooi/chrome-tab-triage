import { formatMinutes, formatAge, pluralize } from '../lib/format.js';
import { TASK_TYPES } from '../lib/taxonomy.js';
import { send, renderWarnings, guard, requestAnalysis } from './shared.js';

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
  cancel: document.getElementById('cancel'),
  progress: document.getElementById('progress'),
  tooltip: document.getElementById('tooltip'),
  readLog: document.getElementById('readLog'),
  readLogToggle: document.getElementById('readLogToggle'),
  readLogSummary: document.getElementById('readLogSummary'),
  readLogBody: document.getElementById('readLogBody'),
  transcript: document.getElementById('transcript'),
  transcriptToggle: document.getElementById('transcriptToggle'),
  transcriptSummary: document.getElementById('transcriptSummary'),
  transcriptBody: document.getElementById('transcriptBody'),
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
    ['Pages read', `${t.read ?? 0}/${t.tabs}`],
    ['Sized from page', `${t.measured ?? 0}/${t.tabs}`],
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

let quickWinsOpen = false;

function renderQuickWins() {
  const stale = report.items.filter((t) => t.stale);
  const dupes = duplicateTabs(report.items);
  const byId = new Map(report.items.map((t) => [t.id, t]));
  const ids = new Set([...stale, ...dupes].map((t) => t.id));
  const all = [...ids].map((id) => byId.get(id)).filter(Boolean);

  els.quickWins.hidden = ids.size === 0;
  if (!ids.size) return;

  const minutes = all.reduce((sum, t) => sum + t.minutes, 0);
  const detail = [
    dupes.length ? pluralize(dupes.length, 'duplicate') : '',
    stale.length ? `${pluralize(stale.length, 'tab')} untouched for a month` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  els.quickWins.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'qw-head';

  const label = document.createElement('span');
  label.className = 'qw-label';
  label.textContent = `Quick wins — ${formatMinutes(minutes)}`;

  const info = document.createElement('span');
  info.className = 'qw-detail';
  info.textContent = detail;

  // "Close all 3" is only a fair offer if you can see which three.
  const review = document.createElement('button');
  review.className = 'link';
  review.textContent = quickWinsOpen ? 'hide these tabs' : `show these ${ids.size} tabs`;
  review.addEventListener('click', () => {
    quickWinsOpen = !quickWinsOpen;
    renderQuickWins();
  });

  const closeAll = document.createElement('button');
  closeAll.textContent = `Close all ${ids.size}`;
  closeAll.addEventListener('click', guard(closeAll, 'Closing…', () => closeMany(all)));

  head.append(label, info, review, closeAll);
  if (dupes.length) {
    const closeDupes = document.createElement('button');
    closeDupes.textContent = `Close ${pluralize(dupes.length, 'duplicate')}`;
    closeDupes.addEventListener('click', guard(closeDupes, 'Closing…', () => closeMany(dupes)));
    head.appendChild(closeDupes);
  }
  els.quickWins.appendChild(head);

  if (quickWinsOpen) {
    const list = document.createElement('div');
    list.className = 'qw-list';
    const sorted = all.slice().sort((a, b) => b.minutes - a.minutes);
    for (const tab of sorted) list.appendChild(tabRow(tab, 'both'));
    els.quickWins.appendChild(list);
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
      <span class="chevron"></span>
      <span class="swatch"></span>
      <div><span class="name"></span><span class="mix"></span></div>
      <span class="count"></span>
      <span class="time"></span>`;
    head.querySelector('.swatch').style.background = group.color;
    head.querySelector('.name').textContent = group.name;
    head.querySelector('.mix').textContent = group.mix;
    head.querySelector('.count').textContent = pluralize(group.tabs.length, 'tab');
    head.querySelector('.time').textContent = formatMinutes(group.minutes);
    head.querySelector('.chevron').textContent = collapsed.has(group.key) ? '▸' : '▾';
    head.addEventListener('click', () => {
      if (collapsed.has(group.key)) collapsed.delete(group.key);
      else collapsed.add(group.key);
      renderLedger();
    });
    section.appendChild(head);

    if (!collapsed.has(group.key)) {
      const body = document.createElement('div');
      body.className = 'lgroup-body';
      body.style.borderLeftColor = group.color;
      const secondary = groupBy === 'task' ? 'site' : 'task';
      for (const tab of group.tabs) body.appendChild(tabRow(tab, secondary));
      section.appendChild(body);
    }
    els.ledgerBody.appendChild(section);
  }
}

/**
 * @param {object} tab
 * @param {'task'|'site'|'both'} secondary which label the pill should carry.
 *   Repeating the group's own dimension on every row is noise — under a "Watch"
 *   header, a "Watch" pill on each row says nothing and reads like a list item.
 */
function tabRow(tab, secondary = 'task') {
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
  const taskLabel = (TASK_TYPES[tab.taskType] || TASK_TYPES.unknown).label;
  pill.textContent =
    secondary === 'site' ? tab.site : secondary === 'both' ? `${tab.site} · ${taskLabel}` : taskLabel;
  if (tab.stale) pill.classList.add('stale');

  row.querySelector('.time').textContent = formatMinutes(tab.minutes);
  row.querySelector('.go').addEventListener('click', async () => {
    const res = await send({ type: 'focusTab', tabId: tab.id });
    // The report is a snapshot; a tab closed since then just leaves the list.
    if (res.gone) {
      row.style.opacity = '0.45';
      row.querySelector('.why').textContent = 'This tab has been closed since the summary was taken.';
    }
  });
  row.querySelector('.close').addEventListener('click', async () => {
    await send({ type: 'closeTabs', tabIds: [tab.id] });
    row.remove();
  });
  return row;
}

const CONFIRM_PREVIEW = 8;

async function closeMany(tabs) {
  const list = tabs.filter(Boolean);
  if (!list.length) return;

  const total = formatMinutes(list.reduce((sum, t) => sum + t.minutes, 0));
  // Name what is about to close. Closing tabs is not undoable from here.
  const preview = list
    .slice(0, CONFIRM_PREVIEW)
    .map((t) => `  · ${t.title}`)
    .join('\n');
  const more = list.length > CONFIRM_PREVIEW ? `\n  … and ${list.length - CONFIRM_PREVIEW} more` : '';

  const message = `Close ${pluralize(list.length, 'tab')}? That clears ${total} of estimated work.\n\n${preview}${more}`;
  if (!confirm(message)) return;
  await send({ type: 'closeTabs', tabIds: list.map((t) => t.id) });
  await refresh();
}

// --- Read log -----------------------------------------------------------

const OUTCOME_ORDER = ['frozen', 'would not unfreeze', 'timed out', 'nothing to measure', 'injection refused', 'would not wake', 'asleep', 'still loading', 'past deadline', 'cached', 'read'];

/**
 * Per-tab reading outcomes.
 *
 * Aggregate counts say how many tabs failed; they never say which, and "which"
 * is the only thing that makes a reading failure actionable, because the cause
 * is nearly always specific to the site.
 */
function renderReadLog() {
  const log = report.readLog || [];
  els.readLog.hidden = log.length === 0;
  if (!log.length) return;

  const counts = new Map();
  for (const row of log) counts.set(row.outcome, (counts.get(row.outcome) || 0) + 1);
  els.readLogSummary.textContent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(' · ');

  const rank = (o) => {
    const i = OUTCOME_ORDER.indexOf(o);
    return i === -1 ? OUTCOME_ORDER.length : i;
  };

  els.readLogBody.innerHTML = '';
  const table = document.createElement('div');
  table.className = 'rl-table';

  for (const row of log.slice().sort((a, b) => rank(a.outcome) - rank(b.outcome))) {
    const line = document.createElement('div');
    line.className = 'rl-row';

    const outcome = document.createElement('span');
    outcome.className = `rl-outcome rl-${row.outcome.replace(/\s+/g, '-')}`;
    outcome.textContent = row.outcome;

    const title = document.createElement('span');
    title.className = 'truncate';
    title.textContent = row.title || row.url;
    title.title = row.url;

    const detail = document.createElement('span');
    detail.className = 'rl-detail';
    const bits = [];
    if (row.wordCount != null) bits.push(`${row.wordCount} words`);
    if (row.videoSeconds) bits.push(`${Math.round(row.videoSeconds / 60)}m media`);
    if (row.contentNodes != null) bits.push(`${row.contentNodes} content nodes`);
    if (row.readyState && row.readyState !== 'complete') bits.push(row.readyState);
    if (row.tookMs != null) bits.push(`${row.tookMs}ms`);
    if (row.waitedMs != null) bits.push(`waited ${row.waitedMs}ms`);
    if (row.frozen) bits.push('tab.frozen');
    if (row.revived) bits.push('after reload');
    if (row.attempts > 1) bits.push(`${row.attempts} attempts`);
    detail.textContent = bits.join(' · ');

    line.append(outcome, title, detail);
    table.appendChild(line);
  }
  els.readLogBody.appendChild(table);
}

// --- Transcript ---------------------------------------------------------

/**
 * Shows exactly what left the browser and what came back.
 *
 * The Claude engine sends tab titles, URLs and page excerpts to a third party;
 * a user is entitled to read the request rather than take the description of it
 * on faith. Rendered as text, never as markup.
 */
function renderTranscript() {
  const t = report.transcript;

  if (!t || !t.exchanges.length) {
    els.transcriptSummary.textContent =
      report.engine === 'claude'
        ? 'This run produced no completed API exchanges.'
        : 'Nothing. This summary was produced by the local estimator, which makes no network calls — no tab data left this browser.';
    els.transcriptToggle.hidden = !t;
    els.transcriptBody.hidden = true;
    if (!t) return;
  }

  els.transcriptToggle.hidden = false;
  const totals = t.totals;
  const bits = [
    `${pluralize(t.requests, 'request')} to ${t.model}`,
    `${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out tokens`,
    `${(totals.ms / 1000).toFixed(1)}s`,
  ];
  if (totals.costUsd != null) bits.push(`roughly $${totals.costUsd.toFixed(4)}`);
  if (t.failure) bits.push(`failed: ${t.failure}`);
  els.transcriptSummary.textContent = bits.join(' · ');

  els.transcriptBody.innerHTML = '';

  // The token counts are exact — they come from the API. The dollar figure does
  // not, so say where it comes from rather than presenting it as authoritative.
  if (t.rate) {
    const note = document.createElement('p');
    note.className = 'muted tiny';
    // What one run costs matters less than what the habit costs.
    const monthly = totals.costUsd * 30;
    note.textContent =
      `This run cost roughly $${totals.costUsd.toFixed(4)}. A daily digest at this size would be ` +
      `about $${monthly.toFixed(2)} a month. Token counts are reported by the API and are exact; ` +
      `the dollar figure is an estimate from a rate table built into this extension — ` +
      `$${t.rate.input}/M input and $${t.rate.output}/M output, list price as of ${t.rateAsOf}. ` +
      `It will drift if those prices change and it ignores any discount on your account. ` +
      `Your Anthropic console is the source of truth.`;
    els.transcriptBody.appendChild(note);
  }

  els.transcriptBody.appendChild(
    codeBlock('System prompt', 'sent once per request', t.systemPrompt),
  );
  els.transcriptBody.appendChild(
    codeBlock('Response schema', 'the shape Claude is constrained to return', JSON.stringify(t.schema, null, 2)),
  );

  t.exchanges.forEach((exchange, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'tr-exchange';

    const meta = document.createElement('div');
    meta.className = 'tr-meta';
    const usage = exchange.usage || {};
    meta.innerHTML = '';
    for (const [label, value] of [
      ['Tabs', String(exchange.tabCount)],
      ['Input tokens', (usage.input_tokens || 0).toLocaleString()],
      ['Output tokens', (usage.output_tokens || 0).toLocaleString()],
      ['Took', `${(exchange.ms / 1000).toFixed(1)}s`],
      ['Stop reason', exchange.stopReason || '—'],
    ]) {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = value;
      span.append(`${label} `, b);
      meta.appendChild(span);
    }

    wrap.appendChild(meta);
    wrap.appendChild(codeBlock(`Request ${i + 1}`, 'the user message', exchange.request));
    wrap.appendChild(codeBlock(`Response ${i + 1}`, 'raw, before parsing', exchange.response));
    els.transcriptBody.appendChild(wrap);
  });

  if (t.truncated) {
    const note = document.createElement('p');
    note.className = 'muted tiny';
    note.textContent = `${t.omittedExchanges} further exchange(s) were omitted to keep the stored transcript small.`;
    els.transcriptBody.appendChild(note);
  }
}

function codeBlock(title, hint, text) {
  const block = document.createElement('div');
  block.className = 'tr-block';

  const heading = document.createElement('h3');
  heading.textContent = title;
  const hintEl = document.createElement('span');
  hintEl.className = 'muted';
  hintEl.textContent = hint;
  const copy = document.createElement('button');
  copy.className = 'tr-copy';
  copy.textContent = 'copy';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    copy.textContent = 'copied';
    setTimeout(() => {
      copy.textContent = 'copy';
    }, 1200);
  });
  heading.append(hintEl, copy);

  const pre = document.createElement('pre');
  pre.className = 'tr-pre';
  pre.textContent = text; // never innerHTML — this is untrusted page-derived content

  block.append(heading, pre);
  return block;
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
  renderReadLog();
  renderTranscript();
}

const PHASE_LABEL = {
  starting: 'Starting…',
  collecting: 'Collecting tabs…',
  estimating: 'Estimating…',
};

/** Live progress, so a long run reads as working rather than wedged. */
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'analysisProgress') return;
  if (message.phase === 'reading') {
    els.progress.textContent = `Reading pages ${message.done}/${message.total}…`;
    return;
  }
  if (message.phase === 'waking') {
    els.progress.textContent = `Waking sleeping tabs ${message.done}/${message.total}…`;
    return;
  }
  els.progress.textContent = PHASE_LABEL[message.phase] || '';
});

function setBusy(busy) {
  els.cancel.hidden = !busy;
  els.progress.hidden = !busy;
  if (!busy) els.progress.textContent = '';
}

async function refresh() {
  setBusy(true);
  try {
    const res = await requestAnalysis();
    if (res.ok) {
      report = res.report;
      renderAll();
      if (res.recovered) {
        renderWarnings(els.warnings, [
          'The extension worker restarted during this run; the summary was recovered from storage.',
        ]);
      }
    } else if (res.cancelled) {
      renderWarnings(els.warnings, ['Summary cancelled — showing the previous one.']);
    } else {
      renderWarnings(els.warnings, [res.error]);
    }
  } finally {
    setBusy(false);
  }
}

els.readLogToggle.addEventListener('click', () => {
  const showing = !els.readLogBody.hidden;
  els.readLogBody.hidden = showing;
  els.readLogToggle.textContent = showing ? 'show' : 'hide';
});

els.transcriptToggle.addEventListener('click', () => {
  const showing = !els.transcriptBody.hidden;
  els.transcriptBody.hidden = showing;
  els.transcriptToggle.textContent = showing ? 'show' : 'hide';
});

els.analyze.addEventListener('click', guard(els.analyze, 'Working…', refresh));
els.cancel.addEventListener('click', async () => {
  els.cancel.disabled = true;
  els.progress.textContent = 'Cancelling…';
  await send({ type: 'cancelAnalysis' });
  els.cancel.disabled = false;
});
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
