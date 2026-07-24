import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CardDatabaseService } from '../carddb/card-database.service';
import { DeckStore } from '../decks/deck-store';
import { Deck, deckSize } from '../decks/deck.types';
import { RoomService } from '../room/room.service';
import { AssetLoaderService } from '../scene/asset-loader.service';
import { CardDropTarget, CardInteractions, DRAG_Y } from '../scene/card/card-interactions';
import { CardStore } from '../scene/card/card-store';
import { newCardId } from '../scene/card/card.types';
import { Dialog } from '../shared/dialog/dialog';
import { ZoneStore } from './zone-store';
import { PlayerZones, ZoneCard, ZoneKind } from './zone.types';

/** Screen anchor of the small right-click menu on my deck/graveyard piles. */
type ZoneMenu = { kind: 'deck' | 'graveyard'; x: number; y: number };

/** Fan geometry: per-card tilt shrinks as the hand grows, capped for small hands. */
const MAX_FAN_STEP_DEG = 6;
const FAN_SPREAD_DEG = 42;

/** Cursor travel (CSS px) past which a hand-card press becomes a play drag. */
const HAND_DRAG_THRESHOLD_PX = 4;

/** Breathing room kept beside a scrolled hand so its end cards stay reachable. */
const HAND_SCROLL_MARGIN_PX = 48;

/**
 * The DOM-side zone UI over the scene (plain Angular/HTML, not Three): my hand
 * fanned at the bottom like holding real cards (drag a card onto the table to
 * play it, like a real card — releasing it off the table puts it back in the
 * hand), my deck and graveyard piles with right-click actions
 * (draw/shuffle/examine), and a summary of every other player's zone sizes
 * with examinable graveyards. Rendered inside the Scene component so it can
 * reach the Scene-provided CardStore/CardInteractions when playing a card.
 *
 * Until a player joins the game their zone UI is hidden; a bottom-right
 * "Choose Deck" button opens the picker (decks imported on the Decks screen).
 * Choosing one resolves every entry against the card database, creates the
 * zones with the shuffled deck, and prefetches the card images.
 */
@Component({
  selector: 'app-zones',
  imports: [Dialog],
  templateUrl: './zones.html',
  styleUrl: './zones.scss',
  standalone: true,
  host: { '(document:pointerdown)': 'onDocumentPointerDown($event)' },
})
export class Zones implements OnDestroy {
  protected readonly zones = inject(ZoneStore);
  protected readonly decks = inject(DeckStore);
  protected readonly db = inject(CardDatabaseService);
  private readonly cards = inject(CardStore);
  protected readonly interactions = inject(CardInteractions);
  private readonly assets = inject(AssetLoaderService);
  private readonly room = inject(RoomService);
  protected readonly deckSize = deckSize;

  private readonly handEl = viewChild<ElementRef<HTMLDivElement>>('hand');

  /** Pressed hand card; becomes a play drag past HAND_DRAG_THRESHOLD_PX. */
  private pendingDrag: { card: ZoneCard; x: number; y: number } | null = null;

  protected readonly menu = signal<ZoneMenu | null>(null);
  /** Uid of the player whose graveyard is being examined, or null. */
  protected readonly examiningUid = signal<string | null>(null);
  /** Whether the "Choose Deck" picker dialog is open. */
  protected readonly choosingDeck = signal(false);
  /** Horizontal shift (px) of the fanned hand, so a large hand can be scrolled. */
  protected readonly handScroll = signal(0);

  /**
   * A card dropped over a zone's UI is routed there instead of onto the table.
   * Hit-tested via elementFromPoint so it works regardless of which zone
   * widgets are currently rendered; only active once I've joined the game.
   */
  private readonly dropTargets: CardDropTarget[] = (['deck', 'graveyard', 'hand'] as const).map(
    (kind) => ({
      hitTest: (x, y) => this.overZone(x, y, kind),
      accept: (card) => this.zones.takeFromTable(card, kind),
    }),
  );

  protected readonly examining = computed<PlayerZones | null>(() => {
    const uid = this.examiningUid();
    return uid ? (this.zones.all().find((p) => p.uid === uid) ?? null) : null;
  });

  protected readonly isMine = computed(() => this.examiningUid() === this.zones.mine().uid);

  constructor() {
    // A rejoin refreshes my display name on zones I already have; a fresh
    // player has none until they choose a deck (the game UI stays hidden).
    // The tavern guard guarantees the room (and its world snapshot) is loaded
    // before the scene tree mounts.
    this.zones.refreshOwnerName();
    for (const target of this.dropTargets) this.interactions.registerDropTarget(target);
  }

  /**
   * Join the game with a deck: resolve every decklist entry against the card
   * database (image + canonical name), create my zones with the shuffled
   * deck, and start warming the image caches for every card in it.
   */
  protected chooseDeck(deck: Deck): void {
    const cards = deck.list.flatMap((entry) => {
      const record = this.db.lookup(entry.card);
      return Array.from({ length: entry.count }, (): ZoneCard => {
        return {
          id: crypto.randomUUID(),
          name: record?.name ?? entry.card,
          src: record?.src ?? '',
        };
      });
    });
    this.zones.loadDeck(cards);
    this.choosingDeck.set(false);
    const srcs = new Set(cards.map((c) => c.src));
    srcs.delete('');
    for (const src of srcs) void this.assets.loadTexture(src).catch(() => undefined);
  }

