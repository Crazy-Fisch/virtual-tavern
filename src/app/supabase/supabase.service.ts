import { Injectable, computed, signal } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

/**
 * Thin signal wrapper around the single Supabase client. Owns the auth session;
 * data access (rooms/chat/world) lives in RoomService.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly client: SupabaseClient = createClient(environment.supabaseUrl, environment.supabaseKey);

  private readonly _session = signal<Session | null>(null);

  readonly session = this._session.asReadonly();
  readonly userId = computed(() => this._session()?.user.id ?? null);
  readonly displayName = computed(
    () => (this._session()?.user.user_metadata['display_name'] as string | undefined) ?? '',
  );
  readonly isGuest = computed(() => this._session()?.user.is_anonymous ?? false);

  /** Restore the persisted session before first render (wired via provideAppInitializer). */
  async init(): Promise<void> {
    this.client.auth.onAuthStateChange((_event, session) => this._session.set(session));
    const { data } = await this.client.auth.getSession();
    this._session.set(data.session);
  }

  /**
   * Create an account, choosing the username shown everywhere (stored as
   * display_name in user_metadata, so the account is never "Guest"). No
   * uniqueness check — duplicates are tolerated. Signed in immediately (email
   * confirmation is off). Returns an error message, or null on success.
   */
  async signUp(email: string, password: string, username: string): Promise<string | null> {
    const { error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { display_name: username.trim().slice(0, 16) } },
    });
    return error?.message ?? null;
  }

  async signIn(email: string, password: string): Promise<string | null> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  /** Anonymous session — same uid persists, so a later email upgrade keeps chat attribution. */
  async signInAsGuest(): Promise<string | null> {
    const { error } = await this.client.auth.signInAnonymously();
    return error?.message ?? null;
  }

  /** Stored in auth user_metadata and denormalized onto chat rows as sender_name. */
  async setDisplayName(name: string): Promise<void> {
    await this.client.auth.updateUser({ data: { display_name: name } });
  }

  /**
   * A registered user's card-API base URL lives in their account info (auth
   * user_metadata) — see CardApiService, which owns the guest/session logic.
   * Returns an error message, or null on success.
   */
  async setCardApiUrl(url: string): Promise<string | null> {
    const { error } = await this.client.auth.updateUser({ data: { card_api_url: url } });
    return error?.message ?? null;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }
}
