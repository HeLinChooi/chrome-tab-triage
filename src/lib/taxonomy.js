/**
 * Task taxonomy and domain rules.
 *
 * Pure module: no Chrome APIs, no network. Everything here is a function of a
 * normalized tab record, so it can be unit tested directly.
 */

/** Task types a tab can fall into. Order matters for display. */
export const TASK_TYPES = {
  read: { label: 'Read', hint: 'Articles, docs, long posts' },
  watch: { label: 'Watch', hint: 'Video and audio' },
  act: { label: 'Act', hint: 'Something is waiting on you' },
  shop: { label: 'Shop', hint: 'Products, carts, listings' },
  reference: { label: 'Reference', hint: 'Kept open to look things up' },
  social: { label: 'Social', hint: 'Feeds and chat' },
  admin: { label: 'Admin', hint: 'Mail, tickets, calendars, dashboards' },
  unknown: { label: 'Unclear', hint: 'Not enough signal to classify' },
};

/**
 * Domain rules, most specific first. `match` runs against the whole URL so a
 * rule can key off a path (github.com/x/y/pull/1) as well as a host.
 *
 * `minutes` is the fallback estimate used when we have no page text.
 */
const DOMAIN_RULES = [
  // --- Act: something is explicitly waiting on the user ---
  { match: /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/(pull|compare)\//, type: 'act', minutes: 12, label: 'GitHub' },
  { match: /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/issues\/\d+/, type: 'act', minutes: 7, label: 'GitHub' },
  { match: /^https?:\/\/(www\.)?gitlab\.com\/.*\/-\/merge_requests\//, type: 'act', minutes: 12, label: 'GitLab' },
  { match: /\.atlassian\.net\/browse\//, type: 'act', minutes: 8, label: 'Jira' },
  { match: /^https?:\/\/(www\.)?linear\.app\//, type: 'act', minutes: 6, label: 'Linear' },
  { match: /^https?:\/\/[^/]*docs\.google\.com\//, type: 'act', minutes: 15, label: 'Google Docs' },
  { match: /^https?:\/\/[^/]*notion\.so\//, type: 'act', minutes: 10, label: 'Notion' },
  { match: /^https?:\/\/[^/]*figma\.com\/(file|design|board)\//, type: 'act', minutes: 15, label: 'Figma' },

  // --- Watch ---
  { match: /^https?:\/\/(www\.)?youtube\.com\/watch/, type: 'watch', minutes: 14, label: 'YouTube' },
  { match: /^https?:\/\/(www\.)?youtube\.com\//, type: 'social', minutes: 6, label: 'YouTube' },
  { match: /^https?:\/\/(www\.)?(vimeo|twitch\.tv|netflix|udemy|coursera)\./, type: 'watch', minutes: 25 },
  { match: /^https?:\/\/[^/]*\.?(spotify|soundcloud)\.com\//, type: 'watch', minutes: 20 },

  // --- Admin ---
  { match: /^https?:\/\/mail\.google\.com\//, type: 'admin', minutes: 20, label: 'Gmail' },
  { match: /^https?:\/\/(outlook|teams)\.(live|office|microsoft)\.com\//, type: 'admin', minutes: 20 },
  { match: /^https?:\/\/calendar\.google\.com\//, type: 'admin', minutes: 5, label: 'Google Calendar' },
  { match: /^https?:\/\/[^/]*\.?(slack|discord)\.com\//, type: 'social', minutes: 15 },
  { match: /^https?:\/\/console\.(aws\.amazon|cloud\.google)\.com\//, type: 'admin', minutes: 12 },

  // --- Shop ---
  { match: /^https?:\/\/(www\.)?(amazon|ebay|etsy|shopee|lazada|taobao|aliexpress|shopify)\./, type: 'shop', minutes: 8 },
  { match: /\/(cart|checkout|basket)(\/|\?|$)/, type: 'shop', minutes: 6 },

  // --- Social ---
  { match: /^https?:\/\/(www\.)?(x|twitter|reddit|facebook|instagram|linkedin|tiktok|threads)\./, type: 'social', minutes: 10 },
  { match: /^https?:\/\/news\.ycombinator\.com\//, type: 'social', minutes: 8 },

  // --- Reference: kept open to look at, rarely "finished" ---
  { match: /^https?:\/\/(www\.)?(stackoverflow|serverfault|superuser)\.com\//, type: 'reference', minutes: 5 },
  { match: /^https?:\/\/(developer\.mozilla\.org|docs\.|.*\/docs\/)/, type: 'reference', minutes: 6 },
  { match: /^https?:\/\/(www\.)?(google|duckduckgo|bing)\.[a-z.]+\/search/, type: 'reference', minutes: 2 },
  { match: /^https?:\/\/(www\.)?github\.com\//, type: 'reference', minutes: 6, label: 'GitHub' },
  { match: /^https?:\/\/(www\.)?npmjs\.com\//, type: 'reference', minutes: 3 },

  // --- Read ---
  { match: /^https?:\/\/(www\.)?(medium|substack|dev\.to)\./, type: 'read', minutes: 9 },
  { match: /^https?:\/\/[^/]*\.substack\.com\//, type: 'read', minutes: 9 },
  { match: /^https?:\/\/arxiv\.org\//, type: 'read', minutes: 35 },
];

/** Titles that betray an unfinished action regardless of domain. */
const TITLE_ACT_HINTS = [
  /\bunsaved\b/i,
  /^\(\d+\)/, // "(3) Inbox" style unread counts
  /\bdraft\b/i,
  /\bcheckout\b/i,
];

/** Chrome internal / non-web pages we should never charge time for. */
export function isInternalUrl(url) {
  return /^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(url || '');
}

/**
 * eTLD+1-ish host reduction. Deliberately naive — a real public-suffix list is
 * overkill here, and getting `bbc.co.uk` and `docs.google.com` right covers the
 * long tail that actually shows up in a tab bar.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.in', 'com.au', 'com.br', 'com.cn',
  'com.mx', 'com.sg', 'com.my', 'com.hk', 'com.tw', 'org.uk', 'net.au', 'ac.uk',
]);

export function registrableDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  const take = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/**
 * Human-facing group name for a tab. Subdomains that carry real meaning
 * (docs.google.com, mail.google.com) keep their identity; everything else
 * collapses to the registrable domain.
 */
const NAMED_HOSTS = {
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'mail.google.com': 'Gmail',
  'calendar.google.com': 'Google Calendar',
  'sheets.google.com': 'Google Sheets',
  'news.ycombinator.com': 'Hacker News',
  'developer.mozilla.org': 'MDN',
  'stackoverflow.com': 'Stack Overflow',
  'github.com': 'GitHub',
  'youtube.com': 'YouTube',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'figma.com': 'Figma',
  'notion.so': 'Notion',
  'linear.app': 'Linear',
  'arxiv.org': 'arXiv',
  'medium.com': 'Medium',
  'reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn',
  'gitlab.com': 'GitLab',
  'npmjs.com': 'npm',
  'amazon.com': 'Amazon',
  'x.com': 'X',
  'twitter.com': 'X',
};

/** Fall back to the bare domain with its first letter capitalized. */
function prettifyDomain(domain) {
  if (!domain) return 'Other';
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

export function siteLabel(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Other';
  }
  if (NAMED_HOSTS[host]) return NAMED_HOSTS[host];
  const bare = host.replace(/^www\./, '');
  if (NAMED_HOSTS[bare]) return NAMED_HOSTS[bare];
  const reg = registrableDomain(host);
  if (NAMED_HOSTS[reg]) return NAMED_HOSTS[reg];
  return prettifyDomain(reg);
}

/**
 * Classify a tab into a task type.
 *
 * @param {{url: string, title?: string, content?: object}} tab
 * @returns {{type: string, ruleMinutes: number|null, source: string}}
 */
export function classify(tab) {
  const url = tab.url || '';
  const title = tab.title || '';

  for (const rule of DOMAIN_RULES) {
    if (rule.match.test(url)) {
      return { type: rule.type, ruleMinutes: rule.minutes, source: 'domain' };
    }
  }

  // Page content is a stronger signal than any guess from the URL alone.
  if (tab.content) {
    if (tab.content.videoSeconds > 0) return { type: 'watch', ruleMinutes: null, source: 'content' };
    if (tab.content.wordCount >= 400) return { type: 'read', ruleMinutes: null, source: 'content' };
    if (tab.content.formFields >= 3) return { type: 'act', ruleMinutes: 6, source: 'content' };
  }

  if (TITLE_ACT_HINTS.some((re) => re.test(title))) {
    return { type: 'act', ruleMinutes: 6, source: 'title' };
  }

  if (tab.content && tab.content.wordCount > 0) {
    return { type: 'read', ruleMinutes: null, source: 'content' };
  }

  return { type: 'unknown', ruleMinutes: 4, source: 'fallback' };
}
