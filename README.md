# Tab Triage

A Chrome extension that answers one question about your open tabs: **how long would it
actually take to clear these?**

It reads every tab in the profile, estimates the focused minutes each one needs before
you could honestly close it, groups them by site and by task type, and pushes a summary
every morning.

![The Tab Triage dashboard: a 5h 11m total above a stacked bar breaking that time down
by site, and a ledger listing every tab with its own estimate](docs/dashboard.png)

Built on Manifest V3 — the current extension platform for Chrome, where the background
script is a service worker that Chrome starts and stops on demand rather than a page
that stays resident. That shapes a lot of the design here: work has to survive the
worker being torn down mid-run, and permissions are requested at the moment they are
used rather than granted up front.

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
| Per-tab timeout | 8s | `executeScript` against a wedged renderer can hang indefinitely, and `innerText` on a huge page forces a full layout; it also has to cover the reader's settle window below |
| Concurrency | 6 | Injecting into every tab at once asks Chrome to wake the whole profile simultaneously |
| Overall deadline | 45s | A profile full of slow pages still produces a summary |

Two numbers on the dashboard mean different things, and conflating them made
healthy runs look broken:

- **Pages read** — the page's content was obtained. This is what page access buys.
- **Sized from page** — the estimate is *derived* from that content.

They differ legitimately. For an inbox, a pull request or a checkout, reading time is
the wrong model, so those pages are read in full and still priced by a per-site rule.
The rule acts as a floor rather than a replacement: a 20,000-word pull request is not
the same job as a two-line one, so an unusually long page raises the estimate above the
rule, but a short one never drops below it. Only **Pages read** appears in warnings —
a page read and priced by a rule is not a failure.

Tabs that are discarded or still loading are skipped rather than woken. Anything
skipped or timed out simply falls back to a rule-of-thumb estimate and is counted as
unmeasured in the report, and the report says which reason applied — sleeping tabs
usually dominate, because Chrome's memory saver discards background tabs and a
discarded tab has no live page to read. **Wake sleeping tabs** in Settings reloads them
so they can be measured, at the cost of bandwidth and slower runs.

**Page reading, tab by tab** on the dashboard lists what happened to each tab —
read, cached, timed out, nothing to measure, injection refused, asleep — with the word
count, media duration, content-node count and elapsed time behind each. Aggregate
counts say how many tabs failed; they never say which, and "which" is the only thing
that makes a reading failure actionable, because the cause is nearly always specific
to the site.

### Frozen tabs

Chrome freezes background tabs to save resources — most often tabs sitting in a
**collapsed tab group**. A frozen tab is not discarded and still reports
`status: "complete"`, but its renderer is suspended and executes no JavaScript.

`chrome.scripting.executeScript` against such a tab **neither resolves nor rejects.**
The call is queued against the suspended renderer and returns only if the tab is later
unfrozen. This is a known Chromium defect — [crbug 40901394][crbug] and
[w3c/webextensions#527][w3c] — not something an extension can work around from inside
the injected code.

[crbug]: https://issues.chromium.org/issues/40901394
[w3c]: https://github.com/w3c/webextensions/issues/527

The signature is unmistakable and worth recognising: **every affected tab consumes its
entire timeout budget to the millisecond, while healthy tabs answer in about one.**
That is silence, not slowness. No change to the reader — synchronous, timer-free,
cheaper — can help, because the reader never runs.

Two rules follow, and they are the whole fix:

1. **Never inject into a tab whose `frozen` is true.** The property is readable since
   Chrome 132, so the hang is entirely avoidable: check first. This is what turns ten
   eight-second hangs into ten instant, correctly-labelled skips.
2. **Reviving one means activating it.** The docs are explicit that a tab "is unfrozen
   on activation"; a reload is not documented to unfreeze, and a reload request is
   queued behind the same wall. Activation is visible to the user, so **Measure frozen
   tabs** is opt-in, processes those tabs one at a time, and restores whatever tab was
   in front when it finishes. Expanding the collapsed group by hand does the same thing
   without the flicker.

### The injected reader has no timers, on purpose

`load` is not "content is on screen": a single-page app completes its document with an
empty shell and renders the real text afterwards, and a `<video>` reports `NaN`
duration until its metadata loads. So a reading sometimes has to be retried.

That retry **cannot happen inside the page.** Chrome throttles timers in a tab hidden
for more than five minutes to roughly one callback per minute, and nearly every tab in
a summary is a background tab. A `setTimeout(200)` in the injected reader does not wait
200ms — it waits up to a minute, and the injection times out. The signature of this is
unmistakable and worth remembering: **every failing tab consumes its entire timeout
budget to the millisecond, while successful ones return in about 1ms.** That is a hang,
not slowness.

So the reader is strictly synchronous — one pass, no awaits, and `innerText` (which
forces a full layout) called exactly once. Retrying is the extension's job, where
timers run normally, and only for a tab we just reloaded, since a tab that rendered
long ago will not improve on a second look. Tests pin all three: that the reader
returns a value rather than a promise, that it reads `innerText` once, and that the
retry ladder lives extension-side. A page that really is empty gives up at the end of
that window rather than holding the run open.

Readings are cached for six hours so repeat runs stay fast, with two rules that keep
the cache from lying:

- **A failure to measure is never cached.** An empty reading is not a measurement, and
  storing one replays that failure for hours while the page is never retried.
- **The cache is versioned.** `SCRAPE_VERSION` is bumped whenever the reader changes
  what it can extract, and entries written by an older reader are discarded. Without
  this, fixing the reader appears to do nothing, because the fixed code never runs.

**Forget cached page data** in Settings clears it by hand.

Waking means an explicit `chrome.tabs.reload` followed by waiting for the load to
finish. `executeScript` does not wake a discarded tab — there is no renderer for the
injected function to run in, so the call just fails. That phase runs at lower
concurrency with a longer deadline, since each wake is a full page load.

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

## What the Claude engine costs

Measured against the real payload, page text adds roughly a third to the input:

| Tabs | Titles + URLs only | With page text |
|---|---|---|
| 23 | ~$0.036 | ~$0.046 (+30%) |
| 100 | ~$0.11 | ~$0.16 (+42%) |
| 400 | ~$0.41 | ~$0.59 (+46%) |

It does not explode, for two reasons: the page excerpt sent per tab is capped at 300
characters, and at small tab counts the output tokens dominate the bill anyway. The
transcript panel shows what each run actually cost and projects a month of daily
digests, so the number is measured rather than assumed.

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
