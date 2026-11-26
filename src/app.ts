// ListenToPR app shell. Plain DOM, CSP-safe: no inline scripts, no inline
// style attributes; all styling comes from styles.css classes.
// contract says class KeyVault; sibling currently exports it as Vault
import { Vault as KeyVault, VaultError, isPrfSupported } from './vault'
import {
  parsePrUrl,
  findPrUrl,
  fetchPullRequest,
  fetchImageAsDataUrl,
} from './github'
import { buildTranscript } from './transcript'
import { createTtsController, listVoices } from './tts'
import { createWakeLockController, shouldShowWakeLockFallback } from './wakelock'
import { createUpdateController, type UpdateController } from './update'
import { connectSrcValue, endpointAllowedByConnectSrc } from './csp'
import type {
  LlmConfig,
  PullRequestRef,
  SecretId,
  Transcript,
  TtsState,
} from './types'

// ---------- small DOM helpers ----------

function el<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function labeledInput(
  labelText: string,
  type: 'text' | 'password',
  value = '',
): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = el('div', 'field')
  const label = el('label', 'field-label', labelText)
  const input = el('input', 'field-input')
  input.type = type
  input.autocomplete = 'off'
  input.value = value
  label.appendChild(input)
  wrap.appendChild(label)
  return { wrap, input }
}

// ---------- localStorage helpers (private mode safe) ----------

const KEYS = {
  vaultReady: 'listentopr.vault-ready',
  endpoint: 'listentopr.llm-endpoint',
  model: 'listentopr.llm-model',
  prefs: 'listentopr.tts-prefs',
  wlDismissed: 'listentopr.wl-banner-dismissed',
} as const

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // storage unavailable (private mode) — non-secret prefs just don't persist
  }
}

function lsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// ---------- app state ----------

let root: HTMLElement | null = null
let vault: KeyVault
let tts: ReturnType<typeof createTtsController>
let wakeLock: ReturnType<typeof createWakeLockController>

let statusEl: HTMLElement | null = null
const offlineBanner = el('div', 'banner banner-offline', 'Offline — check connection')
offlineBanner.hidden = true

const updateBanner = el('div', 'banner banner-warn', 'New version available')
updateBanner.hidden = true
{
  const reloadBtn = el('button', 'btn btn-small', 'Reload')
  reloadBtn.type = 'button'
  reloadBtn.addEventListener('click', () => {
    if (updateCtrl) updateCtrl.reload()
  })
  const dismissBtn = el('button', 'btn btn-small', 'Dismiss')
  dismissBtn.type = 'button'
  dismissBtn.addEventListener('click', () => {
    updateBanner.hidden = true
  })
  updateBanner.appendChild(reloadBtn)
  updateBanner.appendChild(dismissBtn)
}
let updateCtrl: UpdateController | null = null

// main-view element refs (reassigned on each render)
let listenBtn: HTMLButtonElement | null = null
let loadingEl: HTMLElement | null = null
let transcriptEl: HTMLElement | null = null
let controlsEl: HTMLElement | null = null
let playBtn: HTMLButtonElement | null = null
let pauseBtn: HTMLButtonElement | null = null
let stopBtn: HTMLButtonElement | null = null
let voiceSelect: HTMLSelectElement | null = null
let pendingAutoStartUrl: string | null = null

const RATE_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]

// ---------- status / errors ----------

function setStatus(message: string, kind: 'error' | 'info' = 'error'): void {
  if (!statusEl) return
  statusEl.textContent = message
  statusEl.className = `banner banner-${kind}`
  statusEl.hidden = false
}

function clearStatus(): void {
  if (!statusEl) return
  statusEl.textContent = ''
  statusEl.hidden = true
}

/** Never log or display raw secret values; messages from our own modules only. */
function sanitizeError(err: unknown): string {
  let msg: string
  if (err instanceof Error) msg = err.message
  else if (typeof err === 'string') msg = err
  else msg = 'Something went wrong'
  msg = msg.replace(/\s+/g, ' ').trim()
  if (msg.length > 200) msg = msg.slice(0, 200) + '…'
  return msg || 'Something went wrong'
}

