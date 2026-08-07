import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { CardDatabaseService } from '../carddb/card-database.service';
import { DeckStore } from '../decks/deck-store';
import { Deck, deckSize } from '../decks/deck.types';
import { RoomService } from '../room/room.service';
import { AssetLoaderService } from '../scene/asset-loader.service';
import { CardDropTarget, CardInteractions, DRAG_Y } from '../scene/card/card-interactions';
import { CardStore } from '../scene/card/card-store';
import { CardState, newCardId } from '../scene/card/card.types';
import { HotkeyList } from '../scene/card/hotkey-list/hotkey-list';
import { Dialog } from '../shared/dialog/dialog';
import { RevealPanel } from './reveal-panel/reveal-panel';
import { REVEAL_COUNTS, RevealMode } from './reveal';
import { ZoneStore } from './zone-store';
import { OpenZoneKind, PlayerZones, ZONE_KINDS, ZoneCard, ZoneKind } from './zone.types';

/** Screen anchor of the small right-click menu on my deck/graveyard/exile piles. */
type ZoneMenu = { kind: Exclude<ZoneKind, 'hand'>; x: number; y: number };

/** Which zone is open in the examine dialog. */
type Examining = { uid: string; kind: OpenZoneKind };

/** Right-click menu on one of my hand cards (reveal a single card). */
type HandMenu = { card: ZoneCard; x: number; y: number };

/** A press that is arming a drag — from my hand, or out of one of my open zones. */
type PendingDrag = { card: ZoneCard; x: number; y: number; source: 'hand' | ZoneKind };

/** Fan geometry: per-card tilt shrinks as the hand grows, capped for small hands. */
const MAX_FAN_STEP_DEG = 5;
const FAN_SPREAD_DEG = 36;

/** Cursor travel (CSS px) past which a card-card press becomes a drag. */
const HAND_DRAG_THRESHOLD_PX = 4;

/** At most this many hand cards are laid out at once; the rest scroll into view. */
const MAX_VISIBLE_HAND = 10;
/** Hand-card width in `--u` (150% of the pre-playerui size, per "size" section). */
const HAND_CARD_U = 9.6;
/** Fraction of the viewport width the visible hand may fill (its middle 50%). */
const HAND_MAX_FRACTION = 0.5;

/** Life totals offered before a player has picked a starting total. */
const START_LIVES = [20, 40];

/** CSS class of each zone's widget, for hit-testing a card dropped onto it. */
const ZONE_SELECTORS: Readonly<Record<ZoneKind, string>> = {
  hand: '.hand-clip',
  deck: '.pile.deck',
  graveyard: '.pile.grave',
  exile: '.pile.exile',
};

/**
 * The DOM-side zone UI over the scene (plain Angular/HTML, not Three). Mine is
 * at the bottom — hand fanned like held cards (drag a card onto the table to
 * play it), deck/graveyard/exile piles, a life counter and a reveal-hand toggle
 * — and every other player's zones mirror it at the top: their hand shown as
 * card backs (faces only when they reveal them), their deck as a count, and
 * examinable graveyards/exile, plus their life total. Rendered inside the Scene
 * component so it can reach the Scene-provided CardStore/CardInteractions when
 * playing or dragging a card.
 *
 * Until a player joins the game their own zone UI is hidden; a centred "Choose
 * Deck" button opens the picker (decks imported on the Decks screen). Picking
 * one only *selects* it — the player then confirms (or picks another), and
 * confirming is what creates the zones and starts warming the card images.
 */
