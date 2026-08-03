import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { RoomService } from '../room/room.service';
import { SupabaseService } from '../supabase/supabase.service';
import { Dialog } from '../shared/dialog/dialog';

/** Landing screen: sign in (email or guest), then create/join a room, plus settings. */
@Component({
  selector: 'app-menu',
  imports: [FormsModule, RouterLink, Dialog],
  templateUrl: './menu.html',
  styleUrl: './menu.scss',
  standalone: true,
})
export class Menu {
  protected readonly supabase = inject(SupabaseService);
  private readonly room = inject(RoomService);
  private readonly router = inject(Router);

  protected readonly dialog = signal<'auth' | 'play' | 'settings' | null>(null);
  /** Active tab of the auth dialog (login / sign up as tabs, guest below both). */
  protected readonly authTab = signal<'signin' | 'signup'>('signin');
  /** Active tab of the play dialog (join room / create room). */
  protected readonly playTab = signal<'join' | 'create'>('join');

  // Auth form
  protected readonly email = signal('');
  protected readonly password = signal('');
  /** Username chosen when creating an account (used everywhere; guests type a name per room instead). */
  protected readonly username = signal('');

  // Play form
  protected readonly name = signal('');
  protected readonly joinCode = signal('');
  protected readonly roomName = signal('');

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  // Sample settings (not persisted yet)
  protected readonly volume = signal(70);
  protected readonly showNameTags = signal(true);
  protected readonly sensitivity = signal(50);

  protected openAuth(): void {
    this.error.set(null);
    this.authTab.set('signin');
    this.dialog.set('auth');
  }

  protected openPlay(): void {
    this.error.set(null);
    this.playTab.set('join');
    if (!this.name()) this.name.set(this.supabase.displayName());
    this.dialog.set('play');
  }

  /** Switch a dialog tab; an error from the other tab's form no longer applies. */
  protected showAuthTab(tab: 'signin' | 'signup'): void {
    this.error.set(null);
    this.authTab.set(tab);
  }

  protected showPlayTab(tab: 'join' | 'create'): void {
    this.error.set(null);
    this.playTab.set(tab);
  }

  protected openSettings(): void {
    this.dialog.set('settings');
  }

  protected closeDialog(): void {
    this.dialog.set(null);
  }

  protected signIn(): Promise<void> {
    return this.runAuth(() => this.supabase.signIn(this.email().trim(), this.password()));
  }

  protected signUp(): Promise<void> {
    return this.runAuth(() =>
      this.supabase.signUp(this.email().trim(), this.password(), this.username()),
    );
  }

  protected continueAsGuest(): Promise<void> {
    return this.runAuth(() => this.supabase.signInAsGuest());
  }

  protected async signOut(): Promise<void> {
    await this.supabase.signOut();
  }

  protected joinRoom(): Promise<void> {
    return this.runPlay(() => this.room.joinByCode(this.joinCode(), this.playName()));
  }

  protected createRoom(): Promise<void> {
    return this.runPlay(() => this.room.createRoom(this.roomName(), this.playName()));
  }

  /** Registered players always play under their username; only guests type a per-room name. */
  private playName(): string {
    return this.supabase.isGuest() ? this.name() : this.supabase.displayName();
  }

  private async runAuth(fn: () => Promise<string | null>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const err = await fn();
    this.busy.set(false);
    if (err) {
      this.error.set(err);
      return;
    }
    this.password.set('');
    // Land on the menu (not straight into the Play dialog) so the player can
    // pick Play, Decks, or Settings after signing in.
    this.dialog.set(null);
  }

  private async runPlay(fn: () => Promise<string | null>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const err = await fn();
    this.busy.set(false);
    if (err) {
      this.error.set(err);
      return;
    }
    this.dialog.set(null);
    void this.router.navigate(['/tavern']);
  }
}