function showOfflineBanner(): void {
  offlineBanner.hidden = false
}

// ---------- CSP endpoint validation ----------
// connect-src is baked at build time, so a Settings endpoint whose origin is
// not already allowed would be CSP-blocked at fetch time and surface as a
// misleading "offline" TypeError. Validate up front instead.

function llmEndpointAllowed(endpoint: string): boolean {
  if (endpoint.trim() === '') return true
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  )
  const csp = meta?.getAttribute('content') ?? ''
  const src = connectSrcValue(csp)
  if (src === null || src === '') return true // no connect-src -> nothing blocked
  return endpointAllowedByConnectSrc(endpoint, src, window.location.origin)
}

const CSP_ENDPOINT_MSG =
  'LLM endpoint is not allowed by this build\'s Content-Security-Policy. ' +
  'Rebuild with VITE_LLM_ENDPOINT set to that origin, or use an allowed endpoint.'

// ---------- vault adapters ----------
// The integration contract (boolean unlocks, sync getSecret, isPrfSupported
// method) and the current vault.ts signatures (void unlocks that throw,
// async getSecret, module-level isPrfSupported) differ slightly. These
// adapters accept either shape so both work.

async function vaultUnlockPin(
  pin: string,
): Promise<{ ok: boolean; err?: string }> {
  try {
    const r = await (vault.unlockWithPin(pin) as unknown as boolean | void)
    return { ok: r !== false }
  } catch (err) {
    return { ok: false, err: sanitizeError(err) }
  }
}

async function vaultUnlockPrf(): Promise<{ ok: boolean; err?: string }> {
  try {
    const r = await (vault.unlockWithPrf() as unknown as boolean | void)
    return { ok: r !== false }
  } catch (err) {
    return { ok: false, err: sanitizeError(err) }
  }
}

function vaultPrfSupported(): boolean {
  const v = vault as unknown as { isPrfSupported?: () => boolean }
  if (typeof v.isPrfSupported === 'function') return v.isPrfSupported()
  return isPrfSupported()
}

async function vaultGetSecret(id: SecretId): Promise<string | null> {
  try {
    const raw = (
      vault as unknown as {
        getSecret: (i: SecretId) => string | null | Promise<string | null>
      }
    ).getSecret(id)
    const val = raw instanceof Promise ? await raw : raw
    return val ?? null
  } catch {
    return null
  }
}

function hideOfflineBanner(): void {
  if (window.navigator.onLine) offlineBanner.hidden = true
}

// ---------- view scaffolding ----------

function resetRoot(): void {
  if (!root) return
  root.textContent = ''
  root.appendChild(offlineBanner)
  root.appendChild(updateBanner)
  statusEl = null
}

function makeStatusEl(): HTMLElement {
  const s = el('div', 'banner banner-error')
  s.hidden = true
  statusEl = s
  return s
}

// ---------- setup view (first run) ----------

function showSetup(): void {
  resetRoot()
  if (!root) return
  const card = el('div', 'card')
  card.appendChild(el('h1', 'app-title', 'ListenToPR'))
  card.appendChild(
    el('p', 'muted', 'Create a PIN to encrypt your keys on this device.'),
  )

  const pin = labeledInput('PIN (at least 4 characters)', 'password')
  const confirmPin = labeledInput('Confirm PIN', 'password')
  const btn = el('button', 'btn btn-primary', 'Create vault')
  btn.type = 'button'

  async function submit(): Promise<void> {
    const p = pin.input.value
    const c = confirmPin.input.value
    if (p.length < 4) {
      setStatus('PIN must be at least 4 characters.')
      return
    }
    if (p !== c) {
      setStatus('PINs do not match.')
      return
    }
    btn.disabled = true
    try {
      await vault.setupWithPin(p)
      lsSet(KEYS.vaultReady, '1')
      pin.input.value = ''
      confirmPin.input.value = ''
      showMain()
    } catch (err) {
      // IndexedDB outlives the vault-ready flag; if records already exist,
      // route to the unlock screen instead of bricking the vault.
      if (err instanceof VaultError && err.code === 'VAULT_ALREADY_SET_UP') {
        lsSet(KEYS.vaultReady, '1')
        showLocked()
        return
      }
      setStatus(sanitizeError(err))
      btn.disabled = false
    }
  }

  btn.addEventListener('click', () => {
    void submit()
  })
  pin.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  confirmPin.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })

  card.appendChild(pin.wrap)
  card.appendChild(confirmPin.wrap)
  card.appendChild(btn)
  card.appendChild(makeStatusEl())
  root.appendChild(card)
}