  /** Arrange hand cards in an arc (rotation about a pivot below the hand). */
  protected fan(index: number, total: number): string {
    const step = Math.min(MAX_FAN_STEP_DEG, FAN_SPREAD_DEG / Math.max(total, 1));
    return `rotate(${(index - (total - 1) / 2) * step}deg)`;
  }

  ngOnDestroy(): void {
    this.clearPendingDrag();
    for (const target of this.dropTargets) this.interactions.unregisterDropTarget(target);
  }

  /** CSS transform positioning the fanned hand, including any scroll shift. */
  protected handTransform(): string {
    return `translateX(calc(-50% + ${this.handScroll()}px))`;
  }

  /**
   * Wheel over the hand scrolls it sideways (deltaY → horizontal), so a hand
   * too wide to fit can be panned to reveal cards clipped past the edges.
   */
  protected onHandWheel(event: WheelEvent): void {
    const el = this.handEl()?.nativeElement;
    if (!el) return;
    const overflow = el.offsetWidth - window.innerWidth + HAND_SCROLL_MARGIN_PX;
    if (overflow <= 0) {
      if (this.handScroll() !== 0) this.handScroll.set(0);
      return;
    }
    event.preventDefault();
    const max = overflow / 2;
    this.handScroll.set(Math.max(-max, Math.min(max, this.handScroll() - event.deltaY)));
  }

  /** True when the screen point sits over one of my zone widgets. */
  private overZone(x: number, y: number, kind: ZoneKind): boolean {
    if (!this.zones.hasMine()) return false;
    const selector =
      kind === 'deck' ? '.pile.deck' : kind === 'graveyard' ? '.pile.grave' : '.hand';
    const el = document.elementFromPoint(x, y);
    return el instanceof Element && !!el.closest(selector);
  }

  /**
   * Press on a hand card: arm a play drag. The card only leaves the hand once
   * the cursor travels past the threshold (an accidental click does nothing);
   * the drag itself is then handed to CardInteractions like any table drag.
   */
  protected startDrag(event: PointerEvent, card: ZoneCard): void {
    if (event.button !== 0) return;
    event.preventDefault(); // no native image drag / text selection
    this.pendingDrag = { card, x: event.clientX, y: event.clientY };
    // Manual listeners (not host bindings): document-wide pointermove is only
    // interesting for the few frames between press and drag hand-off.
    document.addEventListener('pointermove', this.onPendingDragMove);
    document.addEventListener('pointerup', this.onPendingDragEnd);
  }

  private readonly onPendingDragMove = (event: PointerEvent): void => {
    const pending = this.pendingDrag;
    if (!pending) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < HAND_DRAG_THRESHOLD_PX) {
      return;
    }
    this.clearPendingDrag();
    this.beginPlay(pending.card, event);
  };

  private readonly onPendingDragEnd = (): void => {
    this.clearPendingDrag();
  };

  private clearPendingDrag(): void {
    this.pendingDrag = null;
    document.removeEventListener('pointermove', this.onPendingDragMove);
    document.removeEventListener('pointerup', this.onPendingDragEnd);
  }

  /**
   * Play a hand card by dragging it onto the table: the card leaves the hand
   * and floats under the cursor; releasing it over the table commits the play
   * (that's when the history line is posted), anywhere else returns it to the
   * hand as if never played.
   */
  private beginPlay(card: ZoneCard, event: PointerEvent): void {
    const taken = this.zones.playFromHand(card.id);
    if (!taken) return;
    const id = newCardId();
    this.cards.add({
      id,
      name: taken.name,
      // A card put into play resolves missing art against the card database
      // (e.g. imported while the database was still downloading).
      src: taken.src || (this.db.lookup(taken.name)?.src ?? ''),
      position: [0, DRAG_Y, 0],
      yaw: this.room.seatYaw(),
      faceUp: true,
      tapped: false,
      relatedIds: [],
    });
    this.interactions.beginDragFromHand(id, event, {
      commit: () => this.room.sendAction(`played ${taken.name}`),
      revert: () => {
        this.cards.remove(id);
        this.zones.addCard('hand', taken);
      },
    });
  }

  protected openMenu(event: MouseEvent, kind: 'deck' | 'graveyard'): void {
    event.preventDefault();
    event.stopPropagation();
    const host = (event.currentTarget as HTMLElement).closest('app-zones')!;
    const rect = host.getBoundingClientRect();
    this.menu.set({ kind, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  protected draw(): void {
    this.menu.set(null);
    this.zones.draw();
  }

  protected shuffle(): void {
    this.menu.set(null);
    this.zones.shuffle();
  }

  protected examine(uid: string): void {
    this.menu.set(null);
    this.examiningUid.set(uid);
  }

  protected toHand(card: ZoneCard): void {
    this.zones.takeToHand('graveyard', card.id);
  }

  /** Close the pile menu when clicking anywhere outside it. */
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.zone-menu')) {
      this.menu.set(null);
    }
  }
}
