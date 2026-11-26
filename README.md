# ListenToPR

ListenToPR is a Progressive Web App that turns GitHub pull requests into a spoken
review: paste (or share) a PR URL, and the app fetches the PR, generates a
structured audio transcript with an LLM, and reads it aloud with the browser's
speech synthesis — with sentence skipping, section navigation, speed and voice
control, and a screen wake lock so long reviews keep playing.

Everything runs client-side. GitHub tokens and LLM API keys never leave the
device unencrypted, and no plaintext secret is ever persisted.

**No signup, no gate.** The first run drops you straight into the main view with
an ephemeral session vault: keys you save live only for the session
("Saved for this session"). When you want them back next launch, Settings has a
**Remember for next time** button (biometric via WebAuthn PRF when supported,
else a PIN). A **Try a sample** button plays a bundled demo transcript — no
network, no keys, instant TTS.

## What it does

1. **Ingest** — the input box routes through `parseGitTarget`
   (`src/github.ts`): PR URLs/shorthand take the classic PR path; blob/raw
   file URLs, commit URLs and compare URLs load as pseudo-PRs
   (`fetchFileContent` / `fetchCommit` / `fetchCompare`); anything multiline
   or long that is not a URL is offered to the paste parser
   (`src/paste.ts` `parsePastedContent` — a pasted PR description plus diff
   becomes listenable content, cached by a deterministic content hash);
   anything else is a clear error. GitHub works unauthenticated throughout —
   an empty token simply means public-data-only. Generated files (lockfiles,
   builds, dist output) are filtered out of every source; when a PR reports
   more changed files than survived filtering, the status line says so
   ("Showing N of M changed files (lockfiles/generated skipped)"). Image URLs
   and mermaid blocks are extracted from the PR body and comments; images are
   fetched as data URLs (best effort).
2. **Transcribe** — send the sanitized PR content to an LLM
   (`src/llm.ts`, `src/transcript.ts`) and speak the structured result.
   The transcript is generated as a **stream** (`createTranscriptStream`):
   one LLM call per section — overview, architecture (only when the PR has
   images or mermaid diagrams; images are attached to that call only), Key
   Changes batches (up to 10 small files per batch, oversized patches get a
   batch of their own), and review notes (only when feedback exists). Each
   call returns strict JSON `{title, sentences, summary, files}` and carries
   only short rolling summaries of earlier sections, so context stays flat no
   matter how large the PR is. Diff text is sanitized for speech: markdown,
   hunk markers, SHAs and symbol chains are collapsed into speakable prose.
   Sections narrate at the configured detail level (brief by default;
   Settings → "Detailed change narration" makes the model state per-file
   additions/removals). Every LLM call is wrapped in a retry engine
   (`src/retry.ts`): retryable HTTP statuses (timeouts, rate limits, 5xx)
   back off with exponential full jitter — the status shows "Retrying in
   Xs…" — and a final failure surfaces an actionable message ("LLM provider
   rejected the API key — re-check it in Settings", etc.) instead of a raw
   error.
3. **Speak** — play the transcript with `speechSynthesis`
   (`src/tts.ts`): play/pause/resume/stop, skip sentence or section, replay
   the current sentence, rate 0.8x–2.0x, voice selection (persisted),
   clickable sentences with active highlight and auto-scroll (`src/app.ts`).
   Playback starts as soon as the first section arrives (`tts.load` +
   `play`); later sections are appended on arrival (`tts.appendSections`)
   and chain seamlessly into speech. The app prefetches the next section
   when speech enters the last few sentences of the ready content, and if
   speech does reach the end first it shows a "Generating next section…"
   hold instead of flipping to the stopped state, then resumes
   automatically. Starting a new load or pressing Stop aborts the
   in-flight stream.
4. **Stay awake** — a Screen Wake Lock is held while playing and released when
   stopped, with a dismissible fallback banner where the API is unavailable
   (`src/wakelock.ts`).
