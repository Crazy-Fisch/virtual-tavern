import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { P2pService } from '../p2p/p2p.service';
import { RoomService } from '../room/room.service';

/**
 * In-room chat overlay, doubling as the game history: user-typed messages are
 * colored, action lines ("<name>: <action>", kind 'action') render plain
 * white. Joining happens at the menu; this assumes an active room.
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

  private readonly logRef = viewChild<ElementRef<HTMLDivElement>>('log');

  constructor() {
    // Keep the log pinned to the newest message (own sends and remote arrivals alike).
    effect(() => {
      this.room.messages();
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
