import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { P2pService } from '../p2p/p2p.service';
import { RoomService } from '../room/room.service';

const COLLAPSED_KEY = 'virtual-tavern.chat-collapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * In-room chat panel with two tabs (stabilityandimprovements.md "chat &
 * history"): **Chat** (default) shows the user-typed messages, **History** the
 * game's action lines ("<name>: <action>", kind 'action') — separated so card
 * actions never drown out the conversation. Joining happens at the menu; this
 * assumes an active room. It docks left of the table and folds into a slim bar
 * (remembered in localStorage) that shows how many chat messages from others
 * arrived since it was folded; the table takes the freed width.
 */
@Component({
  selector: 'app-chat',
  imports: [FormsModule],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
  standalone: true,
})
export class Chat {
  protected readonly room = inject(RoomService);
  protected readonly p2p = inject(P2pService);
  private readonly router = inject(Router);
  protected readonly draft = signal('');
  /** Which log is shown; chat is the default. */
  protected readonly tab = signal<'chat' | 'history'>('chat');

  /** The messages of the active tab: typed chat, or the action history. */
  protected readonly visible = computed(() =>
    this.room
      .messages()
      .filter((m) => (this.tab() === 'history' ? m.kind === 'action' : m.kind !== 'action')),
  );

  /** Whether the panel is folded into the slim bar; persisted across reloads. */
  protected readonly collapsed = signal(loadCollapsed());
  /** How many messages existed when the panel was last open (or on mount). */
  private readonly seen = signal(this.room.messages().length);

  /** Chat messages from others that arrived while folded (shown on the bar). */
  protected readonly unread = computed(() => {
    if (!this.collapsed()) return 0;
    const me = this.room.userId();
    return this.room
      .messages()
      .slice(this.seen())
      .filter((m) => m.kind !== 'action' && m.from !== me).length;
  });

  private readonly logRef = viewChild<ElementRef<HTMLDivElement>>('log');

  constructor() {
    effect(() => {
      const count = this.room.messages().length;
      if (!this.collapsed()) this.seen.set(count);
    });

    // Keep the log pinned to the newest message (own sends, remote arrivals,
    // and tab switches alike).
    effect(() => {
      this.visible();
      const el = this.logRef()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected toggle(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // storage unavailable: the fold just isn't remembered
    }
  }

  /** Leave the room and return to the menu. */
  protected leave(): void {
    this.room.leave();
    void this.router.navigate(['/']);
  }

  protected send(e: Event): void {
    e.preventDefault();
    this.room.sendChat(this.draft());
    this.draft.set('');
  }
}