5. **Work offline** — a service worker precaches the app shell
   (`public/sw.js`, `public/manifest.webmanifest`); the app is installable and
   accepts PR URLs via the Web Share Target API. The service worker also runs
   an **LLM proxy** (`src/llmproxy.ts`): once it controls the page, LLM calls
   to custom endpoints are rewritten as same-origin proxy requests the page
   CSP cannot block, so a custom endpoint works even when `connect-src`
   would have rejected it (the status notes it once:
   "routed via service worker").

## Development

```sh
npm install     # install dependencies
npm run dev     # start Vite dev server
npm test        # run vitest suite (node env, all browser APIs mocked)
npm run typecheck  # tsc --noEmit
npm run build   # production build into dist/
npm run preview # serve the production build
```

Node 20+ recommended.

## Security model

- **Vault** (`src/vault.ts`): secrets (GitHub token, LLM API key) are encrypted
  with **AES-GCM-256** via `crypto.subtle`. Each record gets a fresh 12-byte IV
  and 16-byte salt. The encryption key is derived either from a user PIN via
  **PBKDF2-SHA256 with 600,000 iterations**, or — method 2 — from a WebAuthn
  passkey using the **PRF extension** (`extensions.prf`), with the PRF output
  run through HKDF-SHA256. Derived keys are non-extractable and live only in
  memory; `lock()` drops them and an idle auto-lock (default 15 minutes,
  configurable, 0 disables) re-locks the vault.
- **Ephemeral-first**: the vault starts in `mode: 'ephemeral'` — an in-memory
  Map, no PIN gate, no IndexedDB touch. Secrets live only until the tab closes
  (or the session locks). **Remember for next time** migrates in place:
  `persistToPrf()` (one biometric prompt) or `persistToPin()` derives a key,
  re-encrypts every session secret into IndexedDB and flips the vault to
  persistent mode. Next launch, saved records are detected and the unlock
  screen shows (biometric button first when supported).
- **Zero plaintext persistence**: only `{ciphertext, iv, salt, method}` records
  are stored, in IndexedDB. Nothing readable at rest, no secret in logs.
