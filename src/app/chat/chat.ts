import {
  Component,
  OnDestroy,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { P2pService } from '../p2p/p2p.service';
import { RoomService } from '../room/room.service';
import { ChatMessage } from '../room/room.types';
import { Dialog } from '../shared/dialog/dialog';

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
  imports: [FormsModule, Dialog],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
  standalone: true,
})
export class Chat implements OnDestroy {
  protected readonly room = inject(RoomService);
  protected readonly p2p = inject(P2pService);
  private readonly router = inject(Router);
  protected readonly draft = signal('');
  /** Which log is shown; chat is the default. */
  protected readonly tab = signal<'chat' | 'history'>('chat');

  /** The messages of the active tab: typed chat, or the action history since the last new round (the barrier line included). */
  protected readonly visible = computed(() => {
    const all = this.room.messages();
    if (this.tab() !== 'history') return all.filter((m) => m.kind !== 'action');
    const barrier = this.room.historyStart();
    const at = barrier ? all.findIndex((m) => m.id === barrier.msgId) : -1;
    return all.filter(
      (m, i) => m.kind === 'action' && (!barrier || (at >= 0 ? i >= at : m.t >= barrier.t)),
    );
  });

  /** History line the user asked to undo back to; set while the confirmation is open. */
  protected readonly undoTarget = signal<ChatMessage | null>(null);

  /** Undoable action lines, oldest first. */
  private readonly undoableLines = computed(() => {
    const ids = this.room.undoable();
    return this.room.messages().filter((m) => m.kind === 'action' && ids.has(m.id));
  });

  /** The newest undoable action line, target of the 'Undo last' button. */
  protected readonly lastUndoable = computed(() => this.undoableLines().at(-1) ?? null);

  /** How many actions confirming the open undo dialog would undo. */
  protected readonly undoCount = computed(() => {
    const target = this.undoTarget();
    if (!target) return 0;
    const lines = this.undoableLines();
    const at = lines.findIndex((m) => m.id === target.id);
    return at < 0 ? 0 : lines.length - at;
  });

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

  ngOnDestroy(): void {
    clearTimeout(this.copyTimer);
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

  protected askUndo(m: ChatMessage): void {
    this.undoTarget.set(m);
  }

  protected confirmUndo(): void {
    const target = this.undoTarget();
    this.undoTarget.set(null);
    if (target) this.room.undoTo(target.id);
  }

  /** Leave the room and return to the menu. */
  protected leave(): void {
    this.room.leave();
    void this.router.navigate(['/']);
  }

  /** True for a moment after the room code was copied. */
  protected readonly copied = signal(false);
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  protected async copyCode(code: string): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      ok = this.copyFallback(code);
    }
    if (!ok) return;
    this.copied.set(true);
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copied.set(false), 1500);
  }

  private copyFallback(code: string): boolean {
    const input = document.createElement('input');
    input.value = code;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      input.remove();
    }
  }

  protected send(e: Event): void {
    e.preventDefault();
    this.room.sendChat(this.draft());
    this.draft.set('');
  }
}
