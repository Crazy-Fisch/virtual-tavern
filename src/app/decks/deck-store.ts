import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Deck, DeckEntry } from './deck.types';
import { parseDecklist } from './decklist-parser';

/** Legacy localStorage key from when decks were per-browser; migrated on first load. */
const LEGACY_DECKS_KEY = 'virtual-tavern.decks';

function isEntry(value: unknown): value is DeckEntry {
  const entry = value as Partial<DeckEntry> | null;
  return !!entry && typeof entry.card === 'string' && typeof entry.count === 'number';
}

function isDeck(value: unknown): value is Deck {
  const deck = value as Partial<Deck> | null;
  return (
    !!deck &&
    typeof deck.id === 'string' &&
    typeof deck.name === 'string' &&
    Array.isArray(deck.list) &&
    deck.list.every(isEntry)
  );
}

/**
 * The player's decks, persisted per account in Supabase (`decks` table,
 * owner-only RLS). Deck persistence is an account feature: guests and
 * signed-out users have no decks and cannot import any (`available`), which
 * hides the Decks screen for them. Decks imported before this existed (the
 * old per-browser localStorage) are uploaded once on the first signed-in load.
 * Phase 1 is import-only (see deck.types.ts); the Decks page creates and
 * deletes decks here, and the in-room deck chooser reads them when a player
 * sits down at the table.
 */
@Injectable({ providedIn: 'root' })
export class DeckStore {
  private readonly supabase = inject(SupabaseService);

  private readonly _decks = signal<Deck[]>([]);
  readonly decks = this._decks.asReadonly();

  /** Whether this session can keep decks: signed in with an account, not a guest. */
  readonly available = computed(() => !!this.supabase.userId() && !this.supabase.isGuest());

  constructor() {
    // Follow the session: load the account's decks on sign-in, drop them on
    // sign-out (or for guests, who never have any).
    effect(() => {
      const uid = this.supabase.userId();
      const usable = this.available();
      untracked(() => {
        this._decks.set([]);
        if (uid && usable) void this.load(uid);
      });
    });
  }

  /**
   * Parse a pasted decklist and store it on the account. Returns an error
   * message, or null on success (matching the RoomService convention).
   */
  async import(name: string, decklist: string): Promise<string | null> {
    if (!this.available()) return 'Deck import needs an account (guests cannot keep decks).';
    const list = parseDecklist(decklist);
    if (list.length === 0) return 'No cards found — paste a decklist like “4 Lightning Bolt”.';
    const deck: Deck = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 60) || 'Unnamed deck',
      list,
    };
    // Optimistic append, rolled back if the insert fails.
    this._decks.update((decks) => [...decks, deck]);
    const { error } = await this.supabase.client
      .from('decks')
      .insert({ id: deck.id, owner_id: this.supabase.userId(), name: deck.name, list: deck.list });
    if (error) {
      this._decks.update((decks) => decks.filter((d) => d.id !== deck.id));
      return error.message;
    }
    return null;
  }

  remove(id: string): void {
    this._decks.update((decks) => decks.filter((d) => d.id !== id));
    void this.supabase.client.from('decks').delete().eq('id', id);
  }

  private async load(uid: string): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('decks')
      .select('id, name, list')
      .order('created_at');
    if (error || this.supabase.userId() !== uid) return; // failed, or session moved on
    const decks = ((data ?? []) as unknown[]).filter(isDeck);
    this._decks.set([...decks, ...(await this.migrateLegacy(uid, decks))]);
  }

  /** One-time upload of decks imported back when they lived in localStorage. */
  private async migrateLegacy(uid: string, existing: Deck[]): Promise<Deck[]> {
    try {
      const raw = localStorage.getItem(LEGACY_DECKS_KEY);
      if (!raw) return [];
      const known = new Set(existing.map((d) => d.id));
      const parsed: unknown = JSON.parse(raw);
      const legacy = (Array.isArray(parsed) ? parsed.filter(isDeck) : []).filter(
        (d) => !known.has(d.id),
      );
      if (legacy.length > 0) {
        const { error } = await this.supabase.client.from('decks').insert(
          legacy.map((d) => ({
            id: d.id,
            owner_id: uid,
            name: d.name.trim().slice(0, 60) || 'Unnamed deck',
            list: d.list,
          })),
        );
        if (error) return []; // keep the local copy for a later retry
      }
      localStorage.removeItem(LEGACY_DECKS_KEY);
      return legacy;
    } catch {
      localStorage.removeItem(LEGACY_DECKS_KEY); // corrupt state — discard
      return [];
    }
  }
}
