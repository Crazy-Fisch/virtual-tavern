import { Injectable } from '@angular/core';

const DB_NAME = 'virtual-tavern-cards';
const STORE = 'kv';

/**
 * Tiny promise wrapper over an IndexedDB key-value store, holding the compact
 * card index built from the Scryfall bulk file (tens of MB — far past any
 * localStorage quota). Injectable so tests swap in an in-memory fake (jsdom
 * has no IndexedDB); in environments without IndexedDB it degrades to a
 * cache-miss, which just means re-downloading next start.
 */
@Injectable({ providedIn: 'root' })
export class CardDbCache {
  async get<T>(key: string): Promise<T | undefined> {
    if (typeof indexedDB === 'undefined') return undefined;
    const db = await this.open();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  /** Best-effort delete — a missing key or unavailable IndexedDB is fine. */
  async delete(key: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    try {
      const db = await this.open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    } catch {
      // ignore
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
