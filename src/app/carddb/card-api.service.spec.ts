import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SupabaseService } from '../supabase/supabase.service';
import { CardApiService, normalizeApiUrl } from './card-api.service';

const TEMP_KEY = 'virtual-tavern.card-api';

type FakeSession = { user: { id: string; is_anonymous: boolean; user_metadata: Record<string, unknown> } };

function sessionFor(anonymous: boolean, metadata: Record<string, unknown> = {}): FakeSession {
  return { user: { id: 'user-1', is_anonymous: anonymous, user_metadata: metadata } };
}

describe('CardApiService', () => {
  let session: WritableSignal<FakeSession | null>;
  let setCardApiUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    session = signal<FakeSession | null>(null);
    // Mirrors the real behaviour: updateUser lands in user_metadata and the
    // session signal refreshes (USER_UPDATED).
    setCardApiUrl = vi.fn(async (url: string) => {
      session.set(sessionFor(false, { card_api_url: url }));
      return null;
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SupabaseService,
          useValue: {
            session,
            userId: () => session()?.user.id ?? null,
            isGuest: () => session()?.user.is_anonymous ?? false,
            setCardApiUrl,
          },
        },
      ],
    });
  });

  const init = () => TestBed.inject(CardApiService);

  it('nothing is configured while signed out or before any deposit', () => {
    const service = init();
    expect(service.configured()).toBe(false);
    session.set(sessionFor(true));
    expect(service.apiUrl()).toBeNull();
  });

  it('a guest deposit is kept for the browser session only (sessionStorage)', async () => {
    session.set(sessionFor(true));
    const service = init();
    expect(await service.setApiUrl(' https://api.example.com/ ')).toBeNull();
    expect(service.apiUrl()).toBe('https://api.example.com');
    expect(sessionStorage.getItem(TEMP_KEY)).toBe('https://api.example.com');
    expect(setCardApiUrl).not.toHaveBeenCalled();
  });

  it("a registered user's deposit goes into the account info (user_metadata)", async () => {
    session.set(sessionFor(false));
    const service = init();
    expect(await service.setApiUrl('https://api.example.com')).toBeNull();
    expect(setCardApiUrl).toHaveBeenCalledWith('https://api.example.com');
    expect(service.apiUrl()).toBe('https://api.example.com');
    expect(sessionStorage.getItem(TEMP_KEY)).toBeNull(); // not a guest deposit
  });

  it('rejects text that is not a usable URL', async () => {
    session.set(sessionFor(true));
    const service = init();
    expect(await service.setApiUrl('not a url')).toMatch(/base URL/);
    expect(await service.setApiUrl('ftp://files.example.com')).toMatch(/base URL/);
    expect(service.configured()).toBe(false);
  });

  it('a guest deposit follows the guest into a freshly registered account', async () => {
    sessionStorage.setItem(TEMP_KEY, 'https://api.example.com');
    session.set(sessionFor(false)); // registered, but no card_api_url metadata yet
    const service = init();
    await vi.waitFor(() =>
      expect(setCardApiUrl).toHaveBeenCalledWith('https://api.example.com'),
    );
    expect(service.apiUrl()).toBe('https://api.example.com');
    await vi.waitFor(() => expect(sessionStorage.getItem(TEMP_KEY)).toBeNull());
  });

  it('normalizeApiUrl trims, strips trailing slashes, and rejects non-http(s)', () => {
    expect(normalizeApiUrl(' https://api.example.com// ')).toBe('https://api.example.com');
    expect(normalizeApiUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeApiUrl('ftp://x')).toBeNull();
    expect(normalizeApiUrl('api.example.com')).toBeNull();
    expect(normalizeApiUrl('')).toBeNull();
  });
});
