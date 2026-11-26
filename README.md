# ListenToPR

ListenToPR is a Progressive Web App that turns GitHub pull requests into a spoken
review: paste (or share) a PR URL, and the app fetches the PR, generates a
structured audio transcript with an LLM, and reads it aloud with the browser's
speech synthesis — with sentence skipping, section navigation, speed and voice
control, and a screen wake lock so long reviews keep playing.

Everything runs client-side. GitHub tokens and LLM API keys never leave the
device unencrypted, and no plaintext secret is ever persisted.

## What it does

1. **Ingest** — fetch PR metadata, files, reviews and comments from the GitHub
   REST API (`src/github.ts`). Generated files (lockfiles, builds, dist output)
   are filtered out; image URLs and mermaid blocks are extracted from the PR
   body and comments; images are fetched as data URLs (best effort).
2. **Transcribe** — send the sanitized PR content to an OpenAI-compatible
   chat-completions endpoint (`src/llm.ts`, `src/transcript.ts`) and parse the
   structured JSON transcript (overview / architecture / changes /
   review-notes). Diff text is sanitized for speech: markdown, hunk markers,
   SHAs and symbol chains are collapsed into speakable prose.
3. **Speak** — play the transcript with `speechSynthesis`
   (`src/tts.ts`): play/pause/resume/stop, skip sentence or section, rate
   0.8x–2.0x, voice selection (persisted), clickable sentences with active
   highlight and auto-scroll (`src/app.ts`).
4. **Stay awake** — a Screen Wake Lock is held while playing and released when
   stopped, with a dismissible fallback banner where the API is unavailable
   (`src/wakelock.ts`).
5. **Work offline** — a service worker precaches the app shell
   (`public/sw.js`, `public/manifest.webmanifest`); the app is installable and
   accepts PR URLs via the Web Share Target API.

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
- **Zero plaintext persistence**: only `{ciphertext, iv, salt, method}` records
  are stored, in IndexedDB. Nothing readable at rest, no secret in logs.
- **CSP**: `index.html` ships a strict Content-Security-Policy
  (`default-src 'self'`, no inline scripts/styles, `frame-ancestors 'none'`).
  `connect-src` allows only `self`, the GitHub API hosts, and the configured
  LLM endpoint.
- Token sanitization: errors thrown from GitHub fetching have the token
  replaced with `[REDACTED]` (`src/github.ts`); LLM errors redact the API key
  (`src/llm.ts`). `referrer` is `no-referrer`.

## LLM endpoint configuration

The chat endpoint and model are set in the app's **Settings** panel (stored in
localStorage) at runtime, together with the API key (stored encrypted in the
vault). Additionally, the CSP `connect-src` allow-list can bake an endpoint in
at build time so production builds can talk to it:

```sh
VITE_LLM_ENDPOINT=https://api.example.com npm run build
```

`vite.config.ts` injects that value into the CSP meta tag (and removes the
placeholder when unset). The endpoint must be an OpenAI-compatible base URL;
`/chat/completions` is appended.

## Share target usage

Once installed as a PWA, the OS "share" sheet can send a PR link to ListenToPR
(the manifest declares a `GET` share target). The PR URL (or raw text
containing one) arrives as `?pr=` / `?text=` / `?url=` query parameters; the
app prefills the PR input and, once the vault is unlocked, loads and starts
playing automatically. Routing lives in `src/app.ts`.

## DVC sign-off matrix

| Criterion | Where implemented |
| --- | --- |
| GitHub PR fetch (metadata, files, reviews, comments) with pagination | `src/github.ts` (`fetchPullRequest`, 100/page, Link-header + page-walk, cap 300) |
| Generated-file filtering with dropped count | `src/github.ts` (`filterGeneratedFiles`) |
| Image URL extraction + data-URL fetch (token only to GitHub hosts) | `src/github.ts` (`extractImageUrls`, `fetchImageAsDataUrl`) |
| Mermaid block extraction | `src/github.ts` (`extractMermaidBlocks`) |
| PR URL parsing (case-insensitive host, /files, query, fragment) | `src/github.ts` (`parsePrUrl`, `findPrUrl`) |
| Token redaction in errors | `src/github.ts` (`sanitizeError`), `src/llm.ts` (key redaction) |
| OpenAI-compatible chat client, timeout, abort | `src/llm.ts` (`chat`, 120s default) |
| Speech-safe sanitization (markdown, hunks, SHAs, URLs, symbols) | `src/transcript.ts` (`sanitizeLine`) |
| Sentence splitting (abbreviations, decimals, 250-char chunking) | `src/transcript.ts` (`splitSentences`) |
| Structured transcript generation (strict JSON, section order, fallback) | `src/transcript.ts` (`buildTranscript`) |
| AES-GCM-256 vault, PBKDF2-SHA256 600k, per-record IV+salt | `src/vault.ts` |
| WebAuthn PRF unlock (HKDF-SHA256, credentialId, bootstrap) | `src/vault.ts` (`unlockWithPrf`, `isPrfSupported`) |
| Wrong PIN/PRF → lock error, no material leaked | `src/vault.ts` (`VaultLockedError`) |
| Auto-lock (default 15 min, 0 disables, reset on op) | `src/vault.ts` (idle timer, `lock()`, `dispose()`) |
| TTS controller: play/pause/resume/stop, skip sentence/section | `src/tts.ts` (`createTtsController`) |
| Rate + voice prefs persisted | `src/tts.ts` (`listentopr.tts.prefs`) |
| iOS-safe one-utterance-at-a-time chaining, stale-event drop | `src/tts.ts` |
| Wake lock acquire-on-play / release, visibility re-acquire, fallback | `src/wakelock.ts` |
| PWA manifest + icons | `public/manifest.webmanifest`, `public/icon.svg` |
| Service worker (precache, cache-first + revalidate, old-cache cleanup) | `public/sw.js` |
| Share target (manifest + query routing) | `public/manifest.webmanifest`, `src/app.ts` |
| App shell: PIN setup, locked view, settings, transcript UI, controls | `src/app.ts`, `src/styles.css`, `index.html` |
| CSP with build-time LLM endpoint injection | `index.html`, `vite.config.ts` |
| Tests (vault 22, github 24, transcript 29, tts 27, wakelock 11) | `src/*.test.ts` |
