# Tab Triage

A Chrome (MV3) extension that answers one question about your open tabs: **how long
would it actually take to clear these?**

It reads every tab in the profile, estimates the focused minutes each one needs before
you could honestly close it, groups them by site and by task type, and pushes a summary
every morning.

## What it does

- **Estimates time-to-clear per tab.** Reading time from real word count, video length
  from the media element, a fixed cost for things like an open pull request. Tabs you
  have not touched in a month are discounted — you have already voted against them.
- **Groups by site and task type.** Task types: read, watch, act, shop, reference,
  social, admin. The dashboard also has a "stale & duplicates" view, which is the list
  of tabs you can close without thinking.
- **Morning digest.** A daily notification at a time you choose: *"84 tabs ≈ 11h 20m to
  clear — YouTube is the biggest at 3h 5m · 31 tabs untouched for a month."* Click it to
  open the dashboard.
- **On demand.** The toolbar popup summarizes the current tabs whenever you ask.

## Two estimators

| | Local heuristics (default) | Claude |
|---|---|---|
| Cost | Free | Your own Anthropic API key, billed to you |
| Network | Nothing leaves the browser | Tab titles, URLs, and a short page excerpt go to `api.anthropic.com` |
| Strength | Deterministic, explainable, works offline | Better calibration and task judgement on unfamiliar sites |

The engine is chosen in Settings. Claude runs on `claude-opus-5` with structured outputs
(`output_config.format`), batched 50 tabs per request. **Any Claude failure falls back to
the local estimator** with a visible notice — a bad key or a rate limit never costs you
the digest.

## Install for development

```bash
npm install
npm run build      # emits dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `dist/` folder.

```bash
npm run watch      # rebuild on change
npm test           # node:test, no browser needed
npm run icons      # regenerate icons/ from scripts/gen-icons.mjs
npm run zip        # build + package for the Chrome Web Store
```

## Seeing what was sent

Every summary produced by the Claude engine carries a full transcript, shown at the
bottom of the dashboard under **What was sent to Claude**:

- the exact system prompt, verbatim
- the JSON schema the response is constrained to
- every request body — the real tab list that left the browser, page excerpts included
- every raw response, before parsing
- tokens in and out, wall time, and the run's approximate cost in dollars

Nothing is paraphrased; the panel renders the same strings the API received and
returned, with a copy button on each. When the local engine produced the summary the
panel says so plainly, because in that case nothing was sent anywhere.

The transcript lives in `chrome.storage.local` alongside the report, capped so a
large run cannot fill storage — totals still count every request, and the panel says
how many exchanges were omitted.

**On the cost figure.** Token counts come from the API and are exact. The dollar
amount does not: it is computed from a rate table hardcoded in
`src/lib/estimator-claude.js`, stamped with the date the rates were last confirmed
and displayed alongside the figure. It will drift if Anthropic changes list prices,
and it knows nothing about discounts or batch rates on your account. There is no
pricing endpoint to read, so a table is the only option — but a model missing from
it shows token counts with no dollar figure rather than a wrong one. Your Anthropic
console remains the source of truth.

## Runs are interruptible

With page reading on, a summary has to wake and read every eligible tab, which on a
large profile is genuinely slow. Three limits keep that bounded, in `src/lib/collect.js`:

| Limit | Default | Why |
|---|---|---|
| Per-tab timeout | 3s | `executeScript` against a wedged renderer can hang indefinitely, and `innerText` on a huge page forces a full layout |
| Concurrency | 6 | Injecting into every tab at once asks Chrome to wake the whole profile simultaneously |
| Overall deadline | 45s | A profile full of slow pages still produces a summary |

Tabs that are discarded or still loading are skipped rather than woken. Anything
skipped or timed out simply falls back to a rule-of-thumb estimate and is counted as
unmeasured in the report.

The service worker is also kept alive for the duration of a run. MV3 tears down an
idle worker, and a long run is exactly when that hurts: the worker dies, the response
never arrives, and the caller sees *"the message channel closed before a response was
received"*. Touching an extension API on a timer resets that countdown while work is
live. If the worker restarts anyway, the UI waits for the run to finish and picks the
report up from storage rather than reporting a failure you cannot act on.

On top of that, every run is cancellable: the dashboard shows live progress
("Reading pages 34/210…") and a **Cancel** button while one is in flight, and only one
run may be active at a time. Cancelling keeps the previous summary rather than leaving
you with nothing.

## Why the two engines can disagree

Without page access, the local engine falls back to a flat per-site number: every
YouTube video scores 14 minutes whether it is a 3-minute clip or a 45-minute course.
Claude reads the title and estimates the real thing, so on a long video it can land
3-4x higher — and it is usually the more accurate of the two.

Turning on **Read page text** closes most of that gap, because the local engine then
reads the actual media duration and word count instead of guessing. The dashboard's
**Measured** stat shows how many tabs rest on a real measurement rather than a rule
of thumb; when that number is low, expect the engines to diverge.

## Permissions, and why each one

Requested up front:

- `tabs` — read the tab list (titles and URLs). The whole point.
- `storage` — settings, the last report, the page-content cache.
- `alarms` — schedule the morning digest.
- `notifications` — deliver it.
- `scripting` — inject the page reader on demand (only fires with the permission below).

Requested only when you turn the feature on, from the Settings page:

- `<all_urls>` — "Read page text for accurate estimates". Without it, estimates come from
  the URL and title alone. There is **no persistent content script**: the reader is
  injected only during a summary run, reads length and media duration, and never touches
  form values, storage, or cookies.

  **Unchecking the box gives the permission back.** It calls `chrome.permissions.remove()`,
  then re-checks with `chrome.permissions.contains()` and tells you if Chrome refused, rather
  than assuming success. Verify independently at `chrome://extensions` → Details → Site access.
  A permission that can only be granted is not a real choice.
- `https://api.anthropic.com/*` — requested when you pick the Claude engine.

## Where your API key lives

In `chrome.storage.local` on this machine. It is never synced to your Google account and
never sent anywhere but the Anthropic API. Extension storage is **not encrypted** — anything
with access to this Chrome profile can read it. Use a dedicated key from
console.anthropic.com, and revoke it if you uninstall.

## How the estimate is built

1. `collect.js` pulls the tab list, drops `chrome://` pages and (optionally) pinned tabs.
2. If page reading is on, `scrape.js` is injected per tab; results are cached for 6 hours.
3. `estimate.js` routes to `estimator-local.js` or `estimator-claude.js`.
4. `group.js` turns per-tab estimates into the report the UI renders.

Steps 1 and 2 touch Chrome APIs; steps 3 (local) and 4 are pure functions, which is why
they carry the tests.

## Layout

```
src/
  background.js          service worker: alarms, notifications, message router
  lib/
    taxonomy.js          domain rules, task types, site labels
    estimator-local.js   heuristic engine
    estimator-claude.js  Claude engine (structured outputs, chunked, falls back)
    estimate.js          engine router
    collect.js           chrome.tabs → normalized records
    scrape.js            the injected page reader + its cache policy
    group.js             report assembly
    format.js            duration and age formatting
    settings.js          persisted config, digest scheduling maths
  ui/                    popup, dashboard, options
public/                  manifest, HTML, CSS, icons
```

## Publishing notes

The Web Store listing needs to justify `<all_urls>`, so keep it optional and explain it in
the listing exactly as Settings does: page text is read on demand during a summary, only
for length signals. Declaring it optional rather than required is what keeps the review
straightforward. The build is unminified on purpose — reviewers read it.