// ---------- locked view ----------

function showLocked(): void {
  resetRoot()
  if (!root) return
  // stop playback and drop transcript on lock
  try {
    tts.stop()
  } catch {
    // ignore
  }
  const card = el('div', 'card')
  card.appendChild(el('h1', 'app-title', 'ListenToPR'))
  card.appendChild(el('p', 'muted', 'Vault locked. Enter your PIN to continue.'))

  const pin = labeledInput('PIN', 'password')
  const btn = el('button', 'btn btn-primary', 'Unlock')
  btn.type = 'button'

  async function submit(): Promise<void> {
    btn.disabled = true
    const { ok, err } = await vaultUnlockPin(pin.input.value)
    pin.input.value = ''
    if (ok) {
      showMain()
    } else {
      setStatus(err ?? 'Wrong PIN.')
      btn.disabled = false
    }
  }

  btn.addEventListener('click', () => {
    void submit()
  })
  pin.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  card.appendChild(pin.wrap)
  card.appendChild(btn)

  if (vaultPrfSupported()) {
    const bio = el('button', 'btn btn-secondary', 'Unlock with biometrics')
    bio.type = 'button'
    bio.addEventListener('click', () => {
      void (async () => {
        bio.disabled = true
        const { ok, err } = await vaultUnlockPrf()
        if (ok) {
          showMain()
        } else {
          setStatus(err ?? 'Biometric unlock failed. Use your PIN.')
          bio.disabled = false
        }
      })()
    })
    card.appendChild(bio)
  }

  card.appendChild(makeStatusEl())
  root.appendChild(card)
}

// ---------- settings panel ----------

function buildSettingsPanel(): HTMLDivElement {
  const panel = el('div', 'settings-panel')
  panel.hidden = true
  panel.appendChild(el('h2', 'panel-title', 'Settings'))

  const pat = labeledInput('GitHub personal access token', 'password')
  const endpoint = labeledInput(
    'LLM endpoint',
    'text',
    lsGet(KEYS.endpoint) ?? '',
  )
  const model = labeledInput('LLM model', 'text', lsGet(KEYS.model) ?? '')
  const apiKey = labeledInput('LLM API key', 'password')

  const save = el('button', 'btn btn-primary', 'Save settings')
  save.type = 'button'
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true
      try {
        const epVal = endpoint.input.value.trim()
        if (epVal !== '' && !llmEndpointAllowed(epVal)) {
          setStatus(CSP_ENDPOINT_MSG)
          return
        }
        const patVal = pat.input.value.trim()
        if (patVal) {
          await vault.putSecret('github-token', patVal)
          pat.input.value = ''
        }
        const keyVal = apiKey.input.value.trim()
        if (keyVal) {
          await vault.putSecret('llm-api-key', keyVal)
          apiKey.input.value = ''
        }
        lsSet(KEYS.endpoint, endpoint.input.value.trim())
        lsSet(KEYS.model, model.input.value.trim())
        setStatus('Settings saved.', 'info')
      } catch (err) {
        setStatus(sanitizeError(err))
      } finally {
        save.disabled = false
      }
    })()
  })

  const wipe = el('button', 'btn btn-danger', 'Wipe All Keys')
  wipe.type = 'button'
  wipe.addEventListener('click', () => {
    if (!window.confirm('Wipe all stored keys? This cannot be undone.')) return
    void (async () => {
      wipe.disabled = true
      try {
        await vault.wipeAll()
      } catch (err) {
        setStatus(sanitizeError(err))
        wipe.disabled = false
        return
      }
      lsRemove(KEYS.vaultReady)
      lsRemove(KEYS.endpoint)
      lsRemove(KEYS.model)
      lsRemove(KEYS.prefs)
      showSetup()
    })()
  })

  panel.appendChild(pat.wrap)
  panel.appendChild(endpoint.wrap)
  panel.appendChild(model.wrap)
  panel.appendChild(apiKey.wrap)
  panel.appendChild(save)

  const autoLock = el(
    'p',
    'muted autolock-indicator',
    'Vault unlocked — it locks automatically after idle.',
  )
  panel.appendChild(autoLock)
  panel.appendChild(wipe)
  return panel
}

