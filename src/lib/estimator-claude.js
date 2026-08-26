/**
 * Claude-backed estimator.
 *
 * Sends a compact description of each tab — title, URL, staleness, and (when the
 * user has granted page access) length signals and a short excerpt — and asks for
 * a per-tab minute estimate and task type. Structured outputs keep the response
 * machine-readable, so there is no parsing guesswork.
 *
 * The user's own API key is used, and nothing is sent unless they pick this engine.
 */

import Anthropic from '@anthropic-ai/sdk';
import { TASK_TYPES } from './taxonomy.js';
import { estimateAll as estimateLocally, baseEstimate, DEFAULT_WPM } from './estimator-local.js';
import { applyStaleness } from './staleness.js';

/** Tabs per request. Large enough to be cheap, small enough to stay reliable. */
const CHUNK_SIZE = 50;

/** Hard ceiling on how many tabs we will spend tokens on in one run. */
const MAX_TABS = 400;

/** How many chunk requests may be in flight at once. */
const CONCURRENCY = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    tabs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The index given in the input list' },
          minutes: { type: 'number', description: 'Minutes of focused effort to finish with this tab and close it' },
          taskType: { type: 'string', enum: Object.keys(TASK_TYPES) },
          note: { type: 'string', description: 'At most 12 words explaining the estimate' },
        },
        required: ['index', 'minutes', 'taskType', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['tabs'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You estimate how long it would take a person to finish with a browser tab and close it.',
  '',
  'For each tab, return:',
  '- minutes: focused minutes to reach a state where the tab can be closed. Reading an',
  '  article means reading it; a video means watching it; a pull request means reviewing',
  '  and responding; a reference page kept open for lookup is a skim, not a full read.',
  '  Use 0 for tabs that need no work at all.',
  '- taskType: one of ' + Object.keys(TASK_TYPES).join(', ') + '.',
  '- note: at most 12 words on what drove the estimate.',
  '',
  'Calibration:',
  '- Estimate the effort fresh, as if the tab were opened today. Do NOT discount for how',
  '  old the tab is. The ageDays field is context only; a separate, uniform adjustment for',
  '  stale tabs is applied to your answer afterwards, so discounting here double-counts it.',
  '- baselineMinutes is a rule-based estimate of the same quantity. Treat it as a prior:',
  '  stay close to it unless the title, URL, or excerpt gives you a concrete reason to',
  '  differ, and let your note say what that reason was.',
  '- wordCount and videoSeconds, when present, are measured from the page. Trust them over',
  '  your impression of the title.',
  '- Be concrete rather than generous. Most tabs are under 10 minutes.',
].join('\n');

function buildClient(settings) {
  return new Anthropic({
    apiKey: settings.apiKey,
    // The extension service worker is a browser-like context and talks to the
    // API directly with the user's own key, by their explicit choice. This also
    // makes the SDK send the anthropic-dangerous-direct-browser-access header,
    // without which the API rejects requests from a browser origin.
    dangerouslyAllowBrowser: true,
  });
}

function describeTab(tab, index, now, wpm) {
  const entry = {
    index,
    title: (tab.title || '').slice(0, 160),
    url: (tab.url || '').slice(0, 300),
    // The local engine's fresh-effort number, sent as a prior so the two engines
    // do not drift apart on tabs where neither has a strong signal.
    baselineMinutes: Math.round(baseEstimate(tab, { wpm }).minutes * 10) / 10,
  };
  if (tab.lastAccessed) entry.ageDays = Math.round((now - tab.lastAccessed) / DAY_MS);
  if (tab.audible) entry.playingAudio = true;
  if (tab.content) {
    if (tab.content.wordCount) entry.wordCount = tab.content.wordCount;
    if (tab.content.videoSeconds) entry.videoSeconds = tab.content.videoSeconds;
    if (tab.content.formFields) entry.formFields = tab.content.formFields;
    if (tab.content.excerpt) entry.excerpt = tab.content.excerpt.slice(0, 300);
  }
  return entry;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run async jobs with a fixed ceiling on parallelism. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function textOf(response) {
  return (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * One request, returned along with everything needed to show the user exactly
 * what left their browser and what came back.
 */
async function estimateChunk(client, settings, entries) {
  const model = settings.model || 'claude-opus-5';
  const userContent = `Estimate these ${entries.length} tabs:\n\n${JSON.stringify(entries, null, 1)}`;
  const startedAt = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      // Classification is cheap thinking; low effort keeps the digest affordable.
      effort: 'low',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: 'user', content: userContent }],
  });

  const text = textOf(response);
  const parsed = JSON.parse(text);

  return {
    rows: parsed.tabs || [],
    exchange: {
      model,
      tabCount: entries.length,
      request: userContent,
      response: text,
      usage: response.usage || null,
      stopReason: response.stop_reason || null,
      ms: Date.now() - startedAt,
    },
  };
}

/**
 * @returns {{engine: string, estimates: Array, warnings: string[]}}
 */
