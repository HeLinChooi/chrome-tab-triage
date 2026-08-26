/**
 * Grouping and report assembly.
 *
 * Groups are keyed by site, and each group carries a breakdown by task type —
 * the two dimensions the user actually navigates by ("what is this from" and
 * "what does it want from me").
 */

import { siteLabel, TASK_TYPES } from './taxonomy.js';

/**
 * @param {Array} tabs normalized tab records
 * @param {Array} estimates per-tab estimates, aligned by tabId
 * @param {object} meta {engine, warnings}
 */
export function buildReport(tabs, estimates, meta = {}) {
  const byId = new Map(estimates.map((e) => [e.tabId, e]));
  const items = [];

  for (const tab of tabs) {
    const est = byId.get(tab.id);
    if (!est) continue;
    items.push({
      ...tab,
      minutes: est.minutes,
      taskType: est.taskType,
      confidence: est.confidence,
      reason: est.reason,
      stale: Boolean(est.stale),
      note: est.note || '',
      site: siteLabel(tab.url),
    });
  }

  const groups = groupBySite(items);
  const taskTypes = groupByTaskType(items);

  return {
    generatedAt: Date.now(),
    engine: meta.engine || 'local',
    warnings: meta.warnings || [],
    totals: {
      tabs: items.length,
      windows: new Set(items.map((t) => t.windowId)).size,
      minutes: round(sum(items.map((t) => t.minutes))),
      staleTabs: items.filter((t) => t.stale).length,
      staleMinutes: round(sum(items.filter((t) => t.stale).map((t) => t.minutes))),
      duplicates: countDuplicates(items),
    },
    groups,
    taskTypes,
    items,
  };
}

function groupBySite(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.site)) map.set(item.site, []);
    map.get(item.site).push(item);
  }
  return [...map.entries()]
    .map(([name, tabs]) => ({
      name,
      tabs: tabs.slice().sort((a, b) => b.minutes - a.minutes),
      count: tabs.length,
      minutes: round(sum(tabs.map((t) => t.minutes))),
      staleCount: tabs.filter((t) => t.stale).length,
      breakdown: taskBreakdown(tabs),
    }))
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count);
}

function groupByTaskType(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.taskType)) map.set(item.taskType, []);
    map.get(item.taskType).push(item);
  }
  return [...map.entries()]
    .map(([type, tabs]) => ({
      type,
      label: (TASK_TYPES[type] || TASK_TYPES.unknown).label,
      hint: (TASK_TYPES[type] || TASK_TYPES.unknown).hint,
      count: tabs.length,
      minutes: round(sum(tabs.map((t) => t.minutes))),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

function taskBreakdown(tabs) {
  const counts = {};
  for (const tab of tabs) counts[tab.taskType] = (counts[tab.taskType] || 0) + 1;
  return Object.entries(counts)
    .map(([type, count]) => ({ type, label: (TASK_TYPES[type] || TASK_TYPES.unknown).label, count }))
    .sort((a, b) => b.count - a.count);
}

/** Same URL open more than once — the cheapest tabs to close. */
function countDuplicates(items) {
  const seen = new Set();
  let dupes = 0;
  for (const item of items) {
    const key = (item.url || '').split('#')[0];
    if (seen.has(key)) dupes += 1;
    else seen.add(key);
  }
  return dupes;
}

const sum = (nums) => nums.reduce((a, b) => a + b, 0);
const round = (n) => Math.round(n * 10) / 10;
