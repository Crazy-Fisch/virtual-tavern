import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { P2pService } from '../p2p/p2p.service';
import { RoomService } from '../room/room.service';

/**
 * In-room chat overlay with two tabs (stabilityandimprovements.md "chat &
 * history"): **Chat** (default) shows the user-typed messages, **History** the
 * game's action lines ("<name>: <action>", kind 'action') — separated so card
 * actions never drown out the conversation. Joining happens at the menu; this
 * assumes an active room.
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

  private readonly logRef = viewChild<ElementRef<HTMLDivElement>>('log');

  constructor() {
    // Keep the log pinned to the newest message (own sends, remote arrivals,
    // and tab switches alike).
    effect(() => {
      this.visible();
      const el = this.logRef()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
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