// ---------- transcript + controls ----------

function setActiveSentence(si: number, i: number): void {
  if (!transcriptEl) return
  const prev = transcriptEl.querySelector('.sentence.active')
  if (prev) prev.classList.remove('active')
  const span = transcriptEl.querySelector(
    `.sentence[data-si="${Number(si)}"][data-i="${Number(i)}"]`,
  )
  if (span) {
    span.classList.add('active')
    span.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

function clearActiveSentence(): void {
  if (!transcriptEl) return
  const prev = transcriptEl.querySelector('.sentence.active')
  if (prev) prev.classList.remove('active')
}

function updateControlStates(state: TtsState): void {
  if (playBtn) {
    playBtn.textContent = state.paused ? 'Resume' : 'Play'
    playBtn.disabled = state.playing && !state.paused
  }
  if (pauseBtn) pauseBtn.disabled = !(state.playing && !state.paused)
  if (stopBtn) stopBtn.disabled = !(state.playing || state.paused)
}

function onTtsChange(state: TtsState): void {
  if (state.playing || state.paused) {
    setActiveSentence(state.sectionIndex, state.sentenceIndex)
  } else {
    clearActiveSentence()
  }
  updateControlStates(state)
  if (state.playing && !state.paused) {
    void wakeLock
      .acquire()
      .then(() => undefined)
      .catch(() => undefined)
  } else {
    wakeLock.release()
  }
}

function renderTranscriptView(t: Transcript): void {
  if (!transcriptEl) return
  const container = transcriptEl
  container.textContent = ''
  container.appendChild(el('h2', 'transcript-title', t.title))
  t.sections.forEach((section, si) => {
    const sec = el('section', 't-section')
    sec.appendChild(el('h3', 't-section-title', section.title))
    const wrap = el('p', 't-sentences')
    section.sentences.forEach((sentence, i) => {
      const span = el('span', 'sentence', sentence)
      span.dataset.si = String(si)
      span.dataset.i = String(i)
      // controller has no seek API; click gives visual focus + scroll
      span.addEventListener('click', () => {
        setActiveSentence(si, i)
      })
      wrap.appendChild(span)
      wrap.appendChild(document.createTextNode(' '))
    })
    sec.appendChild(wrap)
    container.appendChild(sec)
  })
  container.hidden = false
}

function readPrefs(): { voiceName: string | null; rate: number } {
  try {
    const raw = lsGet(KEYS.prefs)
    if (raw) {
      const parsed = JSON.parse(raw) as { voiceName?: unknown; rate?: unknown }
      return {
        voiceName: typeof parsed.voiceName === 'string' ? parsed.voiceName : null,
        rate:
          typeof parsed.rate === 'number' && parsed.rate >= 0.5 && parsed.rate <= 2.5
            ? parsed.rate
            : 1.0,
      }
    }
  } catch {
    // corrupt prefs — fall through to defaults
  }
  return { voiceName: null, rate: 1.0 }
}

function writePrefs(voiceName: string | null, rate: number): void {
  lsSet(KEYS.prefs, JSON.stringify({ voiceName, rate }))
}

function applyPrefs(): void {
  const prefs = readPrefs()
  try {
    tts.setRate(prefs.rate)
    if (prefs.voiceName) tts.setVoice(prefs.voiceName)
  } catch {
    // ignore — prefs re-applied on next interaction
  }
}

/** (Re)fill the voice select; voices load asynchronously via voiceschanged. */
function populateVoiceSelect(): void {
  if (!voiceSelect) return
  const prefs = readPrefs()
  voiceSelect.textContent = ''
  const defaultOpt = el('option', undefined, 'Default voice')
  defaultOpt.value = ''
  if (!prefs.voiceName) defaultOpt.selected = true
  voiceSelect.appendChild(defaultOpt)
  for (const v of listVoices()) {
    const opt = el('option', undefined, `${v.name} (${v.lang ?? ''})`)
    opt.value = v.name
    if (prefs.voiceName === v.name) opt.selected = true
    voiceSelect.appendChild(opt)
  }
}

/** Current voiceschanged handler, so a re-render replaces the previous one. */
let voiceChangedHandler: (() => void) | null = null

function buildControls(): HTMLDivElement {
  const controls = el('div', 'controls')
  controls.hidden = true
  controlsEl = controls

  const prevSection = el('button', 'btn btn-icon', '«')
  prevSection.type = 'button'
  prevSection.title = 'Previous section'
  prevSection.setAttribute('aria-label', 'Previous section')
  prevSection.addEventListener('click', () => tts.skipSection(-1))

  const prevSentence = el('button', 'btn btn-icon', '‹')
  prevSentence.type = 'button'
  prevSentence.title = 'Previous sentence'
  prevSentence.setAttribute('aria-label', 'Previous sentence')
  prevSentence.addEventListener('click', () => tts.skip(-1))

  playBtn = el('button', 'btn btn-primary', 'Play')
  playBtn.type = 'button'
  playBtn.disabled = true
  playBtn.addEventListener('click', () => tts.play())

  pauseBtn = el('button', 'btn', 'Pause')
  pauseBtn.type = 'button'
  pauseBtn.disabled = true
  pauseBtn.addEventListener('click', () => tts.pause())

  stopBtn = el('button', 'btn', 'Stop')
  stopBtn.type = 'button'
  stopBtn.disabled = true
  stopBtn.addEventListener('click', () => tts.stop())

  const nextSentence = el('button', 'btn btn-icon', '›')
  nextSentence.type = 'button'
  nextSentence.title = 'Next sentence'
  nextSentence.setAttribute('aria-label', 'Next sentence')
  nextSentence.addEventListener('click', () => tts.skip(1))

  const nextSection = el('button', 'btn btn-icon', '»')
  nextSection.type = 'button'
  nextSection.title = 'Next section'
  nextSection.setAttribute('aria-label', 'Next section')
  nextSection.addEventListener('click', () => tts.skipSection(1))

  const prefs = readPrefs()
  const speed = el('select', 'select')
  speed.title = 'Playback speed'
  speed.setAttribute('aria-label', 'Playback speed')
  RATE_OPTIONS.forEach((r) => {
    const opt = el('option', undefined, `${r}x`)
    opt.value = String(r)
    if (Math.abs(r - prefs.rate) < 0.001) opt.selected = true
    speed.appendChild(opt)
  })
  speed.addEventListener('change', () => {
    const rate = Number(speed.value)
    tts.setRate(rate)
    const cur = readPrefs()
    writePrefs(cur.voiceName, rate)
  })

  const voice = el('select', 'select select-voice')
  voice.title = 'Voice'
  voice.setAttribute('aria-label', 'Voice')
  voiceSelect = voice
  populateVoiceSelect()
  // getVoices() is empty until voiceschanged fires; rebuild the list (and
  // re-apply the persisted voice) once the browser reports voices.
  const synth = (
    window as unknown as {
      speechSynthesis?: {
        addEventListener?: (type: string, cb: () => void) => void
        removeEventListener?: (type: string, cb: () => void) => void
      }
    }
  ).speechSynthesis
  if (voiceChangedHandler && synth?.removeEventListener) {
    synth.removeEventListener('voiceschanged', voiceChangedHandler)
  }
  voiceChangedHandler = () => {
    populateVoiceSelect()
    applyPrefs()
  }
  synth?.addEventListener?.('voiceschanged', voiceChangedHandler)
  voice.addEventListener('change', () => {
    const name = voice.value
    if (name) tts.setVoice(name)
    const cur = readPrefs()
    writePrefs(name || null, cur.rate)
  })

  controls.appendChild(prevSection)
  controls.appendChild(prevSentence)
  controls.appendChild(playBtn)
  controls.appendChild(pauseBtn)
  controls.appendChild(stopBtn)
  controls.appendChild(nextSentence)
  controls.appendChild(nextSection)
  controls.appendChild(speed)
  controls.appendChild(voice)
  return controls
}

// ---------- main view ----------

function showMain(): void {
  resetRoot()
  if (!root) return

  const header = el('header', 'header')
  header.appendChild(el('h1', 'app-title', 'ListenToPR'))
  const headerActions = el('div', 'header-actions')

  const settingsBtn = el('button', 'btn btn-secondary', 'Settings')
  settingsBtn.type = 'button'
  const lockBtn = el('button', 'btn btn-secondary', 'Lock')
  lockBtn.type = 'button'
  lockBtn.addEventListener('click', () => {
    vault.lock() // onLock listener switches to the locked view
  })
  headerActions.appendChild(settingsBtn)
  headerActions.appendChild(lockBtn)
  header.appendChild(headerActions)

  const settingsPanel = buildSettingsPanel()
  settingsBtn.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden
  })

  const main = el('main', 'main')
  main.appendChild(header)
  main.appendChild(settingsPanel)
  main.appendChild(makeStatusEl())

  if (shouldShowWakeLockFallback() && lsGet(KEYS.wlDismissed) !== '1') {
    const wlBanner = el(
      'div',
      'banner banner-warn',
      'Screen may sleep during playback',
    )
    const dismiss = el('button', 'btn btn-small', 'Dismiss')
    dismiss.type = 'button'
    dismiss.addEventListener('click', () => {
      wlBanner.hidden = true
      lsSet(KEYS.wlDismissed, '1')
    })
    wlBanner.appendChild(dismiss)
    main.appendChild(wlBanner)
  }

  const form = el('form', 'pr-form')
  const urlInput = el('input', 'field-input pr-input')
  urlInput.type = 'text'
  urlInput.autocomplete = 'off'
  urlInput.placeholder = 'https://github.com/owner/repo/pull/123'
  urlInput.setAttribute('aria-label', 'Pull request URL')
  listenBtn = el('button', 'btn btn-primary', 'Listen')
  listenBtn.type = 'submit'
  form.appendChild(urlInput)
  form.appendChild(listenBtn)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void startLoad(urlInput.value.trim())
  })
  main.appendChild(form)

  loadingEl = el('p', 'muted loading')
  loadingEl.textContent = 'Loading pull request…'
  loadingEl.hidden = true
  main.appendChild(loadingEl)

  transcriptEl = el('article', 'transcript')
  transcriptEl.hidden = true
  main.appendChild(transcriptEl)

  main.appendChild(buildControls())
  root.appendChild(main)

  applyPrefs()

  if (pendingAutoStartUrl) {
    urlInput.value = pendingAutoStartUrl
    const url = pendingAutoStartUrl
    pendingAutoStartUrl = null
    void startLoad(url)
  }
}

