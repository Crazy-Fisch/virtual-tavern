import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CardPrintService } from '../carddb/card-print.service';
import { SupabaseService } from '../supabase/supabase.service';
import { BuiltInDecks } from './built-in-decks';
import { Deck, DeckEntry, DeckPrint, isBuiltInDeck, printKey } from './deck.types';
import { parseDecklist } from './decklist-parser';

/** Per-browser localStorage key holding a guest's decks (also the legacy key). */
const LOCAL_DECKS_KEY = 'virtual-tavern.decks';

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

function mergeEntries(list: DeckEntry[]): DeckEntry[] {
  const merged = new Map<string, DeckEntry>();
  for (const entry of list) {
    const key = `${entry.card.toLowerCase()}|${printKey(entry.print)}`;
    const existing = merged.get(key);
    if (existing) existing.count += entry.count;
    else merged.set(key, { ...entry });
  }
  return [...merged.values()];
}

function cleanName(name: string): string {
  return name.trim().slice(0, 60) || 'Unnamed deck';
}

/**
 * The player's decks. Storage follows the session: guests keep decks in the
 * browser (localStorage — per-device, lost if the browser is cleared, which is
 * acceptable); signed-in accounts persist them in Supabase (`decks` table,
 * owner-only RLS). Signing into an account uploads any local guest decks into
 * that account once (`syncLocalToAccount`), so a guest who registers keeps what
 * they built. The Decks page creates, renames, and deletes decks here, and the
 * in-room deck chooser reads them when a player sits down at the table.
 *
 * On top of the player's own decks sit the **built-in** ones shipped with the
 * app (`BuiltInDecks`, `designdocs/defaultdecks.md`). They are merged in at read
 * time rather than copied into anyone's storage, so a decklist added to
 * `public/decks/` later reaches existing users too — and they are read-only
 * here: rename and remove ignore them, since there is nothing of theirs to
 * write.
 */
@Injectable({ providedIn: 'root' })
export class DeckStore {
  private readonly supabase = inject(SupabaseService);
  private readonly builtIn = inject(BuiltInDecks);
  private readonly prints = inject(CardPrintService);

  /** The player's own decks — what localStorage / the `decks` table holds. */
  private readonly _decks = signal<Deck[]>([]);
  readonly ownDecks = this._decks.asReadonly();

  /** Everything the player can pick from: the shipped decks, then their own. */
  readonly decks = computed<Deck[]>(() => [...this.builtIn.decks(), ...this._decks()]);

  /** Whether this session can keep decks at all — anyone signed in (guest or account). */
  readonly available = computed(() => !!this.supabase.userId());

  /** True when decks persist to the cloud account (signed in, not a guest). */
  private readonly onAccount = computed(() => !!this.supabase.userId() && !this.supabase.isGuest());

  constructor() {
    // Follow the session: load the account's decks on sign-in (merging any
    // local guest decks), read local decks for a guest, and clear on sign-out.
    effect(() => {
      const uid = this.supabase.userId();
      const account = this.onAccount();
      untracked(() => {
        if (!uid) {
          this._decks.set([]);
        } else if (account) {
          this._decks.set([]);
          void this.loadAccount(uid);
        } else {
          this._decks.set(this.readLocal());
        }
      });
    });
  }

  /**
   * Parse a pasted decklist and store it (locally for guests, on the account
   * otherwise). Returns an error message, or null on success.
   */
  async import(name: string, decklist: string): Promise<string | null> {
    if (!this.available()) return 'Sign in (or continue as a guest) to keep decks.';
    const parsed = parseDecklist(decklist);
    if (parsed.length === 0) return 'No cards found — paste a decklist like “4 Lightning Bolt”.';
    const list = await this.prints.resolveEntries(parsed);
    const deck: Deck = { id: crypto.randomUUID(), name: cleanName(name), list };
    // Optimistic append, rolled back if the account insert fails.
    this._decks.update((decks) => [...decks, deck]);
    if (this.onAccount()) {
      const { error } = await this.supabase.client.from('decks').insert({
        id: deck.id,
        owner_id: this.supabase.userId(),
        name: deck.name,
        list: deck.list,
      });
      if (error) {
        this._decks.update((decks) => decks.filter((d) => d.id !== deck.id));
        return error.message;
      }
    } else {
      this.persistLocal();
    }
    return null;
  }

