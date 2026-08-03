import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

/** sessionStorage key holding a guest's deposited API base URL (temporary). */
const TEMP_API_KEY = 'virtual-tavern.card-api';

/** Trim/validate a deposited URL; returns the normalized base or null. */
export function normalizeApiUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

function readTemp(): string | null {
  try {
    return normalizeApiUrl(sessionStorage.getItem(TEMP_API_KEY) ?? '');
  } catch {
    return null;
  }
}

/**
 * The user-deposited card API (designdocs/legal.md): the app ships without any
 * card-data endpoint of its own — every feature that needs card data (search,
 * the local card database) reads the base URL of a Scryfall-compatible API the
 * user has deposited here, and stays dormant until one exists. Registered
 * users keep the URL in their account info (auth `user_metadata`); guests keep
 * it temporarily, for the browser session only (sessionStorage). A guest's
 * deposit follows them into a freshly registered account, like decks do.
 */
@Injectable({ providedIn: 'root' })
export class CardApiService {
  private readonly supabase = inject(SupabaseService);

  /** A guest's deposit — and, briefly, an account's while updateUser round-trips. */
  private readonly temp = signal<string | null>(readTemp());

  /** The deposited card-API base URL, or null when none has been provided. */
  readonly apiUrl = computed<string | null>(() => {
    const session = this.supabase.session();
    if (!session) return null;
    const account = session.user.is_anonymous
      ? null
      : normalizeApiUrl((session.user.user_metadata['card_api_url'] as string | undefined) ?? '');
    return account ?? this.temp();
  });

  /** Whether any API has been deposited — gates search and the card database. */
  readonly configured = computed(() => this.apiUrl() !== null);

  constructor() {
    // A guest's deposit follows them into a fresh account (decks do the same).
    effect(() => {
      const session = this.supabase.session();
      const temp = this.temp();
      if (!session || session.user.is_anonymous || !temp) return;
      if (session.user.user_metadata['card_api_url']) return;
      untracked(() => void this.supabase.setCardApiUrl(temp).then(() => this.clearTemp()));
    });
  }

  /** Deposit or replace the API base URL. Returns an error message or null. */
  async setApiUrl(raw: string): Promise<string | null> {
    const url = normalizeApiUrl(raw);
    if (!url) return 'Enter the full base URL of a card API, e.g. https://api.example.com';
    if (!this.supabase.userId()) return 'Sign in (or continue as a guest) first.';
    if (!this.supabase.isGuest()) {
      const err = await this.supabase.setCardApiUrl(url);
      if (err) return err;
    }
    // Immediate for the UI; for an account the metadata takes over once the
    // refreshed session lands, for a guest this (plus sessionStorage) is it.
    this.temp.set(url);
    if (this.supabase.isGuest()) {
      try {
        sessionStorage.setItem(TEMP_API_KEY, url);
      } catch {
        // Storage unavailable — the deposit just won't survive a reload.
      }
    }
    return null;
  }

  private clearTemp(): void {
    this.temp.set(null);
    try {
      sessionStorage.removeItem(TEMP_API_KEY);
    } catch {
      // ignore
    }
  }
}