- **CSP**: `index.html` ships a strict Content-Security-Policy
  (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`).
  `style-src` is `'self' 'unsafe-inline'`: mermaid embeds an inline
  `<style>` element inside every rendered diagram SVG, so inline styles must
  be allowed for diagrams to display. This exception is styles only —
  `script-src` stays `'self'` with no inline-script allowance.
  `connect-src` allows only `self`, the GitHub API hosts, and the configured
  LLM endpoint — but a custom endpoint the CSP would block still works once
  the service-worker proxy controls the page (see `src/llmproxy.ts` and
  `endpointUsable` in `src/csp.ts`); only when neither path can reach it does
  Settings refuse to save it.
- Token sanitization: errors thrown from GitHub fetching have the token
  replaced with `[REDACTED]` (`src/github.ts`); LLM errors redact the API key
  (`src/llm.ts`). `referrer` is `no-referrer`.

## LLM configuration

The provider, endpoint, model, and optional vision model are set in the app's
**Settings** panel (stored in localStorage) at runtime, together with the API
key (stored encrypted in the vault). Provider defaults:

| Setting | Values / default | Notes |
| --- | --- | --- |
| Provider | `openai` (default), `anthropic`, `gemini`, `github` | API dialect used by `src/llm.ts` |
| Endpoint | empty = provider default | OpenAI `https://api.openai.com/v1` (`/chat/completions`), Anthropic `https://api.anthropic.com` (`/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`), Gemini `https://generativelanguage.googleapis.com` (`/v1beta/models/{model}:generateContent?key=`), GitHub Models `https://models.github.ai` (`/inference/chat/completions`) |
| Model | any model id the provider accepts | used for text-only calls |
| Vision model | optional | used only for image-bearing calls (the architecture section); falls back to Model |

**GitHub Models** (`provider: github`) speaks the OpenAI dialect against
`https://models.github.ai` (`/inference/chat/completions`) and authenticates
with your GitHub personal access token as a Bearer — no separate API key
needed: when no `llm-api-key` is stored, the vault's GitHub token doubles as
the model key (an explicit `llm-api-key` still wins). Model ids are
namespaced like `openai/gpt-4o` (Settings hints this in the model field's
placeholder). Vision works through the Vision model field (`visionModel`),
same as other providers.

With GitHub Models selected, Settings turns the model and vision-model
fields into live pickers: opening Settings loads the model catalog from
`https://models.github.ai/catalog/models` (same token as the Bearer) and
groups it by publisher — each option shows `name (id)` with the catalog
summary on hover, and the vision picker lists only vision-capable models.
The list is cached in localStorage for 24 hours, so repeat opens are
instant and work offline; **Refresh models** forces a re-fetch. A
**Custom…** option switches back to the free-text input for arbitrary model
ids (remembered for the session only), and if the catalog cannot be loaded
(no token yet, a 401, or offline) the fields fall back to plain text inputs
with the reason shown. Picking a model with a known input limit auto-fills
the Advanced context-window field when it is empty. Fine-grained PATs need
the `models: read` permission for the catalog to load.

Additionally, the CSP `connect-src` allow-list can bake an endpoint in at
build time so production builds can talk to it:

```sh
VITE_LLM_ENDPOINT=https://api.example.com npm run build
```

`vite.config.ts` injects that value into the CSP meta tag (and removes the
placeholder when unset). A custom endpoint must match the selected provider's
API dialect.

## Context budget

The **Settings → Advanced** area controls how much of the model's context
window each transcript-generation call may use. The three settings are
persisted in localStorage (`listentopr.llm-context`); invalid or corrupt
values are ignored, and leaving all three unset keeps the classic fixed
batching (10 files per call):

| Setting | Default | What it does |
| --- | --- | --- |
| Context window (tokens) | `128000` | The model's context window. Batches are sized from it: fat windows get fat batches, small windows shrink them. |
| Max per call (tokens) | `200000` | Hard cap on input tokens per LLM call (effectively the smaller of this and the context window). |
| Single-shot when it fits | off | When the whole PR (description, comments, reviews, every patch) fits the window, generate the entire transcript in one call instead of section-by-section batches. The status line notes "Generating in a single pass." when it fires. |
| Detailed change narration | off (`brief`) | Brief narrates changes by intent and logic flow. Detailed makes the model state per-file removals and additions as separate sentences, using the per-file +N/-M counts. Persisted as `listentopr.detail`. |

**Why 200k per call instead of the full window?** Prompts that fill the
entire window are slower to start generating — the first section, and with it
the first audio, arrives later — and models recall content buried in the
middle of a huge prompt less reliably than content in tighter, rolling
summaries. Capping each call keeps time-to-first-audio low and per-section
quality high; the section pipeline (rolling summaries, prefetch) keeps the
listening experience continuous regardless.

**Overflow protection.** Every budgeted call is pre-checked against the
per-call cap: oversized batches are binary-split into smaller ones, a single
file whose patch cannot fit is truncated with a `(truncated)` marker (the
prompt tells the model to cover only the visible part), and a final clamp
hard-caps every user prompt — no request ever exceeds the per-call budget.
Single-shot that does not fit silently falls back to sectioned batches.

## Share target usage

Once installed as a PWA, the OS "share" sheet can send a PR link to ListenToPR
(the manifest declares a `GET` share target). The PR URL (or raw text
containing one) arrives as `?pr=` / `?text=` / `?url=` query parameters; the
app prefills the PR input and, once the vault is unlocked, loads and starts
playing automatically. Routing lives in `src/app.ts`.

## Convenience features

- **Input routing** — the Listen box accepts full PR URLs, scheme-less
  `github.com/owner/repo/pull/123`, and `owner/repo#123` (the classic PR
  path); blob/raw/commit/compare URLs (pseudo-PR loads); and pasted PR text
  (description plus diff — no GitHub access needed at all). Multiline or long
  non-URL input goes to the paste parser; short garbage shows a clear error
  instead of failing silently.
- **Demo mode** — **Try a sample** (next to the Listen box) loads a bundled
  four-section demo transcript with a mermaid diagram, no network and no
  keys, and starts speaking instantly. The status line reads
  "Demo transcript".
- **Bookmarklet** — the **Click to listen** chip in the main view (see
  [Bookmarklet](#bookmarklet)).
- **LLM retries** — retryable failures (timeout, rate limit, 5xx, network)
  back off with exponential full jitter ("Retrying in Xs…"); final failures
  show an actionable message (bad key, unknown model, provider error).
  A recovered connection says "Connection recovered — continuing."
- **Replay sentence** — a ↻ control restarts the current sentence while
  playing (or paused).
- **Voice preview** — Settings → Voice preview lists every system voice with
  a Play button that speaks "This is how I sound." at the current rate and
  pitch.
- **Background warning** — hiding the tab while playing shows a banner:
  "Playback pauses when this tab is hidden — keep it open" (browsers suspend
  speech synthesis in background tabs; the banner clears on return).
- **Big-PR honesty** — when a PR's raw changed-file count exceeds the kept
  count, the status says "Showing N of M changed files (lockfiles/generated
  skipped)".
- **File chips** — each transcript section shows the files it narrates as
  chips: real PRs link to the PR's Files tab, file-target loads link to the
  GitHub blob, pasted content shows plain (non-link) chips.
- **Transcript cache** — fully generated transcripts are stored locally in
  IndexedDB (non-secret data; keys stay in the encrypted vault) keyed by PR
  head SHA — or by the content hash for pasted text. Re-listening to
  unchanged content loads instantly ("Loaded from cache") with no LLM call.
- **What's New delta** — when the PR head has moved since your last cached
  listen, the app fetches the commits pushed since your last listen, builds a
  short "What's New" section from them (single LLM call, previous summary as
  context), and plays it before the cached transcript.
- **Resume** — the listening position is saved while playing (throttled to one
  write per 2 s) and restored on the next load of the same PR
  ("Resumed at section N, sentence M"). Finishing a PR clears it.
- **Queue** — "Add to queue" parks the PR in the input box for later (FIFO,
  with a removable queue list). When a transcript finishes naturally, the next
  queued PR loads and plays automatically ("Up next: …").
- **Scrubber** — a position bar over the sentence queue with estimated time
  ("m:ss of m:ss", words / 150 wpm). Click or drag to seek; keyboard arrows on
  the bar seek too.
- **Section TOC** — a clickable list of section titles: a sticky side pane on
  wide screens, a collapsible dropdown on narrow ones. Clicking jumps to the
  section's first sentence; clicking any sentence in the transcript seeks
  there as well.
- **Sleep timer** — off/10/20/30/60-minute presets. On expiry playback pauses
  and the status says so; the remaining time is shown next to the control.
- **Media session** — OS media keys / lock-screen controls (play, pause,
  next/previous track, seek) and metadata (PR title, "ListenToPR") on devices
  with `navigator.mediaSession`.
- **Keyboard shortcuts** — Space toggle play/pause, ArrowLeft/Right skip
  sentence, ArrowUp/Down (or j/k) skip section, s stop. Ignored while typing
  in a form field.
- **Pitch** — a 0.5–2.0 pitch select next to the voice selector, persisted
  with the other TTS prefs.
- **Export/share** — "Copy transcript" (async clipboard with an
  execCommand fallback), "Download .txt" (Blob download named after the PR),
  and "Share" via the Web Share API where available.
- **Theme** — a tri-state header button (**Auto → Light → Dark**) backed by
  `src/theme.ts`: Auto follows the OS `prefers-color-scheme`, explicit modes
  persist in `listentopr.theme` (localStorage). The resolved theme is written
  to `<html data-theme>` and the `<meta name="theme-color">` browser-chrome
  color; all colors live in `styles.css` tokens. Switching also re-renders
  open diagrams in the matching mermaid theme. `prefers-reduced-motion`
  disables all transitions/animations. See [Theme](#theme).
- **Diagrams** — mermaid blocks found in the PR body/comments render as
  diagram cards in a collapsible **Diagrams** section of the transcript.
  See [Diagrams](#diagrams).

### iOS Shortcut recipe

You can send a PR straight from the GitHub app or Safari into ListenToPR with
a Shortcut:

1. Open the **Shortcuts** app and create a new shortcut.
2. Add the **"Receive input from Share Sheet"** action; set the input type to
   **URL**.
3. Add the **"Open URLs"** action with
   `https://github.tig.pw/listentopr/?pr=[Shortcut Input]`.
4. Name the shortcut (e.g. "Listen to PR").

The same `?pr=<url>` query parameter works from any app that can open a URL,
not just iOS — the app parses and auto-loads it on launch. Note that
share-sheet delivery of the URL requires the PWA to be installed to the home
screen.

## Bookmarklet

The main view ships a **Click to listen** chip. Drag it to your browser's
bookmarks bar; then, on any GitHub pull request page, clicking the bookmark
hops straight into ListenToPR with that PR loaded and playing. (Clicking the
chip on the page itself may be blocked by the strict CSP — the drag-to-
bookmarks-bar use is the point; bookmarklets run outside page CSP.)

To create it manually, use this URL as a new bookmark:

```text
javascript:location.href='https://github.tig.pw/listentopr/?pr='+encodeURIComponent(location.href)
```

## On-ramp: no account, no keys, no GitHub access

The fastest path from zero to listening:

1. Open the app — no vault setup, no PIN. The main view is right there.
2. Press **Try a sample** — a bundled demo transcript (with a mermaid
   diagram) starts speaking immediately. No network, no keys.
3. Have a PR link? Paste it in the box. Unauthenticated GitHub works for
   public PRs, files, commits and compares — add a token in Settings only
   for private repos or rate limits.
4. No link? Paste the PR text itself (description plus diff). It parses,
   narrates and caches like a real PR.
5. Only when you want keys remembered across launches does the vault enter
   the picture: **Remember for next time** (biometric or PIN).

## Diagrams

When a PR contains mermaid code blocks (`src/github.ts`
`extractMermaidBlocks`), the transcript view gets a collapsible
**Diagrams** section (`src/diagrams.ts`, rendered with mermaid 12,
`securityLevel: 'strict'`, lazy-loaded on first render so PRs without
diagrams never download the bundle):

- Each block renders as a card with the SVG sized to the transcript width.
- A block that fails to parse shows its raw mermaid source in a `<pre>` with
  a "Diagram could not be rendered" label; sibling cards still render.
- While the spoken section describes the diagrams (the transcript's
  architecture section, tracked via `tts.onChange`), the cards get a
  highlight ring.
- Switching the app theme re-renders the open cards in the matching mermaid
  theme (dark/light). Rendered handles are cached per load and discarded on
  a new load.

## Theme

`src/theme.ts` (`createThemeController`) owns the tri-state theme:

| Mode | Behavior |
| --- | --- |
| Auto (default for new/unset/corrupt storage) | follows `prefers-color-scheme`, live-updates on OS change |
| Light / Dark | explicit, persisted in `listentopr.theme` |

The resolved theme is applied as `<html data-theme="light|dark">` (dark
tokens are the `:root` default) and mirrored into
`<meta name="theme-color">` (`#0e1116` dark / `#f6f7f9` light). Legacy
`listentopr.theme` values from the old light/dark toggle map onto the new
modes (`light` → Light, anything unknown → Auto).

## DVC sign-off matrix

| Criterion | Where implemented |
| --- | --- |
| GitHub PR fetch (metadata, files, reviews, comments) with pagination | `src/github.ts` (`fetchPullRequest`, 100/page, Link-header + page-walk, cap 300) |
| Generated-file filtering with dropped count | `src/github.ts` (`filterGeneratedFiles`) |
| Image URL extraction + data-URL fetch (token only to GitHub hosts) | `src/github.ts` (`extractImageUrls`, `fetchImageAsDataUrl`) |
| Mermaid block extraction | `src/github.ts` (`extractMermaidBlocks`) |
| PR URL parsing (case-insensitive host, /files, query, fragment) | `src/github.ts` (`parsePrUrl`, `findPrUrl`) |
| Extended targets: blob/raw file, commit, compare URLs | `src/github.ts` (`parseGitTarget`, `fetchFileContent`, `fetchCommit`, `fetchCompare`) |
| Pasted PR text ingestion (diff blocks, content-hash cache key) | `src/paste.ts` (`parsePastedContent`, `contentHash`) |
| Input routing (url vs paste vs garbage) | `src/app.ts` (`routeInput`) |
| LLM retry (exponential full jitter, retryable statuses, actionable errors) | `src/retry.ts` (`withRetry`, `retryableHttpError`, `actionableLlmError`) |
| Service-worker LLM proxy for CSP-blocked custom endpoints | `src/llmproxy.ts` (`llmProxyFetch`, `isProxyActive`), `src/csp.ts` (`endpointUsable`), `public/sw.js` |
| Ephemeral vault mode + persist-to-PIN/PRF migration | `src/vault.ts` (`mode`, `persistToPin`, `persistToPrf`, `hasSecrets`) |
| Token redaction in errors | `src/github.ts` (`sanitizeError`), `src/llm.ts` (key redaction) |
| Multi-provider chat client (OpenAI/Anthropic/Gemini/GitHub Models), timeout, abort, key redaction | `src/llm.ts` (`chat`, `PROVIDER_DEFAULT_ENDPOINTS`, 120s default) |
| Speech-safe sanitization (markdown, hunks, SHAs, URLs, symbols) | `src/transcript.ts` (`sanitizeLine`) |
| Sentence splitting (abbreviations, decimals, 250-char chunking) | `src/transcript.ts` (`splitSentences`) |
| Streaming transcript (per-section LLM calls, rolling summaries, abort, fallbacks) | `src/transcript.ts` (`createTranscriptStream`) |
| Vision model routing (image-bearing calls) | `src/llm.ts` (`LlmConfig.visionModel`) |
| AES-GCM-256 vault, PBKDF2-SHA256 600k, per-record IV+salt | `src/vault.ts` |
| WebAuthn PRF unlock (HKDF-SHA256, credentialId, bootstrap) | `src/vault.ts` (`unlockWithPrf`, `isPrfSupported`) |
| Wrong PIN/PRF → lock error, no material leaked | `src/vault.ts` (`VaultLockedError`) |
| Auto-lock (default 15 min, 0 disables, reset on op) | `src/vault.ts` (idle timer, `lock()`, `dispose()`) |
| TTS controller: play/pause/resume/stop, skip sentence/section | `src/tts.ts` (`createTtsController`) |
| Streaming append (seamless chaining, dynamic skip into appended content) | `src/tts.ts` (`appendSections`) |
| Streamed playback wiring (first-section start, prefetch, hold state, abort on stop/new load) | `src/app.ts` |
| Rate + voice prefs persisted | `src/tts.ts` (`listentopr.tts.prefs`) |
| iOS-safe one-utterance-at-a-time chaining, stale-event drop | `src/tts.ts` |
| Wake lock acquire-on-play / release, visibility re-acquire, fallback | `src/wakelock.ts` |
| PWA manifest + icons | `public/manifest.webmanifest`, `public/icon.svg` |
| Service worker (precache, cache-first + revalidate, old-cache cleanup) | `public/sw.js` |
| Share target (manifest + query routing) | `public/manifest.webmanifest`, `src/app.ts` |
| App shell: first-run no-gate, locked view, settings, transcript UI, controls | `src/app.ts`, `src/styles.css`, `index.html` |
| Demo transcript, bookmarklet chip, replay, voice preview, file chips, detail toggle, background warning | `src/app.ts`, `src/styles.css` |
| CSP with build-time LLM endpoint injection | `index.html`, `vite.config.ts` |
| Tests (544 across 19 files) | `src/*.test.ts` |
