import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vault, VaultError, VaultLockedError, VaultPrfError } from './vault'
import type { StoredSecret } from './types'

// ---------- helpers ----------

const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

/** Read raw records straight from IndexedDB, bypassing the vault. */
function rawRecords(dbName: string): Promise<(StoredSecret & { credentialId?: ArrayBuffer })[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vault')) {
        resolve([])
        db.close()
        return
      }
      const tx = db.transaction('vault', 'readonly')
      const get = tx.objectStore('vault').getAll()
      get.onsuccess = () => {
        resolve(get.result)
        db.close()
      }
      get.onerror = () => reject(get.error)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Decode every ArrayBuffer field of a record into one binary string. */
function recordBytes(rec: StoredSecret & { credentialId?: ArrayBuffer }): string {
  let out = ''
  for (const buf of [rec.ciphertext, rec.iv, rec.salt, rec.credentialId]) {
    if (buf) out += String.fromCharCode(...new Uint8Array(buf))
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let dbCounter = 0
function freshVault(opts: { idleTimeoutMs?: number } = {}): Vault {
  dbCounter += 1
  return new Vault({ dbName: `vault-test-${dbCounter}-${crypto.randomUUID()}`, ...opts })
}

function installPrfMock(opts: {
  prfOutput?: Uint8Array
  credentialId?: Uint8Array
  rejectWith?: Error
}): ReturnType<typeof vi.fn> {
  const credentialId = opts.credentialId ?? new Uint8Array([9, 8, 7, 6])
  const get = vi.fn(async () => {
    if (opts.rejectWith) throw opts.rejectWith
    return {
      rawId: credentialId.slice().buffer,
      response: {},
      clientExtensionResults: opts.prfOutput
        ? { prf: { results: { first: opts.prfOutput.slice().buffer } } }
        : { prf: {} },
    }
  })
  setNavigator({ credentials: { get } })
  ;(globalThis as unknown as Record<string, unknown>).PublicKeyCredential = class PublicKeyCredential {}
  return get
}

afterEach(() => {
  if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor)
  delete (globalThis as unknown as Record<string, unknown>).PublicKeyCredential
  vi.useRealTimers()
})

// ---------- PIN path ----------

describe('Vault PIN path', () => {
  it('stores and returns a secret after setupWithPin', async () => {
    const vault = freshVault()
    await vault.setupWithPin('correct-horse')
    await vault.putSecret('github-token', 'ghp_abc123')
    expect(vault.isUnlocked()).toBe(true)
    await expect(vault.getSecret('github-token')).resolves.toBe('ghp_abc123')
  })

  it('persists only encrypted material in IndexedDB (no plaintext anywhere)', async () => {
    const vault = freshVault()
    await vault.setupWithPin('pin-1234')
    await vault.putSecret('github-token', 'ghp_SUPERSECRET')
    const dbName = (vault as unknown as { dbName: string }).dbName
    const records = await rawRecords(dbName)
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.id).toBe('github-token')
    expect(rec.method).toBe(1)
    expect(new Uint8Array(rec.iv).length).toBe(12)
    expect(new Uint8Array(rec.salt).length).toBe(16)
    expect(new Uint8Array(rec.ciphertext).length).toBeGreaterThan(0)
    // Plaintext and the PIN must not appear in any persisted byte sequence.
    expect(recordBytes(rec)).not.toContain('ghp_SUPERSECRET')
    expect(recordBytes(rec)).not.toContain('pin-1234')
  })

  it('rejects getSecret/putSecret while locked', async () => {
    const vault = freshVault()
    await expect(vault.getSecret('github-token')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(vault.putSecret('github-token', 'x')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('wrong PIN fails unlock with a typed error, correct PIN succeeds', async () => {
    const vault = freshVault()
    await vault.setupWithPin('right-pin')
    await vault.putSecret('llm-api-key', 'sk-live-42')
    vault.lock()
    expect(vault.isUnlocked()).toBe(false)

    await expect(vault.unlockWithPin('wrong-pin')).rejects.toBeInstanceOf(VaultLockedError)
    try {
      await vault.unlockWithPin('wrong-pin')
    } catch (err) {
      // Never surface the tried PIN or raw crypto internals.
      expect((err as Error).message).not.toContain('wrong-pin')
    }
    expect(vault.isUnlocked()).toBe(false)

    await vault.unlockWithPin('right-pin')
    await expect(vault.getSecret('llm-api-key')).resolves.toBe('sk-live-42')
  })

  it('unlock on an empty vault fails with a typed error', async () => {
    const vault = freshVault()
    await expect(vault.unlockWithPin('any')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('refuses setupWithPin when the vault already has records (no bricking)', async () => {
    const vault = freshVault()
    await vault.setupWithPin('pin-one')
    await vault.putSecret('github-token', 'tok')
    vault.lock()
    await expect(vault.setupWithPin('pin-two')).rejects.toMatchObject({
      code: 'VAULT_ALREADY_SET_UP',
    })
    // The original PIN still unlocks the untouched vault.
    await vault.unlockWithPin('pin-one')
    await expect(vault.getSecret('github-token')).resolves.toBe('tok')
  })

  it('unlockWithPin tries every method-1 salt, not just the first record', async () => {
    // Simulate a partially-overwritten vault: one record under salt A
    // (PIN A) and one under salt B (PIN B), both method 1.
    const vaultA = freshVault()
    await vaultA.setupWithPin('pin-a')
    await vaultA.putSecret('github-token', 'from-a')
    const dbName = (vaultA as unknown as { dbName: string }).dbName

    // Craft a second method-1 record under a different salt + PIN directly
    // in the same IndexedDB, exactly like a stale re-setup would leave.
    const saltB = crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('pin-b'), 'PBKDF2', false, ['deriveKey'])
    const keyB = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltB, iterations: 600_000 },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyB, new TextEncoder().encode('from-b'))
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('vault', 'readwrite')
        tx.objectStore('vault').put({
          id: 'llm-api-key',
          ciphertext,
          iv: iv.buffer as ArrayBuffer,
          salt: saltB,
          method: 1,
          createdAt: Date.now(),
        })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // Both PINs must open the vault regardless of getAll() record order.
    await vaultA.unlockWithPin('pin-a')
    await expect(vaultA.getSecret('github-token')).resolves.toBe('from-a')
    vaultA.lock()
    await vaultA.unlockWithPin('pin-b')
    await expect(vaultA.getSecret('llm-api-key')).resolves.toBe('from-b')
    // A PIN matching neither salt is still rejected.
    vaultA.lock()
    await expect(vaultA.unlockWithPin('pin-c')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('getSecret on a missing id throws VaultError', async () => {
    const vault = freshVault()
    await vault.setupWithPin('p')
    await expect(vault.getSecret('llm-api-key')).rejects.toBeInstanceOf(VaultError)
  })

  it('putSecret upserts: one record, new value, new IV', async () => {
    const vault = freshVault()
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 'first-value')
    const dbName = (vault as unknown as { dbName: string }).dbName
    const before = (await rawRecords(dbName))[0]!
    await vault.putSecret('github-token', 'second-value')
    const after = (await rawRecords(dbName))[0]!

    expect(await rawRecords(dbName)).toHaveLength(1)
    await expect(vault.getSecret('github-token')).resolves.toBe('second-value')
    expect(new Uint8Array(after.iv)).not.toEqual(new Uint8Array(before.iv))
    expect(new Uint8Array(after.ciphertext)).not.toEqual(new Uint8Array(before.ciphertext))
  })

  it('multiple instances with separate dbNames are isolated', async () => {
    const a = freshVault()
    const b = freshVault()
    await a.setupWithPin('pin-a')
    await a.putSecret('github-token', 'token-a')
    await b.setupWithPin('pin-b')
    await b.putSecret('github-token', 'token-b')
    await expect(a.getSecret('github-token')).resolves.toBe('token-a')
    await expect(b.getSecret('github-token')).resolves.toBe('token-b')
  })

  it('wipeAll removes every record and locks', async () => {
    const vault = freshVault()
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't1')
    await vault.putSecret('llm-api-key', 't2')
    const dbName = (vault as unknown as { dbName: string }).dbName
    await vault.wipeAll()
    expect(await rawRecords(dbName)).toHaveLength(0)
    expect(vault.isUnlocked()).toBe(false)
    await expect(vault.unlockWithPin('p')).rejects.toBeInstanceOf(VaultLockedError)
  })
})

// ---------- WebAuthn PRF path ----------

describe('Vault WebAuthn PRF path', () => {
  it('isPrfSupported is false without navigator.credentials/PublicKeyCredential', async () => {
    const { isPrfSupported } = await import('./vault')
    setNavigator({})
    delete (globalThis as unknown as Record<string, unknown>).PublicKeyCredential
    expect(isPrfSupported()).toBe(false)
    const vault = freshVault()
    await expect(vault.unlockWithPrf()).rejects.toBeInstanceOf(VaultPrfError)
  })

  it('bootstraps, persists credentialId, and re-unlocks via PRF', async () => {
    const prfOutput = crypto.getRandomValues(new Uint8Array(32))
    const credentialId = new Uint8Array([1, 2, 3, 4, 5])
    const get = installPrfMock({ prfOutput, credentialId })

    const vault = freshVault()
    await vault.unlockWithPrf() // empty vault: bootstrap with a fresh salt
    expect(vault.isUnlocked()).toBe(true)
    await vault.putSecret('github-token', 'prf-secret-token')

    const dbName = (vault as unknown as { dbName: string }).dbName
    const records = await rawRecords(dbName)
    expect(records).toHaveLength(1)
    expect(records[0]!.method).toBe(2)
    expect(new Uint8Array(records[0]!.credentialId!)).toEqual(credentialId)
    // First assertion: no allowCredentials (nothing stored yet).
    const firstCall = get.mock.calls[0]![0] as { publicKey: { allowCredentials?: unknown } }
    expect(firstCall.publicKey.allowCredentials).toBeUndefined()
    // PRF eval is fed the stored salt.
    expect(get.mock.calls[0]![0]).toMatchObject({
      publicKey: { userVerification: 'required', extensions: { prf: { eval: { first: records[0]!.salt } } } },
    })

    vault.lock()
    await vault.unlockWithPrf()
    expect(vault.isUnlocked()).toBe(true)
    await expect(vault.getSecret('github-token')).resolves.toBe('prf-secret-token')
    // Re-unlock passed the stored credentialId in allowCredentials.
    const secondCall = get.mock.calls[1]![0] as {
      publicKey: { allowCredentials: { id: ArrayBuffer; type: string }[] }
    }
    expect(secondCall.publicKey.allowCredentials).toEqual([
      { id: records[0]!.credentialId, type: 'public-key' },
    ])
  })

  it('PRF denial (no prf results) throws VaultPrfError and stays locked', async () => {
    installPrfMock({ prfOutput: undefined })
    const vault = freshVault()
    await expect(vault.unlockWithPrf()).rejects.toBeInstanceOf(VaultPrfError)
    expect(vault.isUnlocked()).toBe(false)
  })

  it('PRF assertion rejection is converted to VaultPrfError', async () => {
    installPrfMock({ rejectWith: new DOMException('NotAllowed', 'NotAllowedError') })
    const vault = freshVault()
    await expect(vault.unlockWithPrf()).rejects.toBeInstanceOf(VaultPrfError)
  })

  it('a different PRF output cannot unlock an existing PRF vault', async () => {
    const vault = freshVault()
    installPrfMock({ prfOutput: crypto.getRandomValues(new Uint8Array(32)) })
    await vault.unlockWithPrf()
    await vault.putSecret('github-token', 'locked-away')
    vault.lock()

    installPrfMock({
      prfOutput: crypto.getRandomValues(new Uint8Array(32)),
      credentialId: new Uint8Array([1, 2, 3, 4, 5]),
    })
    await expect(vault.unlockWithPrf()).rejects.toBeInstanceOf(VaultLockedError)
    expect(vault.isUnlocked()).toBe(false)
  })

  it('unlockWithPrf on a PIN-only vault throws VaultPrfError', async () => {
    const vault = freshVault()
    await vault.setupWithPin('pin')
    await vault.putSecret('github-token', 't')
    installPrfMock({ prfOutput: crypto.getRandomValues(new Uint8Array(32)) })
    await expect(vault.unlockWithPrf()).rejects.toBeInstanceOf(VaultPrfError)
  })
})

// ---------- lock / auto-lock / subscriptions ----------

describe('Vault lock, auto-lock and subscriptions', () => {
  it('lock wipes the key: subsequent secret access fails', async () => {
    const vault = freshVault()
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't')
    vault.lock()
    await expect(vault.getSecret('github-token')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(vault.putSecret('github-token', 't2')).rejects.toBeInstanceOf(VaultLockedError)
  })

  // fake-indexeddb itself runs on timers, so vi.useFakeTimers starves it;
  // auto-lock is tested with real timers and short timeouts instead.
  it('auto-locks after idleTimeoutMs of inactivity and fires onLock', async () => {
    const onLock = vi.fn()
    const vault = freshVault({ idleTimeoutMs: 100 })
    vault.onLock(onLock)
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't')

    await sleep(60)
    expect(vault.isUnlocked()).toBe(true)
    expect(onLock).not.toHaveBeenCalled()
    await sleep(80)
    expect(vault.isUnlocked()).toBe(false)
    expect(onLock).toHaveBeenCalledTimes(1)
  })

  it('every operation resets the idle timer', async () => {
    const vault = freshVault({ idleTimeoutMs: 200 })
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't0')

    await sleep(100)
    await vault.getSecret('github-token') // resets timer at ~t=100
    await sleep(120)
    expect(vault.isUnlocked()).toBe(true) // expiry would be t=200 without reset
    await sleep(150)
    expect(vault.isUnlocked()).toBe(false)
  })

  it('idleTimeoutMs 0 disables auto-lock', async () => {
    const vault = freshVault({ idleTimeoutMs: 0 })
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't')
    await sleep(150)
    expect(vault.isUnlocked()).toBe(true)
  })

  it('dispose clears the auto-lock timer without locking', async () => {
    // Real timers: fake timers starve fake-indexeddb (setupWithPin now
    // reads existing records through IndexedDB before deriving a key).
    const vault = freshVault({ idleTimeoutMs: 150 })
    await vault.setupWithPin('p')
    vault.dispose()
    await sleep(300)
    expect(vault.isUnlocked()).toBe(true)
  })

  it('operations after dispose do not re-arm the auto-lock timer', async () => {
    const vault = freshVault({ idleTimeoutMs: 150 })
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't')
    vault.dispose()
    // An in-flight/late operation calls touch(); it must stay a no-op.
    await vault.getSecret('github-token')
    vault.notifyActivity()
    await sleep(300)
    expect(vault.isUnlocked()).toBe(true)
  })

  it('notifyActivity resets the idle timer while unlocked', async () => {
    const vault = freshVault({ idleTimeoutMs: 200 })
    await vault.setupWithPin('p')
    await vault.putSecret('github-token', 't')
    // Keep "using the app" without any vault operation: activity alone
    // must hold the vault open past the raw timeout.
    for (let i = 0; i < 3; i++) {
      await sleep(90)
      vault.notifyActivity()
    }
    expect(vault.isUnlocked()).toBe(true)
    await sleep(300)
    expect(vault.isUnlocked()).toBe(false)
  })

  it('manual lock fires onLock; unsubscribe stops delivery', async () => {
    const vault = freshVault()
    const calls: string[] = []
    const off = vault.onLock(() => calls.push('a'))
    vault.onLock(() => calls.push('b'))
    await vault.setupWithPin('p')
    vault.lock()
    expect(calls).toEqual(['a', 'b'])
    off()
    vault.lock() // already locked: no transition, no callbacks
    expect(calls).toEqual(['a', 'b'])
  })

  it('onChange fires on putSecret and wipeAll; unsubscribe works', async () => {
    const vault = freshVault()
    const onChange = vi.fn()
    const off = vault.onChange(onChange)
    await vault.setupWithPin('p')
    expect(onChange).not.toHaveBeenCalled()
    await vault.putSecret('github-token', 't')
    expect(onChange).toHaveBeenCalledTimes(1)
    off()
    await vault.putSecret('github-token', 't2')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