  /** Rename a deck, persisting to whichever store backs this session. A deck
   * shipped with the app has no writable copy, so it cannot be renamed. */
  rename(id: string, name: string): void {
    if (isBuiltInDeck(id)) return;
    const clean = cleanName(name);
    this._decks.update((decks) => decks.map((d) => (d.id === id ? { ...d, name: clean } : d)));
    if (this.onAccount())
      void this.supabase.client.from('decks').update({ name: clean }).eq('id', id);
    else this.persistLocal();
  }

  /**
   * Choose the artwork of `count` copies (default: the whole line) of the entry
   * at `index`, or clear the choice with `print` undefined. Copies split off
   * into their own line, and a line that ends up with the same card and print as
   * another merges into it. Built-in decks cannot be changed.
   */
  setPrint(id: string, index: number, print: DeckPrint | undefined, count?: number): void {
    if (isBuiltInDeck(id)) return;
    const deck = this._decks().find((d) => d.id === id);
    const entry = deck?.list[index];
    if (!deck || !entry) return;
    const moved = Math.min(Math.max(count ?? entry.count, 1), entry.count);
    const rest = entry.count - moved;
    const changed: DeckEntry = { card: entry.card, count: moved, ...(print ? { print } : {}) };
    const list: DeckEntry[] = deck.list.flatMap((e, i) => {
      if (i !== index) return [e];
      return rest > 0 ? [{ ...entry, count: rest }, changed] : [changed];
    });
    this.replaceList(id, mergeEntries(list));
  }

  /**
   * A deck's entries with every imported `(SET) number` resolved to its image
   * (decks imported before a card API was deposited, and the shipped ones).
   * Resolved prints of the player's own decks are saved back to the deck.
   */
  async resolvedList(deck: Deck): Promise<DeckEntry[]> {
    const list = await this.prints.resolveEntries(deck.list);
    if (list !== deck.list && this._decks().some((d) => d.id === deck.id)) {
      this.replaceList(deck.id, list);
    }
    return list;
  }

  private replaceList(id: string, list: DeckEntry[]): void {
    this._decks.update((decks) => decks.map((d) => (d.id === id ? { ...d, list } : d)));
    if (this.onAccount()) void this.supabase.client.from('decks').update({ list }).eq('id', id);
    else this.persistLocal();
  }

  /** Delete one of the player's own decks; built-in decks always stay. */
  remove(id: string): void {
    if (isBuiltInDeck(id)) return;
    this._decks.update((decks) => decks.filter((d) => d.id !== id));
    if (this.onAccount()) void this.supabase.client.from('decks').delete().eq('id', id);
    else this.persistLocal();
  }

  private async loadAccount(uid: string): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('decks')
      .select('id, name, list')
      .order('created_at');
    if (error || this.supabase.userId() !== uid) return; // failed, or session moved on
    const account = ((data ?? []) as unknown[]).filter(isDeck);
    const uploaded = await this.syncLocalToAccount(uid, account);
    if (this.supabase.userId() === uid) this._decks.set([...account, ...uploaded]);
  }

  /**
   * Upload local (guest) decks into the freshly signed-in account, then clear
   * the local store. Decks already present on the account (by id) are skipped,
   * so this is safe to run on every account load.
   */
  private async syncLocalToAccount(uid: string, existing: Deck[]): Promise<Deck[]> {
    const known = new Set(existing.map((d) => d.id));
    const local = this.readLocal().filter((d) => !known.has(d.id));
    if (local.length === 0) {
      this.clearLocal();
      return [];
    }
    const { error } = await this.supabase.client
      .from('decks')
      .insert(
        local.map((d) => ({ id: d.id, owner_id: uid, name: cleanName(d.name), list: d.list })),
      );
    if (error) return []; // keep the local copy for a later retry
    this.clearLocal();
    return local;
  }

  private readLocal(): Deck[] {
    try {
      const raw = localStorage.getItem(LOCAL_DECKS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isDeck) : [];
    } catch {
      return [];
    }
  }

  private persistLocal(): void {
    try {
      localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify(this._decks()));
    } catch {
      // Storage unavailable/full — decks simply won't survive a reload.
    }
  }

  private clearLocal(): void {
    try {
      localStorage.removeItem(LOCAL_DECKS_KEY);
    } catch {
      // ignore
    }
  }
}
