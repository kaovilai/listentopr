// Secure key vault (DVC section 1).
//
// Secrets are encrypted with AES-GCM-256 before they touch IndexedDB.
// Each stored record carries its own random 12-byte IV and the random
// 16-byte salt used for key derivation. No plaintext key material is
// ever written to localStorage, sessionStorage, cookies or unencrypted
// IndexedDB records; the derived CryptoKey lives only in a module
// instance variable and is wiped by lock().

import type { SecretId, StoredSecret, VaultOptions } from './types'

const STORE_NAME = 'vault'
const DB_VERSION = 1
/** OWASP 2023 floor for PBKDF2-SHA256. */
const PBKDF2_ITERATIONS = 600_000
/** Fixed HKDF info string for the WebAuthn-PRF path. */
const HKDF_INFO = 'ListenToPR/vault/v1'

export class VaultError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** Vault is locked, was locked with a different credential, or decrypt failed. */
export class VaultLockedError extends VaultError {
  constructor(message = 'vault is locked') {
    super(message, 'VAULT_LOCKED')
    this.name = 'VaultLockedError'
  }
}

/** WebAuthn PRF unavailable, denied by the user, or not usable for this vault. */
export class VaultPrfError extends VaultError {
  constructor(message: string) {
    super(message, 'VAULT_PRF')
    this.name = 'VaultPrfError'
  }
}

/** IDB record shape: StoredSecret plus the WebAuthn credentialId (PRF path). */
interface VaultRecord extends StoredSecret {
  credentialId?: ArrayBuffer
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)))
}

/** True when the current environment exposes WebAuthn credentials + PRF. */
export function isPrfSupported(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.credentials &&
      typeof navigator.credentials.get === 'function' &&
      typeof PublicKeyCredential !== 'undefined'
    )
  } catch {
    return false
  }
}

export class Vault {
  /** Derived AES-GCM key. Volatile: only ever held here, null when locked. */
  private key: CryptoKey | null = null
  private keyMethod: 1 | 2 = 1
  /** Salt bound to the current in-memory key (kept so putSecret can reuse it). */
  private activeSalt: ArrayBuffer | null = null
  private prfCredentialId: ArrayBuffer | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  private readonly dbName: string
  private readonly idleTimeoutMs: number
  /** 'ephemeral': session-only in-memory secrets, no gate, no IndexedDB. */
  private mode: 'ephemeral' | 'persistent'
  /** Plaintext secrets for ephemeral mode; cleared by lock()/wipeAll(). */
  private readonly ephemeralSecrets = new Map<SecretId, string>()
  /** Ephemeral unlock flag (true from construction until lock()). */
  private ephemeralUnlocked: boolean
  /** Injectable IDB factory; the global indexedDB when not overridden. */
  private readonly idbFactory: IDBFactory | null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly changeSubs = new Set<() => void>()
  private readonly lockSubs = new Set<() => void>()

  constructor(options: VaultOptions = {}) {
    this.dbName = options.dbName ?? 'listentopr-vault'
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60 * 1000
    this.mode = options.mode ?? 'persistent'
    this.idbFactory = options.idbFactory ?? null
    this.ephemeralUnlocked = this.mode === 'ephemeral'
  }

  isUnlocked(): boolean {
    return this.mode === 'ephemeral' ? this.ephemeralUnlocked : this.key !== null
  }

  /** Instance delegate for the module-level environment check. */
  isPrfSupported(): boolean {
    return isPrfSupported()
  }

  /** Derive a fresh PIN-based key and unlock the vault in memory. */
  async setupWithPin(pin: string): Promise<void> {
    this.rejectEphemeral()
    // Re-running setup with an existing vault would store new records under
    // a fresh salt while old records keep theirs, bricking every unlock
    // path. Wipe or unlock the existing vault instead.
    const existing = await this.getAllRecords()
    if (existing.length > 0) {
      throw new VaultError('vault already set up; unlock or wipe it first', 'VAULT_ALREADY_SET_UP')
    }
    const salt = randomBytes(16).buffer as ArrayBuffer
    const key = await this.derivePinKey(pin, salt)
    this.key = key
    this.keyMethod = 1
    this.activeSalt = salt
    this.prfCredentialId = null
    this.touch()
  }

