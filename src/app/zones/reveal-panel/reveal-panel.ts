import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Dialog } from '../../shared/dialog/dialog';
import { ZoneStore } from '../zone-store';
import {
  REVEAL_TARGETS,
  REVEAL_TARGET_LABELS,
  RevealSession,
  RevealTarget,
  canUndo,
  currentState,
  isPending,
  place,
  placedIn,
  revealAction,
  revealZones,
  startReveal,
  undo,
} from '../reveal';
import { ZoneCard } from '../zone.types';

/** A card being dragged out of the grid, and where the cursor has it. */
interface RevealDrag {
  card: ZoneCard;
  x: number;
  y: number;
}

/** Cursor travel (CSS px) past which a press on a revealed card becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * The scry window (newmechanics.md "scrying & other actions"): the top cards of
 * my deck laid out first (top-left) to last (bottom-right), each draggable onto
 * one of four zones — hand, deck (top), bottom, graveyard — with an undo that
 * walks back to the moment the reveal started.
 *
 * The cards are shown to **me only**; the history records that a look happened
 * and, for the open graveyard, what landed there — never what was on top of the
 * deck. Every placement is committed straight away through `ZoneStore`
 * (one batched write of deck + hand + graveyard), so nothing depends on this
 * dialog surviving: cards not yet placed are still in the deck where they were,
 * and closing the panel simply stops.
 */
@Component({
  selector: 'app-reveal-panel',
  imports: [Dialog],
  templateUrl: './reveal-panel.html',
  styleUrl: './reveal-panel.scss',
  standalone: true,
})
export class RevealPanel {
  /** The revealed cards, peeked (and logged) by the caller. */
  readonly cards = input.required<ZoneCard[]>();
  readonly close = output<void>();

  private readonly zones = inject(ZoneStore);

  protected readonly targets = REVEAL_TARGETS;
  protected readonly targetLabels = REVEAL_TARGET_LABELS;

  private readonly session = signal<RevealSession | null>(null);
  /** The card under the cursor mid-drag, or null. */
  protected readonly dragging = signal<RevealDrag | null>(null);
  /** Drop zone the cursor is currently over, highlighted while dragging. */
  protected readonly hovered = signal<RevealTarget | null>(null);

  /** Press that has not yet travelled far enough to be a drag. */
  private pending: RevealDrag | null = null;

  protected readonly canUndo = computed(() => {
    const session = this.session();
    return session ? canUndo(session) : false;
  });

  /** Grid slots: every revealed card, with the ones already placed marked. */
  protected readonly slots = computed(() => {
    const session = this.session();
    if (!session) return [];
    return session.cards.map((card) => ({ card, placed: !isPending(session, card.id) }));
  });

  /** How many revealed cards are still waiting for a decision. */
  protected readonly left = computed(() => {
    const session = this.session();
    return session ? currentState(session).pending.length : 0;
  });

  constructor() {
    // Seed the session once, from the zones as they stand right now. Untracked:
    // every placement rewrites those zones, and re-seeding on our own writes
    // would throw the undo stack away.
    effect(() => {
      const cards = this.cards();
      untracked(() => {
        const mine = this.zones.mine();
        this.session.set(startReveal(mine.deck, cards.length, mine.hand, mine.graveyard));
      });
    });
  }

  /** Cards routed to a zone so far — the thumbnails inside each drop box. */
  protected placed(target: RevealTarget): readonly ZoneCard[] {
    const session = this.session();
    return session ? placedIn(session, target) : [];
  }

  // ---------- dragging a revealed card onto a zone ----------

  protected startDrag(event: PointerEvent, card: ZoneCard, placed: boolean): void {
    if (event.button !== 0 || placed) return;
    event.preventDefault(); // no native image drag / text selection
    this.pending = { card, x: event.clientX, y: event.clientY };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  private readonly onMove = (event: PointerEvent): void => {
    const drag = this.dragging();
    if (!drag) {
      const pending = this.pending;
      if (!pending) return;
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_THRESHOLD_PX) {
        return;
      }
      this.dragging.set({ ...pending, x: event.clientX, y: event.clientY });
      return;
    }
    this.dragging.set({ ...drag, x: event.clientX, y: event.clientY });
    this.hovered.set(this.targetAt(event.clientX, event.clientY));
  };

  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.dragging();
    const target = drag ? this.targetAt(event.clientX, event.clientY) : null;
    this.endDrag();
    if (drag && target) this.drop(drag.card, target);
  };

  private endDrag(): void {
    this.pending = null;
    this.dragging.set(null);
    this.hovered.set(null);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  }

  /** Which drop box (if any) the cursor is over — the ghost never blocks this
   * hit test, it is drawn pointer-events: none. */
  private targetAt(x: number, y: number): RevealTarget | null {
    const el = document.elementFromPoint(x, y);
    const box = el instanceof Element ? el.closest('[data-target]') : null;
    const target = box?.getAttribute('data-target');
    return REVEAL_TARGETS.find((t) => t === target) ?? null;
  }

  /** Route a card and commit the step (deck + hand + graveyard in one write). */
  private drop(card: ZoneCard, target: RevealTarget): void {
    const session = this.session();
    if (!session) return;
    const next = place(session, card.id, target);
    if (next === session) return; // already placed (a stale drop)
    this.session.set(next);
    this.zones.applyReveal(revealZones(next), revealAction(target, card));
  }

  protected undoLast(): void {
    const session = this.session();
    if (!session || !canUndo(session)) return;
    const next = undo(session);
    this.session.set(next);
    this.zones.applyReveal(revealZones(next), 'took back their last reveal move');
  }

  protected done(): void {
    this.endDrag();
    this.close.emit();
  }
}
