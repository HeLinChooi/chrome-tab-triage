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
import { estimateAll as estimateLocally } from './estimator-local.js';

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
  '- A tab untouched for over a month is backlog. Estimate what a realistic person would',
  '  actually spend on it now, which is usually far less than a full read.',
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

function describeTab(tab, index, now) {
  const entry = {
    index,
    title: (tab.title || '').slice(0, 160),
    url: (tab.url || '').slice(0, 300),
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

async function estimateChunk(client, settings, entries) {
  const response = await client.messages.create({
    model: settings.model || 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      // Classification is cheap thinking; low effort keeps the digest affordable.
      effort: 'low',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Estimate these ${entries.length} tabs:\n\n${JSON.stringify(entries, null, 1)}`,
      },
    ],
  });

  const parsed = JSON.parse(textOf(response));
  return parsed.tabs || [];
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
  const batches = chunk(
    sent.map((tab, i) => ({ tab, entry: describeTab(tab, i, now) })),
    CHUNK_SIZE,
  );

  try {
    const results = await mapLimit(batches, CONCURRENCY, async (batch) => {
      const rows = await estimateChunk(client, settings, batch.map((b) => b.entry));
      const byIndex = new Map(rows.map((r) => [r.index, r]));
      return batch.map((b) => ({ tab: b.tab, row: byIndex.get(b.entry.index) }));
    });

    for (const batch of results) {
      for (const { tab, row } of batch) {
        if (!row) continue;
        const fallback = byId.get(tab.id);
        byId.set(tab.id, {
          tabId: tab.id,
          minutes: Math.max(0, Math.round(Number(row.minutes) * 10) / 10),
          taskType: TASK_TYPES[row.taskType] ? row.taskType : fallback.taskType,
          confidence: tab.content ? 'high' : 'medium',
          reason: row.note || 'Estimated by Claude',
          stale: fallback.stale,
          note: row.note || '',
        });
      }
    }
  } catch (error) {
    return {
      engine: 'local',
      estimates: localPass.estimates,
      warnings: [`Claude request failed (${describeError(error)}). Used the local estimator instead.`],
    };
  }

  return { engine: 'claude', estimates: [...byId.values()], warnings };
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