export async function estimateAll(tabs, settings) {
  if (!settings.apiKey) {
    const local = await estimateLocally(tabs, settings);
    return { ...local, warnings: ['No API key set — used the local estimator instead.'] };
  }

  const now = Date.now();
  const warnings = [];

  // Anything past the ceiling is estimated locally so a 900-tab profile still works.
  const sent = tabs.slice(0, MAX_TABS);
  const overflow = tabs.slice(MAX_TABS);
  if (overflow.length) {
    warnings.push(`${overflow.length} tabs beyond the first ${MAX_TABS} were estimated locally.`);
  }

  // The local pass is both a prior and the fallback for anything Claude omits.
  const localPass = await estimateLocally(tabs, settings);
  const byId = new Map(localPass.estimates.map((e) => [e.tabId, e]));

  const client = buildClient(settings);
  const wpm = settings.wpm || DEFAULT_WPM;
  const batches = chunk(
    sent.map((tab, i) => ({ tab, entry: describeTab(tab, i, now, wpm) })),
    CHUNK_SIZE,
  );

  const exchanges = [];

  try {
    const results = await mapLimit(batches, CONCURRENCY, async (batch) => {
      const { rows, exchange } = await estimateChunk(client, settings, batch.map((b) => b.entry));
      exchanges.push(exchange);
      const byIndex = new Map(rows.map((r) => [r.index, r]));
      return batch.map((b) => ({ tab: b.tab, row: byIndex.get(b.entry.index) }));
    });

    for (const batch of results) {
      for (const { tab, row } of batch) {
        if (!row) continue;
        const fallback = byId.get(tab.id);
        const fresh = Math.max(0, Number(row.minutes) || 0);

        // The same discount the local engine gets, applied here rather than asked
        // for in the prompt — one rule, so the two engines stay comparable.
        const { minutes, stale, factor, ageDays } = applyStaleness(fresh, tab, now);
        const note = row.note || 'Estimated by Claude';

        byId.set(tab.id, {
          tabId: tab.id,
          minutes,
          taskType: TASK_TYPES[row.taskType] ? row.taskType : fallback.taskType,
          confidence: tab.content ? 'high' : 'medium',
          reason: factor < 1 ? `${note}; discounted — untouched for ${Math.round(ageDays)} days` : note,
          stale,
          note,
        });
      }
    }
  } catch (error) {
    return {
      engine: 'local',
      estimates: localPass.estimates,
      warnings: [`Claude request failed (${describeError(error)}). Used the local estimator instead.`],
      transcript: buildTranscript(exchanges, { failure: describeError(error) }),
    };
  }

  return {
    engine: 'claude',
    estimates: [...byId.values()],
    warnings,
    transcript: buildTranscript(exchanges),
  };
}

/**
 * Per-million-token list rates, used only to turn the token counts the API
 * returns into a rough dollar figure for the transcript panel.
 *
 * This is a hardcoded table, not a live lookup — the Messages API returns usage,
 * not prices, and there is no pricing endpoint to read. So it goes stale if
 * Anthropic changes list prices, and it does not know about your discounts,
 * batch pricing, or cache-read rates. It is labelled as an estimate wherever it
 * is shown, the rates used are displayed alongside the figure so a reader can
 * check them, and a model missing from the table shows token counts with no
 * dollar figure rather than a wrong one.
 *
 * The token counts themselves come from the API and are always exact.
 */
export const PRICING_AS_OF = '2026-06-24';

const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** Keep the stored transcript bounded; chrome.storage.local is not a log sink. */
const MAX_TRANSCRIPT_CHARS = 300000;

/**
 * Assemble the record shown in the dashboard's transcript panel: the exact
 * system prompt, every request body, every raw response, and what it cost.
 */
export function buildTranscript(exchanges, meta = {}) {
  const totals = exchanges.reduce(
    (acc, ex) => {
      const usage = ex.usage || {};
      acc.inputTokens += usage.input_tokens || 0;
      acc.outputTokens += usage.output_tokens || 0;
      acc.cacheReadTokens += usage.cache_read_input_tokens || 0;
      acc.ms += ex.ms || 0;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, ms: 0 },
  );

  const model = exchanges.length ? exchanges[0].model : null;
  const rate = model ? PRICING[model] : null;
  const costUsd = rate
    ? (totals.inputTokens / 1e6) * rate.input + (totals.outputTokens / 1e6) * rate.output
    : null;

  // Truncate oldest-first so the panel always shows a complete, readable exchange.
  let budget = MAX_TRANSCRIPT_CHARS;
  let truncated = false;
  const kept = [];
  for (const ex of exchanges) {
    const size = ex.request.length + ex.response.length;
    if (size > budget) {
      truncated = true;
      break;
    }
    budget -= size;
    kept.push(ex);
  }

  return {
    model,
    systemPrompt: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    // Shown next to the cost so the reader can check the arithmetic and see
    // when the rates were last confirmed.
    rate: rate || null,
    rateAsOf: PRICING_AS_OF,
    requests: exchanges.length,
    exchanges: kept,
    omittedExchanges: exchanges.length - kept.length,
    truncated,
    totals: { ...totals, costUsd },
    failure: meta.failure || null,
  };
}

function describeError(error) {
  if (error && typeof error.status === 'number') {
    if (error.status === 401) return 'invalid API key';
    if (error.status === 429) return 'rate limited';
    if (error.status >= 500) return `server error ${error.status}`;
    return `HTTP ${error.status}`;
  }
  return (error && error.message) || 'unknown error';
}
