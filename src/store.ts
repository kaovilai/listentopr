// Non-secret persistence layer for ListenToPR, backed by IndexedDB.
// DB name 'listentopr-store', versioned via `version` below.
//
// PLAINTEXT-SAFE DATA ONLY. Transcripts, queue entries, resume positions
// and listen history are user-generated/convenience data, not credentials.
// NEVER store tokens or keys here — secrets belong in the encrypted vault
// (src/vault.ts).

import type { PullRequestRef, Transcript } from './types'

export interface QueueItem {
  ref: PullRequestRef
  title: string
  addedAt: number
}

interface StoredTranscript {
  id: string
  refKey: string
  ref: PullRequestRef
  headSha: string
  transcript: Transcript
  createdAt: number
}

interface StoredResume {
  refKey: string
  sentenceIndex: number
}

interface StoredListen {
  refKey: string
  headSha: string
  at: number
}

export interface StoreOptions {
  dbName?: string
}

const DB_NAME = 'listentopr-store'
const DB_VERSION = 1
const TRANSCRIPTS = 'transcripts'
const RESUME = 'resume'
const QUEUE = 'queue'
const LISTENS = 'listens'

function refKey(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

/**
 * Persistence facade. Every method returns a promise and never throws:
 * IDB failures resolve to empty/null/zero results instead of surfacing
 * raw errors to the UI. Structural failures (open/upgrade) are also
 * swallowed; the store then behaves as persistently empty.
 */
export class Store {
  private dbName: string
  private dbPromise: Promise<IDBDatabase | null>

  constructor(opts: StoreOptions = {}) {
    this.dbName = opts.dbName ?? DB_NAME
    this.dbPromise = this.open().catch(() => null)
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(TRANSCRIPTS)) {
          const s = db.createObjectStore(TRANSCRIPTS, { keyPath: 'id' })
          s.createIndex('refKey', 'refKey')
        }
        if (!db.objectStoreNames.contains(RESUME)) {
          db.createObjectStore(RESUME, { keyPath: 'refKey' })
        }
        if (!db.objectStoreNames.contains(QUEUE)) {
          const s = db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true })
          s.createIndex('refKey', 'refKey')
        }
        if (!db.objectStoreNames.contains(LISTENS)) {
          db.createObjectStore(LISTENS, { keyPath: 'refKey' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  private async run<T>(
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> {
    const db = await this.dbPromise
    if (!db) return null
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const req = work(tx.objectStore(storeName))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
      })
    } catch {
      return null
    }
  }

  // ---------- Transcript cache ----------

  async putTranscript(ref: PullRequestRef, headSha: string, transcript: Transcript): Promise<void> {
    const key = refKey(ref)
    await this.run(TRANSCRIPTS, 'readwrite', (store) =>
      store.put({
        id: `${key}@${headSha}`,
        refKey: key,
        ref,
        headSha,
        transcript,
        createdAt: Date.now(),
      } satisfies StoredTranscript),
    )
  }

  async getCachedTranscript(ref: PullRequestRef, headSha: string): Promise<Transcript | null> {
    const row = await this.run<StoredTranscript | undefined>(
      TRANSCRIPTS,
      'readonly',
      (store) => store.get(`${refKey(ref)}@${headSha}`) as IDBRequest<StoredTranscript | undefined>,
    )
    return row?.transcript ?? null
  }

  /** SHA of the most recently stored transcript for this ref, by createdAt. */
  async latestCachedSha(ref: PullRequestRef): Promise<string | null> {
    const rows = await this.run<StoredTranscript[]>(
      TRANSCRIPTS,
      'readonly',
      (store) => store.index('refKey').getAll(refKey(ref)) as IDBRequest<StoredTranscript[]>,
    )
    if (!rows || rows.length === 0) return null
    let best: StoredTranscript | undefined
    for (const row of rows) {
      if (!best || row.createdAt > best.createdAt || (row.createdAt === best.createdAt && row.headSha > best.headSha)) {
        best = row
      }
    }
    return best?.headSha ?? null
  }

  async dropTranscript(ref: PullRequestRef): Promise<void> {
    const key = refKey(ref)
    const rows = await this.run<StoredTranscript[]>(
      TRANSCRIPTS,
      'readonly',
      (store) => store.index('refKey').getAll(key) as IDBRequest<StoredTranscript[]>,
    )
    if (!rows || rows.length === 0) return
    await this.run(TRANSCRIPTS, 'readwrite', (store) => {
      for (const row of rows) store.delete(row.id)
      return store.get('') // sentinel request so the tx has one
    })
  }

  // ---------- Resume position ----------

  async setResume(ref: PullRequestRef, sentenceIndex: number): Promise<void> {
    await this.run(RESUME, 'readwrite', (store) =>
      store.put({ refKey: refKey(ref), sentenceIndex } satisfies StoredResume),
    )
  }

  async getResume(ref: PullRequestRef): Promise<number | null> {
    const row = await this.run<StoredResume | undefined>(
      RESUME,
      'readonly',
      (store) => store.get(refKey(ref)) as IDBRequest<StoredResume | undefined>,
    )
    return row?.sentenceIndex ?? null
  }

  async clearResume(ref: PullRequestRef): Promise<void> {
    await this.run(RESUME, 'readwrite', (store) => store.delete(refKey(ref)))
  }

  // ---------- Queue ----------

  async enqueue(item: QueueItem): Promise<void> {
    await this.run(QUEUE, 'readwrite', (store) =>
      store.put({ ...item, refKey: refKey(item.ref) }),
    )
  }

  /** Remove and return the oldest queued item (FIFO), or null when empty. */
  async dequeue(): Promise<QueueItem | null> {
    const db = await this.dbPromise
    if (!db) return null
    try {
      return await new Promise<QueueItem | null>((resolve, reject) => {
        const tx = db.transaction(QUEUE, 'readwrite')
        const store = tx.objectStore(QUEUE)
        const req = store.openCursor()
        let result: QueueItem | null = null
        req.onsuccess = () => {
          const cursor = req.result
          if (cursor) {
            const { ref, title, addedAt } = cursor.value as QueueItem & { refKey: string }
            result = { ref, title, addedAt }
            cursor.delete()
          }
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
      })
    } catch {
      return null
    }
  }

  async queueAll(): Promise<QueueItem[]> {
    const rows = await this.run<(QueueItem & { refKey: string })[]>(
      QUEUE,
      'readonly',
      (store) => store.getAll() as IDBRequest<(QueueItem & { refKey: string })[]>,
    )
    if (!rows) return []
    return rows
      .map(({ ref, title, addedAt }) => ({ ref, title, addedAt }))
      .sort((a, b) => a.addedAt - b.addedAt)
  }

  async removeFromQueue(ref: PullRequestRef): Promise<void> {
    const key = refKey(ref)
    const rows = await this.run<(QueueItem & { id: number; refKey: string })[]>(
      QUEUE,
      'readonly',
      (store) => store.index('refKey').getAll(key) as IDBRequest<(QueueItem & { id: number; refKey: string })[]>,
    )
    if (!rows || rows.length === 0) return
    await this.run(QUEUE, 'readwrite', (store) => {
      for (const row of rows) store.delete(row.id)
      return store.get(0) // sentinel request so the tx has one
    })
  }

  async queueLength(): Promise<number> {
    const n = await this.run<number>(QUEUE, 'readonly', (store) => store.count())
    return n ?? 0
  }

  // ---------- Listen history ----------

  async recordListen(ref: PullRequestRef, headSha: string): Promise<void> {
    await this.run(LISTENS, 'readwrite', (store) =>
      store.put({ refKey: refKey(ref), headSha, at: Date.now() } satisfies StoredListen),
    )
  }

  async lastListen(ref: PullRequestRef): Promise<{ headSha: string; at: number } | null> {
    const row = await this.run<StoredListen | undefined>(
      LISTENS,
      'readonly',
      (store) => store.get(refKey(ref)) as IDBRequest<StoredListen | undefined>,
    )
    return row ? { headSha: row.headSha, at: row.at } : null
  }

  // ---------- Maintenance ----------

  /** Delete the entire database. */
  async wipe(): Promise<void> {
    const db = await this.dbPromise
    if (db) db.close()
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(this.dbName)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })
    // Reopen fresh so subsequent calls work against an empty DB.
    this.dbPromise = this.open().catch(() => null)
    await this.dbPromise
  }
}

/** Convenience factory. */
export function createStore(opts: StoreOptions = {}): Store {
  return new Store(opts)
}