// ---------- PR load flow ----------

function prUrlString(ref: PullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`
}

async function startLoad(url: string): Promise<void> {
  if (!url) {
    setStatus('Enter a GitHub pull request URL.')
    return
  }
  const ref = parsePrUrl(url)
  if (!ref) {
    setStatus('Not a valid GitHub pull request URL.')
    return
  }
  clearStatus()
  if (listenBtn) listenBtn.disabled = true
  if (loadingEl) loadingEl.hidden = false
  if (transcriptEl) transcriptEl.hidden = true
  if (controlsEl) controlsEl.hidden = true
  try {
    const token = (await vaultGetSecret('github-token')) ?? ''
    const pr = await fetchPullRequest(ref, token)
    // images are best-effort: continue on failure
    const settled = await Promise.allSettled(
      pr.imageUrls.map((u) => fetchImageAsDataUrl(u, token)),
    )
    const imageDataUrls = settled
      .filter(
        (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
      )
      .map((r) => r.value)
    const endpoint = lsGet(KEYS.endpoint) ?? ''
    if (endpoint !== '' && !llmEndpointAllowed(endpoint)) {
      // CSP would turn the fetch into a TypeError and show a false
      // "offline" banner; fail with the real cause instead.
      setStatus(CSP_ENDPOINT_MSG)
      return
    }
    const cfg: LlmConfig = {
      endpoint,
      apiKey: (await vaultGetSecret('llm-api-key')) ?? '',
      model: lsGet(KEYS.model) ?? '',
    }
    const transcript = await buildTranscript(cfg, pr, { imageDataUrls })
    renderTranscriptView(transcript)
    tts.load(transcript)
    applyPrefs()
    updateControlStates(tts.state())
    if (controlsEl) controlsEl.hidden = false
  } catch (err) {
    if (!window.navigator.onLine || err instanceof TypeError) {
      showOfflineBanner()
    } else {
      setStatus(sanitizeError(err))
    }
  } finally {
    if (listenBtn) listenBtn.disabled = false
    if (loadingEl) loadingEl.hidden = true
  }
}

// ---------- share target / query routing ----------

function routeSharedUrl(): string | null {
  let ref: PullRequestRef | null = null
  try {
    const params = new URLSearchParams(window.location.search)
    const pr = params.get('pr')
    if (pr) ref = parsePrUrl(pr)
    if (!ref) {
      for (const key of ['text', 'url']) {
        const val = params.get(key)
        if (val) {
          ref = findPrUrl(val)
          if (ref) break
        }
      }
    }
  } catch {
    return null
  }
  return ref ? prUrlString(ref) : null
}

// ---------- offline + service worker ----------

function wireOffline(): void {
  window.addEventListener('online', hideOfflineBanner)
  window.addEventListener('offline', showOfflineBanner)
  if (!window.navigator.onLine) showOfflineBanner()
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in window.navigator)) return
  const secure =
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  if (!secure) return
  // Resolve against the document base so scoped deploys (e.g.
  // https://host/listentopr/) register <base>/sw.js, not host root.
  const swUrl = new URL('sw.js', document.baseURI).href
  void window.navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      updateCtrl = createUpdateController({
        registration,
        container: window.navigator.serviceWorker,
        document,
        reloadFn: () => window.location.reload(),
      })
      updateCtrl.onUpdateReady(() => {
        updateBanner.hidden = false
      })
      updateCtrl.schedule()
    })
    .catch(() => undefined)
}

// ---------- init ----------

function init(): void {
  root = document.getElementById('app')
  if (!root) return
  vault = new KeyVault()
  tts = createTtsController()
  wakeLock = createWakeLockController()
  vault.onLock(() => {
    showLocked()
  })
  // Auto-lock is an idle timer: any user activity resets it, so active
  // listening never gets cut off mid-playback.
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    document.addEventListener(
      type,
      () => {
        vault.notifyActivity()
      },
      { passive: true },
    )
  }
  document.addEventListener('visibilitychange', () => {
    vault.notifyActivity()
  })
  tts.onChange(onTtsChange)
  registerServiceWorker()
  wireOffline()
  pendingAutoStartUrl = routeSharedUrl()

  if (lsGet(KEYS.vaultReady) !== '1') {
    showSetup()
  } else if (vault.isUnlocked()) {
    showMain()
  } else {
    showLocked()
  }
}

init()