@Component({
  selector: 'app-zones',
  imports: [Dialog, RevealPanel, HotkeyList],
  templateUrl: './zones.html',
  styleUrl: './zones.scss',
  standalone: true,
  host: {
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(window:resize)': 'onResize()',
  },
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
  protected readonly startLives = START_LIVES;
  protected readonly maxHand = MAX_VISIBLE_HAND;
  protected readonly revealCounts = REVEAL_COUNTS;

  /** Pressed card; becomes a drag past HAND_DRAG_THRESHOLD_PX. */
  private pendingDrag: PendingDrag | null = null;

  protected readonly menu = signal<ZoneMenu | null>(null);
  /** Right-click menu on one of my hand cards, or null. */
  protected readonly handMenu = signal<HandMenu | null>(null);
  /** The zone being examined (mine or another player's), or null. */
  protected readonly examining = signal<Examining | null>(null);
  /** Whether the "Choose Deck" picker dialog is open. */
  protected readonly choosingDeck = signal(false);
  /** Whether the in-game hotkey reference is open (hotkeys.md). */
  protected readonly showHotkeys = signal(false);
  /** Deck picked but not yet confirmed — nothing is loaded until it is. */
  protected readonly pendingDeck = signal<Deck | null>(null);
  /** Horizontal shift (px) of the fanned hand, so a large hand can be scrolled. */
  protected readonly handScroll = signal(0);
  /** Whether the deck menu's Reveal row has its 1-5/X choices expanded. */
  protected readonly revealOpen = signal(false);
  /** The "X" count being typed into the reveal row. */
  protected readonly revealDraft = signal('');
  /** What the deck-viewing panel is showing, or null when it is closed. */
  protected readonly revealing = signal<{ cards: ZoneCard[]; mode: RevealMode } | null>(null);
  /** Viewport size, tracked so the hand geometry re-fits on resize. */
  private readonly viewport = signal({ w: window.innerWidth, h: window.innerHeight });

  /** True when every card in my hand is currently revealed to the other players. */
  protected readonly allRevealed = computed(() => {
    const hand = this.zones.mine().hand;
    return hand.length > 0 && hand.every((c) => c.revealed);
  });

  /**
   * A card dropped over a zone's UI is routed there instead of onto the table.
   * Hit-tested via elementFromPoint so it works regardless of which zone
   * widgets are currently rendered; only active once I've joined the game.
   */
  private readonly dropTargets: CardDropTarget[] = ZONE_KINDS.map((kind) => ({
    hitTest: (x, y) => this.overZone(x, y, kind),
    accept: (card) => this.zones.takeFromTable(card, kind),
  }));

  /** The player whose zone the examine dialog shows. */
  protected readonly examined = computed<PlayerZones | null>(() => {
    const open = this.examining();
    return open ? (this.zones.all().find((p) => p.uid === open.uid) ?? null) : null;
  });

  /** Cards listed by the examine dialog (graveyard or exile). */
  protected readonly examinedCards = computed<ZoneCard[]>(() => {
    const open = this.examining();
    const player = this.examined();
    return open && player ? player[open.kind] : [];
  });

  protected readonly isMine = computed(() => this.examining()?.uid === this.zones.mine().uid);

  constructor() {
    // A rejoin refreshes my display name on zones I already have; a fresh
    // player has none until they choose a deck (the game UI stays hidden).
    // The tavern guard guarantees the room (and its world snapshot) is loaded
    // before the scene tree mounts.
    this.zones.refreshOwnerName();
    for (const target of this.dropTargets) this.interactions.registerDropTarget(target);
  }

  ngOnDestroy(): void {
    this.clearPendingDrag();
    this.interactions.hoveredHandCard.set(null);
    for (const target of this.dropTargets) this.interactions.unregisterDropTarget(target);
  }

  /**
   * Tell CardInteractions which hand card the cursor is over, so its keyboard
   * layer can act on it — `v` views a hand card exactly like a table card
   * (finaltouches.md "hand view"). Scene hover picking is a raycast and cannot
   * see these DOM cards, hence the hand-off.
   */
  protected hoverHandCard(card: ZoneCard | null): void {
    // Its second face, if it has one, comes from the card database like the
    // related names do — so `v` over a double-faced hand card can flip it too.
    this.interactions.hoveredHandCard.set(
      card ? { name: card.name, src: card.src, back: this.db.lookup(card.name)?.back } : null,
    );
  }

  protected onResize(): void {
    this.viewport.set({ w: window.innerWidth, h: window.innerHeight });
  }

  /**
   * Show the hotkey reference without leaving the table (hotkeys.md). Opening
   * it drops whatever the cursor was last over: the dialog covers the canvas,
   * so hover picking stops updating, and a player trying out the keys they are
   * reading about must not act on a stale hover behind the panel.
   */
  protected openHotkeys(): void {
    this.interactions.hoveredId.set(null);
    this.interactions.hoveredHandCard.set(null);
    this.showHotkeys.set(true);
  }

  /** Pick a deck: shown for confirmation, but nothing is loaded yet. */
  protected pickDeck(deck: Deck): void {
    this.pendingDeck.set(deck);
    this.choosingDeck.set(false);
  }

  /**
   * Join the game with the picked deck: resolve every decklist entry against
   * the card database (image + canonical name), create my zones with the
   * shuffled deck, and only now start warming the image caches — a deck that
   * was merely looked at never costs a download (polishpart2.md).
   */
  protected confirmDeck(): void {
    const deck = this.pendingDeck();
    if (!deck) return;
    const cards = deck.list.flatMap((entry) => {
      const record = this.db.lookup(entry.card);
      return Array.from(
        { length: entry.count },
        (): ZoneCard => ({
          id: crypto.randomUUID(),
          name: record?.name ?? entry.card,
          src: record?.src ?? '',
        }),
      );
    });
    this.zones.loadDeck(cards);
    this.pendingDeck.set(null);
    const srcs = new Set(cards.map((c) => c.src));
    srcs.delete('');
    for (const src of srcs) void this.assets.loadTexture(src).catch(() => undefined);
  }

  /** Art of a deck's first card, backing its tile in the picker (like the Decks screen). */
  protected firstCardSrc(deck: Deck): string | null {
    const first = deck.list[0];
    return first ? (this.db.lookup(first.card)?.src ?? null) : null;
  }

  /** Effective `--u` in px, mirroring styles.scss `min(1vw, 1.7778vh)`. */
  private u(): number {
    const { w, h } = this.viewport();
    return Math.min(w / 100, (h * 1.7778) / 100);
  }

  /** Centre-to-centre spacing (px) between hand cards so the visible ones fit
   * the middle HAND_MAX_FRACTION of the screen; extra cards scroll past it. */
  private handStepPx(total: number): number {
    const slots = Math.min(total, MAX_VISIBLE_HAND);
    if (slots <= 1) return 0;
    const cardW = HAND_CARD_U * this.u();
    const fit = (HAND_MAX_FRACTION * this.viewport().w - cardW) / (slots - 1);
    const natural = cardW * 0.52; // comfortable overlap when the hand is small
    return Math.max(Math.min(natural, fit), cardW * 0.14);
  }

  /** Per-card transform: horizontal slot, a slight downward arc, and fan tilt. */
  protected handCardTransform(i: number, total: number): string {
    const centre = (total - 1) / 2;
    const dx = (i - centre) * this.handStepPx(total);
    const dy = (i - centre) ** 2 * 0.045 * this.u();
    const rot = (i - centre) * Math.min(MAX_FAN_STEP_DEG, FAN_SPREAD_DEG / Math.max(total, 1));
    return `translate(calc(-50% + ${dx.toFixed(1)}px), ${dy.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`;
  }

  /** CSS transform panning the fanned hand by any wheel-scroll shift. */
  protected handTransform(): string {
    return `translateX(${this.handScroll()}px)`;
  }

  /**
   * Wheel over the hand scrolls it sideways (deltaY → horizontal), so a hand
   * with more than MAX_VISIBLE_HAND cards can be panned to reveal the rest,
   * which are otherwise clipped past the middle-50% window.
   */
  protected onHandWheel(event: WheelEvent): void {
    const total = this.zones.mine().hand.length;
    const cardW = HAND_CARD_U * this.u();
    const full = cardW + Math.max(total - 1, 0) * this.handStepPx(total);
    const overflow = full - HAND_MAX_FRACTION * this.viewport().w;
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
    const el = document.elementFromPoint(x, y);
    return el instanceof Element && !!el.closest(ZONE_SELECTORS[kind]);
  }

  // ---------- life ----------

  protected chooseLife(n: number): void {
    this.zones.setLife(n);
  }

  protected bumpLife(delta: number): void {
    const life = this.zones.mine().life;
    if (life === null) return;
    this.zones.setLife(Math.max(0, life + delta));
  }

  // ---------- revealing my hand ----------

  /** Reveal or hide my whole hand at once (the toggle overrides per-card state). */
  protected revealAll(): void {
    this.zones.revealHand(!this.allRevealed());
  }

  protected openHandMenu(event: MouseEvent, card: ZoneCard): void {
    event.preventDefault();
    event.stopPropagation();
    const host = (event.currentTarget as HTMLElement).closest('app-zones')!;
    const rect = host.getBoundingClientRect();
    this.handMenu.set({ card, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  protected toggleRevealCard(): void {
    const menu = this.handMenu();
    this.handMenu.set(null);
    if (menu) this.zones.toggleReveal(menu.card.id);
  }

  // ---------- dragging cards out of a zone ----------

  /**
   * Press on a card in my hand (source 'hand') or in an open zone I'm examining
   * (source that zone): arm a drag. The card only leaves once the cursor travels
   * past the threshold — an accidental click does nothing — and the drag is then
   * handed to CardInteractions like any table drag.
   */
  protected startDrag(
    event: PointerEvent,
    card: ZoneCard,
    source: 'hand' | ZoneKind = 'hand',
  ): void {
    if (event.button !== 0) return;
    event.preventDefault(); // no native image drag / text selection
    this.pendingDrag = { card, x: event.clientX, y: event.clientY, source };
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
    if (pending.source === 'hand') this.beginPlay(pending.card, event);
    else this.beginZoneDrag(pending.card, pending.source, event);
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
   * A card leaving one of my zones for the table, face up at my seat. Zones
   * store only a name and a front image, so everything else a table card needs
   * — its related names and the second face of a double-faced card (mdfcs.md)
   * — is resolved against the card database here, which also fills in art that
   * was missing when the deck was imported.
   */
  private tableCard(id: string, card: ZoneCard): CardState {
    const record = this.db.lookup(card.name);
    return {
      id,
      name: card.name,
      src: card.src || (record?.src ?? ''),
      ...(record?.back ? { backSrc: record.back } : {}),
      position: [0, DRAG_Y, 0],
      yaw: this.room.seatYaw(),
      faceUp: true,
      tapped: false,
      relatedNames: record?.related ?? [],
      ownerUid: this.room.userId() ?? '',
    };
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
    // Local-only until the drop commits: other players must not see a card
    // that is merely being considered (stabilityandimprovements.md).
    this.cards.addLocal(this.tableCard(id, taken));
    this.interactions.beginDragFromHand(id, event, {
      commit: () => this.room.sendAction(`played ${taken.name}`),
      revert: () => {
        this.cards.remove(id);
        this.zones.addCard('hand', taken);
      },
    });
  }

  /**
   * Drag a card out of one of my open zones (graveyard/exile) onto the table or
   * another zone. The examine dialog closes so the table and zone widgets are
   * reachable; releasing over the table commits (a history line), over a zone
   * widget routes it there (that zone logs the move), and a miss or Escape puts
   * the card back where it came from.
   */
  private beginZoneDrag(card: ZoneCard, kind: ZoneKind, event: PointerEvent): void {
    this.examining.set(null);
    const taken = this.zones.removeFromZone(kind, card.id);
    if (!taken) return;
    const id = newCardId();
    this.cards.addLocal(this.tableCard(id, taken));
    this.interactions.beginDragFromHand(id, event, {
      commit: () => this.room.sendAction(`put ${taken.name} onto the table`),
      revert: () => {
        this.cards.remove(id);
        this.zones.addCard(kind, taken);
      },
    });
  }

  protected openMenu(event: MouseEvent, kind: Exclude<ZoneKind, 'hand'>): void {
    event.preventDefault();
    event.stopPropagation();
    const host = (event.currentTarget as HTMLElement).closest('app-zones')!;
    const rect = host.getBoundingClientRect();
    this.revealOpen.set(false); // the deck menu always opens collapsed
    this.revealDraft.set('');
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

  // ---------- reveal (scry) ----------

  /**
   * Look at the top `count` cards of my deck and open the scry window on them
   * (newmechanics.md). Nothing has moved yet — the panel commits each card as
   * it is dropped on a zone — so a deck with fewer cards than asked for simply
   * reveals what it has, and an empty deck opens nothing.
   */
  protected reveal(count: number): void {
    this.closeDeckMenu();
    const cards = this.zones.revealTop(count);
    if (cards.length > 0) this.revealing.set({ cards, mode: 'reveal' });
  }

  /**
   * Look through the whole deck for a card (finaltouches.md "searching deck"):
   * the same panel, showing everything left, filtered by name, with hand and
   * graveyard as the destinations.
   */
  protected search(): void {
    this.closeDeckMenu();
    const cards = this.zones.searchDeck();
    if (cards.length > 0) this.revealing.set({ cards, mode: 'search' });
  }

  private closeDeckMenu(): void {
    this.menu.set(null);
    this.revealOpen.set(false);
    this.revealDraft.set('');
  }

  /** Reveal the number typed into the menu's "X" box (positive integers only). */
  protected revealDrafted(): void {
    const count = Number.parseInt(this.revealDraft(), 10);
    if (!Number.isFinite(count) || count < 1) return;
    this.reveal(count);
  }

  protected onRevealDraft(event: Event): void {
    this.revealDraft.set((event.target as HTMLInputElement).value);
  }

  protected examine(uid: string, kind: OpenZoneKind): void {
    this.menu.set(null);
    this.examining.set({ uid, kind });
  }

  /** Close the open pile / hand menus when clicking anywhere outside them. */
  protected onDocumentPointerDown(event: PointerEvent): void {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || !el.closest('.zone-menu')) this.menu.set(null);
    if (!el || !el.closest('.hand-menu')) this.handMenu.set(null);
  }
}
