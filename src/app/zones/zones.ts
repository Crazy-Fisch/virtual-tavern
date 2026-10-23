import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { CardDatabaseService } from '../carddb/card-database.service';
import { DeckStore } from '../decks/deck-store';
import { Deck, deckSize, entrySrc } from '../decks/deck.types';
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
import {
  OpenZoneKind,
  POISON_LETHAL,
  PlayerZones,
  ZONE_KINDS,
  ZoneCard,
  ZoneKind,
} from './zone.types';

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

/** Draw animation: flight time of one card, and how long the new card glows. */
const FLY_MS = 600;
const GLOW_MS = 1500;
const CARD_RATIO = 88 / 63;

/** Gap between the flights of one batched opponent draw, and their cap. */
const OPP_STAGGER_MS = 80;
const MAX_OPP_FLIGHTS = 5;

/** One running flight; finish() ends it at once (removes the card, runs its landing). */
interface FlightRun {
  group: 'own' | 'opp';
  cardId: string | null;
  done: boolean;
  flightId: number;
  wake: () => void;
  finish: () => void;
}

/** A card or card back in flight between a deck and a hand, drawn above the UI. */
type Flight = {
  id: number;
  src: string | null;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  s: number;
  rot: number;
  /** Shift of the landing spot after the hand re-fanned mid-flight. */
  tx: number;
  ty: number;
};

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
  private readonly injector = inject(Injector);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
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
  /** Whether the "start a new round" confirmation is open. */
  protected readonly confirmingRound = signal(false);
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
  /** Hand cards drawn but still in flight: kept invisible until they land. */
  protected readonly arriving = signal<ReadonlySet<string>>(new Set());
  /** Hand cards that just landed and glow for GLOW_MS. */
  protected readonly fresh = signal<ReadonlySet<string>>(new Set());
  /** Cards currently flying from a deck to a hand. */
  protected readonly flights = signal<Flight[]>([]);
  /** Running flights; draws fly side by side and each one ends on its own. */
  private readonly runs = new Set<FlightRun>();
  private flightSeq = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;
  /** Opponents' hand and deck sizes at the previous update, to spot their draws. */
  private readonly oppSizes = new Map<string, { hand: number; deck: number }>();
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
    effect(() => {
      const others = this.zones.others();
      untracked(() => this.watchOpponents(others));
    });
    effect(() => {
      const hand = this.zones.mine().hand;
      untracked(() => void this.syncOwnFlights(hand));
    });
    for (const target of this.dropTargets) this.interactions.registerDropTarget(target);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const run of this.runs) {
      run.done = true;
      run.wake();
    }
    this.runs.clear();
    this.flights.set([]);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearPendingDrag();
    this.clearHandHover();
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
    // The id travels along so a hover that outlives the card can be spotted.
    this.interactions.hoveredHandCard.set(
      card
        ? { id: card.id, name: card.name, src: card.src, back: this.db.lookup(card.name)?.back }
        : null,
    );
  }

  /**
   * Forget which hand card the cursor is over. Called wherever the hand moves
   * out from under a still cursor or is covered up: neither fires
   * `pointerleave`, and hover would otherwise stay on a card the player is no
   * longer pointing at. The next pointer move re-establishes it.
   */
  private clearHandHover(): void {
    this.interactions.hoveredHandCard.set(null);
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
    this.clearHandHover();
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
  protected async confirmDeck(): Promise<void> {
    const deck = this.pendingDeck();
    if (!deck) return;
    this.pendingDeck.set(null);
    const list = await this.decks.resolvedList(deck);
    const cards = list.flatMap((entry) => {
      const record = this.db.lookup(entry.card);
      return Array.from(
        { length: entry.count },
        (): ZoneCard => ({
          id: crypto.randomUUID(),
          name: record?.name ?? entry.card,
          src: entrySrc(entry, record?.src),
        }),
      );
    });
    this.zones.loadDeck(cards);
    const srcs = new Set(cards.map((c) => c.src));
    srcs.delete('');
    for (const src of srcs) void this.assets.loadTexture(src).catch(() => undefined);
  }

  /** Art of a deck's first card, backing its tile in the picker (like the Decks screen). */
  protected firstCardSrc(deck: Deck): string | null {
    const first = deck.list[0];
    return first ? entrySrc(first, this.db.lookup(first.card)?.src) || null : null;
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

  private handRotation(i: number, total: number): number {
    return (i - (total - 1) / 2) * Math.min(MAX_FAN_STEP_DEG, FAN_SPREAD_DEG / Math.max(total, 1));
  }

  /** Per-card transform: horizontal slot, a slight downward arc, and fan tilt. */
  protected handCardTransform(i: number, total: number): string {
    const centre = (total - 1) / 2;
    const dx = (i - centre) * this.handStepPx(total);
    const dy = (i - centre) ** 2 * 0.045 * this.u();
    const rot = this.handRotation(i, total);
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
    // The cards just slid under the cursor without a pointer event to say so.
    this.clearHandHover();
  }

  /** True when the screen point sits over one of my zone widgets. */
  private overZone(x: number, y: number, kind: ZoneKind): boolean {
    if (!this.zones.hasMine()) return false;
    const el = document.elementFromPoint(x, y);
    return el instanceof Element && !!el.closest(ZONE_SELECTORS[kind]);
  }

  // ---------- new round ----------

  protected startNewRound(): void {
    this.confirmingRound.set(false);
    this.interactions.hoveredId.set(null);
    this.zones.startNewRound();
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

  // ---------- infect / poison ----------

  protected readonly poisonLethal = POISON_LETHAL;

  protected bumpPoison(delta: number): void {
    this.zones.setPoison(this.zones.mine().poison + delta);
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
    // Whatever happens next — played onto the table, or dropped back into a
    // re-fanned hand — the card under the cursor is about to move.
    this.clearHandHover();
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
    const top = this.zones.mine().deck[0];
    this.zones.draw();
    if (top && this.zones.mine().hand.some((c) => c.id === top.id)) this.announceDraw(top);
  }

  private reducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  /** Resolves after the next render, so a just-drawn card exists in the DOM. */
  private nextRender(): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => afterNextRender(() => resolve(), { injector: this.injector })),
      this.sleep(100),
    ]);
  }

  private mark(set: WritableSignal<ReadonlySet<string>>, id: string, on: boolean): void {
    set.update((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * My draw: the card stays invisible in the hand while a copy flies in from
   * the deck pile and flips face up. Every draw starts its own flight at
   * once, so quick draws fly side by side; a flight whose card leaves the hand
   * ends alone (syncOwnFlights). Once a card lands, it glows for GLOW_MS.
   * Reduced motion skips the flight and keeps the glow.
   */
  private announceDraw(card: ZoneCard): void {
    if (this.reducedMotion()) {
      this.land(card.id);
      return;
    }
    this.mark(this.arriving, card.id, true);
    const run = this.beginRun('own', card.id, () => {
      if (this.zones.mine().hand.some((c) => c.id === card.id)) this.land(card.id);
      else this.mark(this.arriving, card.id, false);
    });
    void this.flyIn(card, run);
  }

  /**
   * The hand changed: end the flights of cards that left it, and re-aim the
   * others at where their card sits now (the fan re-spreads when cards come or go).
   */
  private async syncOwnFlights(hand: readonly ZoneCard[]): Promise<void> {
    const own = [...this.runs].filter((run) => run.group === 'own');
    if (own.length === 0) return;
    for (const run of own) {
      if (!hand.some((c) => c.id === run.cardId)) run.finish();
    }
    await this.nextRender();
    if (this.destroyed) return;
    const current = this.zones.mine().hand;
    this.flights.update((all) =>
      all.map((f) => {
        const run = [...this.runs].find((r) => r.group === 'own' && r.flightId === f.id);
        if (!run || run.done) return f;
        const index = current.findIndex((c) => c.id === run.cardId);
        const target = this.hostEl.querySelector<HTMLElement>(`.hand-card[data-id="${run.cardId}"]`);
        if (index < 0 || !target) return f;
        const rect = target.getBoundingClientRect();
        return {
          ...f,
          tx: rect.left + rect.width / 2 - (f.x + f.w / 2),
          ty: rect.top + rect.height / 2 - (f.y + f.h / 2),
          rot: this.handRotation(index, current.length),
        };
      }),
    );
  }

  private beginRun(group: FlightRun['group'], cardId: string | null, onFinish: () => void): FlightRun {
    const run: FlightRun = {
      group,
      cardId,
      done: false,
      flightId: 0,
      wake: () => undefined,
      finish: () => {
        if (run.done) return;
        run.done = true;
        run.wake();
        this.runs.delete(run);
        if (run.flightId) this.flights.update((all) => all.filter((f) => f.id !== run.flightId));
        onFinish();
      },
    };
    this.runs.add(run);
    return run;
  }

  private land(id: string): void {
    this.mark(this.arriving, id, false);
    this.mark(this.fresh, id, true);
    void this.sleep(GLOW_MS).then(() => this.mark(this.fresh, id, false));
  }

  private async flyIn(card: ZoneCard, run: FlightRun): Promise<void> {
    await this.nextRender();
    if (this.destroyed || run.done) return;
    const hand = this.zones.mine().hand;
    const index = hand.findIndex((c) => c.id === card.id);
    const target = this.hostEl.querySelector<HTMLElement>(`.hand-card[data-id="${card.id}"]`);
    const pile = this.hostEl.querySelector<HTMLElement>('.pile.deck');
    if (index >= 0 && target && pile) {
      await this.fly(run, pile, target.getBoundingClientRect(), {
        src: card.src,
        name: card.name,
        w: target.offsetWidth,
        h: target.offsetHeight,
        rot: this.handRotation(index, hand.length),
      });
    }
    run.finish();
  }

  /** Opponents draw: a card back flies from their deck chip to their hand. */
  private watchOpponents(others: readonly PlayerZones[]): void {
    for (const p of others) {
      const prev = this.oppSizes.get(p.uid);
      this.oppSizes.set(p.uid, { hand: p.hand.length, deck: p.deck.length });
      if (!prev || this.reducedMotion()) continue;
      const drawn = Math.min(p.hand.length - prev.hand, prev.deck - p.deck.length);
      for (let i = 0; i < Math.min(drawn, MAX_OPP_FLIGHTS); i++) {
        void this.flyBack(p.uid, this.beginRun('opp', null, () => undefined), i * OPP_STAGGER_MS);
      }
    }
  }

  private async flyBack(uid: string, run: FlightRun, delay: number): Promise<void> {
    if (delay > 0) await this.sleep(delay);
    await this.nextRender();
    if (this.destroyed || run.done) return;
    const opp = this.hostEl.querySelector<HTMLElement>(`.opp[data-uid="${uid}"]`);
    const pile = opp?.querySelector<HTMLElement>('.mini.deck');
    const hand = opp?.querySelector<HTMLElement>('.opp-hand');
    if (!pile || !hand) {
      run.finish();
      return;
    }
    const w = 3.6 * this.u();
    const h = w * CARD_RATIO;
    const rect = hand.getBoundingClientRect();
    const end = new DOMRect(rect.right - w, rect.top + (rect.height - h) / 2, w, h);
    await this.fly(run, pile, end, { src: null, name: '', w, h, rot: 0 });
    run.finish();
  }

  /** Run one flight from the centre of `from` to the rectangle `end`. */
  private async fly(
    run: FlightRun,
    from: HTMLElement,
    end: DOMRect,
    card: Pick<Flight, 'src' | 'name' | 'w' | 'h' | 'rot'>,
  ): Promise<void> {
    const start = from.getBoundingClientRect();
    const cx = end.left + end.width / 2;
    const cy = end.top + end.height / 2;
    const flight: Flight = {
      ...card,
      id: ++this.flightSeq,
      x: cx - card.w / 2,
      y: cy - card.h / 2,
      dx: start.left + start.width / 2 - cx,
      dy: start.top + start.height / 2 - cy,
      s: Math.max(start.width / card.w, 0.2),
      tx: 0,
      ty: 0,
    };
    run.flightId = flight.id;
    this.flights.update((all) => [...all, flight]);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLY_MS);
      this.timers.add(timer);
      run.wake = () => {
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve();
      };
    });
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
    this.clearHandHover(); // the panel that follows covers the hand
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
    this.clearHandHover(); // the dialog covers the hand
    this.examining.set({ uid, kind });
  }

  /** Close the open pile / hand menus when clicking anywhere outside them. */
  protected onDocumentPointerDown(event: PointerEvent): void {
    const el = event.target instanceof Element ? event.target : null;
    if (!el || !el.closest('.zone-menu')) this.menu.set(null);
    if (!el || !el.closest('.hand-menu')) this.handMenu.set(null);
  }
}