  /** Unlock with the user PIN. Wrong PIN fails the AES-GCM auth tag. */
  async unlockWithPin(pin: string): Promise<void> {
    this.rejectEphemeral()
    const records = await this.getAllRecords()
    if (records.length === 0) throw new VaultLockedError('vault is not set up')
    // Records can carry different salts (e.g. a partially-overwritten vault),
    // so try every PIN-derived record instead of an arbitrary one.
    const candidates = records.filter((r) => r.method === 1)
    if (candidates.length === 0) throw new VaultLockedError('vault is not protected with a PIN')
    for (const rec of candidates) {
      const key = await this.derivePinKey(pin, rec.salt)
      // Wrong PIN fails the AES-GCM auth tag; never rethrows raw.
      try {
        await this.decryptRecord(rec, key)
      } catch {
        continue
      }
      this.key = key
      this.keyMethod = 1
      this.activeSalt = rec.salt
      this.prfCredentialId = rec.credentialId ?? null
      this.touch()
      return
    }
    throw new VaultLockedError('decryption failed: wrong credential or corrupted vault')
  }

  /** Unlock via WebAuthn PRF extension (Option B). */
  async unlockWithPrf(): Promise<void> {
    this.rejectEphemeral()
    if (!isPrfSupported()) {
      throw new VaultPrfError('WebAuthn PRF is not supported in this environment')
    }
    const records = await this.getAllRecords()
    const rec = records.find((r) => r.method === 2) ?? null
    const bootstrap = records.length === 0
    if (!rec && !bootstrap) {
      throw new VaultPrfError('vault has no PRF-protected records')
    }
    const salt: ArrayBuffer = rec ? rec.salt : (randomBytes(16).buffer as ArrayBuffer)
    const { prfOutput, rawId } = await this.requestPrf(salt, rec?.credentialId ?? null)
    const key = await this.derivePrfKey(prfOutput, salt)
    if (rec) {
      // Verifies the PRF output matches what encrypted the vault.
      await this.decryptRecord(rec, key)
    }
    this.key = key
    this.keyMethod = 2
    this.activeSalt = salt
    this.prfCredentialId = rawId ?? rec?.credentialId ?? null
    this.touch()
  }

  /**
   * Migrate ephemeral secrets to a PIN-protected persistent vault in place:
   * derives the PIN key, re-encrypts every in-memory secret into IndexedDB
   * and switches this vault's mode to 'persistent'.
   */
  async persistToPin(pin: string): Promise<void> {
    this.requireEphemeralMode('persistToPin')
    const existing = await this.getAllRecords()
    if (existing.length > 0) {
      throw new VaultError('vault already set up; unlock or wipe it first', 'VAULT_ALREADY_SET_UP')
    }
    const salt = randomBytes(16).buffer as ArrayBuffer
    const key = await this.derivePinKey(pin, salt)
    this.key = key
    this.keyMethod = 1
    this.activeSalt = salt
    this.prfCredentialId = null
    await this.migrateEphemeralSecrets()
    this.touch()
  }

  /**
   * Migrate ephemeral secrets to a PRF-protected persistent vault in place,
   * bootstrapping a fresh WebAuthn PRF salt (may prompt biometrics once).
   */
  async persistToPrf(): Promise<void> {
    this.requireEphemeralMode('persistToPrf')
    if (!isPrfSupported()) {
      throw new VaultPrfError('WebAuthn PRF is not supported in this environment')
    }
    const existing = await this.getAllRecords()
    if (existing.length > 0) {
      throw new VaultError('vault already set up; unlock or wipe it first', 'VAULT_ALREADY_SET_UP')
    }
    const salt = randomBytes(16).buffer as ArrayBuffer
    const { prfOutput, rawId } = await this.requestPrf(salt, null)
    const key = await this.derivePrfKey(prfOutput, salt)
    this.key = key
    this.keyMethod = 2
    this.activeSalt = salt
    this.prfCredentialId = rawId
    await this.migrateEphemeralSecrets()
    this.touch()
  }

  /** True when any secret exists in memory (ephemeral) or IndexedDB (persistent). */
  async hasSecrets(): Promise<boolean> {
    if (this.mode === 'ephemeral') {
      return this.ephemeralSecrets.size > 0
    }
    const records = await this.getAllRecords()
    return records.length > 0
  }

  /** Re-encrypt and upsert a secret. Requires an unlocked vault. */
  async putSecret(id: SecretId, value: string): Promise<void> {
    if (this.mode === 'ephemeral') {
      this.requireUnlocked()
      this.ephemeralSecrets.set(id, value)
      this.notifyChange()
      this.touch()
      return
    }
    await this.putPersistentSecret(id, value)
  }

  /** Encrypt and upsert one record into IndexedDB (persistent write path). */
  private async putPersistentSecret(id: SecretId, value: string): Promise<void> {
    this.requireKey()
    const salt = this.activeSalt ?? (randomBytes(16).buffer as ArrayBuffer)
    const iv = randomBytes(12)
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.requireKey(),
      new TextEncoder().encode(value),
    )
    this.activeSalt = salt
    const record: VaultRecord = {
      id,
      ciphertext,
      iv: iv.buffer as ArrayBuffer,
      salt,
      method: this.keyMethod,
      createdAt: Date.now(),
    }
    if (this.keyMethod === 2 && this.prfCredentialId) {
      record.credentialId = this.prfCredentialId
    }
    await this.withStore('readwrite', (store) => {
      store.put(record)
      return undefined
    })
    this.notifyChange()
    this.touch()
  }

  /** Decrypt one secret with the in-memory key; plaintext is never cached. */
  async getSecret(id: SecretId): Promise<string> {
    if (this.mode === 'ephemeral') {
      this.requireUnlocked()
      const value = this.ephemeralSecrets.get(id)
      if (value === undefined) {
        throw new VaultError(`secret '${id}' not found`, 'VAULT_NOT_FOUND')
      }
      this.touch()
      return value
    }
    this.requireKey()
    const rec = (await this.withStore('readonly', (store) => store.get(id))) as VaultRecord | undefined
    if (!rec) throw new VaultError(`secret '${id}' not found`, 'VAULT_NOT_FOUND')
    const value = await this.decryptRecord(rec, this.requireKey())
    this.touch()
    return value
  }

  /** Wipe the in-memory CryptoKey and any derived material immediately. */
  lock(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const wasUnlocked = this.isUnlocked()
    this.key = null
    this.activeSalt = null
    // Ephemeral secrets die with the session lock — there is no disk copy.
    this.ephemeralSecrets.clear()
    this.ephemeralUnlocked = false
    if (wasUnlocked) {
      for (const cb of [...this.lockSubs]) {
        try {
          cb()
        } catch {
          /* subscriber errors must not break the lock path */
        }
      }
    }
  }

  /** Delete every record from the IndexedDB vault store and lock. */
  async wipeAll(): Promise<void> {
    if (this.mode === 'ephemeral') {
      // Ephemeral wipe clears the in-memory Map only: there is no disk to
      // wipe, and the session vault stays usable (no re-unlock path exists).
      this.ephemeralSecrets.clear()
      this.notifyChange()
      return
    }
    await this.withStore('readwrite', (store) => {
      store.clear()
      return undefined
    })
    this.lock()
    this.notifyChange()
  }

  /** Fires when secrets are added, changed or wiped. Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.changeSubs.add(cb)
    return () => {
      this.changeSubs.delete(cb)
    }
  }

  /** Fires when the vault locks (manual or idle auto-lock). Returns unsubscribe. */
  onLock(cb: () => void): () => void {
    this.lockSubs.add(cb)
    return () => {
      this.lockSubs.delete(cb)
    }
  }

  /**
   * User activity (pointer/key/touch/visibility): reset the idle auto-lock
   * timer. No-op while locked or disposed. Auto-lock is an idle timer, not
   * a time-since-unlock timer.
   */
  notifyActivity(): void {
    this.touch()
  }

  /** Clear the auto-lock timer without locking (teardown helper). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // ---------- internals ----------

  private requireKey(): CryptoKey {
    if (!this.key) throw new VaultLockedError()
    return this.key
  }

  /** Gate for ephemeral-mode secret access (no key material exists there). */
  private requireUnlocked(): void {
    if (!this.isUnlocked()) throw new VaultLockedError()
  }

  /** Persistent-only entry points are unusable on an ephemeral vault. */
  private rejectEphemeral(): void {
    if (this.mode === 'ephemeral') {
      throw new VaultError('vault is ephemeral', 'VAULT_EPHEMERAL')
    }
  }

  /** Migration entry points only make sense on an ephemeral vault. */
  private requireEphemeralMode(method: string): void {
    if (this.mode !== 'ephemeral') {
      throw new VaultError(`${method} requires an ephemeral vault`, 'VAULT_NOT_EPHEMERAL')
    }
  }

  /**
   * Run one WebAuthn PRF assertion against the given salt, optionally
   * scoped to a stored credential. Converts every failure mode into a
   * typed VaultPrfError.
   */
  private async requestPrf(
    salt: ArrayBuffer,
    credentialId: ArrayBuffer | null,
  ): Promise<{ prfOutput: ArrayBuffer; rawId: ArrayBuffer | null }> {
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: randomBytes(32),
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } } as PublicKeyCredentialRequestOptions['extensions'],
    }
    if (credentialId) {
      publicKey.allowCredentials = [{ id: credentialId, type: 'public-key' }]
    }
    let assertion: PublicKeyCredential | null = null
    try {
      assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential
    } catch (err) {
      throw new VaultPrfError(`PRF assertion failed: ${(err as Error)?.message ?? String(err)}`)
    }
    const ext = (assertion as unknown as {
      clientExtensionResults?: { prf?: { results?: { first?: ArrayBuffer } } }
    })?.clientExtensionResults
    const prfOutput = ext?.prf?.results?.first
    if (!prfOutput) throw new VaultPrfError('PRF extension denied or unavailable')
    return { prfOutput, rawId: (assertion?.rawId as ArrayBuffer) ?? null }
  }

  /**
   * Re-encrypt every ephemeral secret into IndexedDB, then switch to
   * persistent mode in place. Records are written while the vault is still
   * ephemeral: a mid-migration IndexedDB failure (quota exceeded,
   * private-mode write rejection) must leave the not-yet-migrated secrets
   * reachable in the ephemeral Map with the mode intact, so 'Remember' can
   * simply be retried. The mode flip and the Map drop happen only after
   * every record landed on disk.
   */
  private async migrateEphemeralSecrets(): Promise<void> {
    const entries = [...this.ephemeralSecrets]
    try {
      for (const [id, value] of entries) {
        await this.putPersistentSecret(id, value)
      }
    } catch (err) {
      // Roll back: stay ephemeral, drop the derived key, and best-effort
      // remove any records that already landed — otherwise the retry's
      // empty-vault check trips over the half-written set.
      try {
        await this.withStore('readwrite', (store) => {
          store.clear()
          return undefined
        })
      } catch {
        /* the ephemeral Map is still intact; nothing more to do here */
      }
      this.key = null
      this.activeSalt = null
      this.prfCredentialId = null
      throw err
    }
    this.mode = 'persistent'
    this.ephemeralUnlocked = false
    this.ephemeralSecrets.clear()
    this.notifyChange()
  }

  private async derivePinKey(pin: string, salt: ArrayBuffer): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base,
      { name: 'AES-GCM', length: 256 },
      false, // extractable: false
      ['encrypt', 'decrypt'],
    )
  }

  private async derivePrfKey(prfOutput: ArrayBuffer, salt: ArrayBuffer): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: new TextEncoder().encode(HKDF_INFO),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private async decryptRecord(rec: VaultRecord, key: CryptoKey): Promise<string> {
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ciphertext)
    } catch {
      // Auth-tag failure: wrong credential or tampered record. No key
      // material or raw crypto error detail is surfaced.
      throw new VaultLockedError('decryption failed: wrong credential or corrupted vault')
    }
    return new TextDecoder().decode(plaintext)
  }

  private async getAllRecords(): Promise<VaultRecord[]> {
    const records = (await this.withStore('readonly', (store) => store.getAll())) as VaultRecord[]
    return records ?? []
  }

  private notifyChange(): void {
    for (const cb of [...this.changeSubs]) {
      try {
        cb()
      } catch {
        /* subscriber errors must not break vault operations */
      }
    }
  }

  /** Reset the idle timer; arm it only while unlocked and when enabled. */
  private touch(): void {
    if (this.disposed) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.idleTimeoutMs > 0 && this.isUnlocked()) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.lock()
      }, this.idleTimeoutMs)
    }
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = (this.idbFactory ?? indexedDB).open(this.dbName, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => {
          this.dbPromise = null
          reject(req.error ?? new Error(`failed to open IndexedDB ${this.dbName}`))
        }
      })
    }
    return this.dbPromise
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest | void,
  ): Promise<T> {
    const db = await this.openDb()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      let result: unknown
      const req = fn(store)
      if (req) {
        req.onsuccess = () => {
          result = req.result
        }
      }
      tx.oncomplete = () => resolve(result as T)
      tx.onerror = () => reject(tx.error ?? new Error('vault store operation failed'))
      tx.onabort = () => reject(tx.error ?? new Error('vault store operation aborted'))
    })
  }
}
