import { Injectable, computed, inject, signal } from '@angular/core';
import { Object3D, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { ZoneStore } from '../../zones/zone-store';
import { ZoneKind } from '../../zones/zone.types';
import { ItemStore } from '../item/item-store';
import { ItemAction, isItemId, itemLabel } from '../item/item.types';
import { SceneCamera } from '../scene-camera';
import { CardStore } from './card-store';
import { CardAction, CardState, GROUP_ACTIONS } from './card.types';

/** Height a card floats at while being moved (tabletop is at y ≈ 0.2). */
export const DRAG_Y = 0.5;
/** Lift above the surface hit when placing, so stacked cards don't z-fight. */
const PLACE_OFFSET = 0.01;
/** How high above a card's origin a counter attached to it rides. */
const COUNTER_LIFT = 0.03;
/** Cursor travel (CSS px) past which a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD_PX = 4;
/** Cursor travel (CSS px) past which a press on empty table becomes a marquee. */
const MARQUEE_THRESHOLD_PX = 5;
const DRAG_PLANE = new Plane(new Vector3(0, 1, 0), -DRAG_Y);
/** Where added objects appear when no better spot is known (table center, tabletop ≈ 0.2). */
const TABLE_CENTER: [number, number, number] = [0, 0.21, 0];

/** Hotkeys firing card actions while a card is hovered (user-configurable later). */
const HOTKEYS: Readonly<Record<string, CardAction>> = {
  v: 'view',
  t: 'tap',
  r: 'rotate',
  f: 'flip',
  g: 'related',
  h: 'toHand',
  e: 'toExile',
  x: 'delete',
  Delete: 'delete',
};

/** Screen anchor (CSS px relative to the scene host) for a card's popups. */
export interface OverlayAnchor {
  /** Card world-object id. */
  id: string;
  x: number;
  y: number;
}

/** Anchor for the related-cards panel, which can span a whole selection. */
export interface RelatedAnchor {
  /** Cards whose related lists the panel shows (a selection, or just one). */
  ids: string[];
  x: number;
  y: number;
}

/** Anchor for the util window: screen point plus the table point that was clicked. */
export interface UtilAnchor {
  x: number;
  y: number;
  /** World position where added objects should appear. */
  world: [number, number, number];
}

/** Selection rectangle being dragged over the table, in CSS px relative to the scene host. */
export interface Marquee {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What to do when a drag that started in the hand UI ends. */
export interface HandDragHooks {
  /** The drop landed on the table — the caller logs the play. */
  commit(): void;
  /** The drop missed (or Escape) — undo: remove the card, back into the hand. */
  revert(): void;
}

/**
 * A DOM zone (hand/deck/graveyard/exile UI) that can absorb a card dropped onto
 * it, registered by the Zones overlay. A card released over a hit target is
 * routed into that zone instead of being placed on the table.
 */
export interface CardDropTarget {
  /** True if the screen point (client coords) is over this target's UI. */
  hitTest(clientX: number, clientY: number): boolean;
  /** Absorb the dropped card (still a table card at this point). */
  accept(card: CardState): void;
}

/** The dragged card as drawn by a DOM overlay: a "ghost" following the cursor,
 * on top of every overlay so it never hides behind the hand or pile UI. */
export interface DragGhost {
  /** Card the ghost stands in for — that card hides its 3D instance. */
  id: string;
  src: string;
  faceUp: boolean;
  /** Cursor position in client coordinates. */
  x: number;
  y: number;
}

/**
 * Pointer/keyboard layer for the table (the design doc's "CardContext"):
 * raycasts the cursor against registered card objects for hover highlight and
 * picking, runs the drag-to-move flow (press and drag past a small threshold →
 * float at DRAG_Y following the cursor as a local preview → release commits
 * the drop onto whatever the camera-through-cursor ray hits: table, floor, or
 * another card, which is how stacking works; a drop that hits nothing snaps
 * the card back). A plain click (press released without dragging) taps/untaps
 * a card. Cards played from the hand UI arrive via beginDragFromHand: the same
 * drag flow, but a missed drop reverts the card into the hand instead of
 * snapping back.
 *
 * Dragging on empty table instead draws a **selection marquee**: on release,
 * every card whose origin falls inside it becomes selected (highlighted like a
 * hover). A selection drags as one — offsets and per-card state preserved —
 * while a plain click still taps just the one card under the cursor, and the
 * context menu applies tap/related/delete to the whole group (see
 * `GROUP_ACTIONS`).
 *
 * The same registry holds **table items** (dice, coins, counters — `item:` ids,
 * ItemStore): they hover, drag and drop through these flows too, but click and
 * right-click mean something else for them (a counter counts up and down, a die
 * or coin opens its own small menu), a marquee never picks them up, and a
 * counter dropped onto a card attaches to it.
 *
 * Also owns the popup state rendered by CardOverlay: the card and item context
 * menus, the related-cards window, and the util window opened by right-clicking
 * empty table. Provided BY the Scene component, which attaches it to the canvas.
 */
@Injectable()
export class CardInteractions {
  private readonly store = inject(CardStore);
  private readonly items = inject(ItemStore);
  private readonly zones = inject(ZoneStore);
  private readonly room = inject(RoomService);
  private readonly camera = inject(SceneCamera).camera;

  private readonly objectsById = new Map<string, Object3D>();
  private readonly surfaces = new Set<Object3D>();
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hit = new Vector3();
  private canvas?: HTMLCanvasElement;
  /** Pressed object; becomes a drag past DRAG_THRESHOLD_PX, a tap if released before. */
  private pressed: { id: string; x: number; y: number } | null = null;
  /** Press on empty table; becomes a selection marquee past MARQUEE_THRESHOLD_PX. */
  private marqueeStart: { x: number; y: number } | null = null;
  /** Set while the active drag came from the hand UI (missed drop → revert). */
  private handDrag: HandDragHooks | null = null;
  /** Table point the active drag started from, for moving a whole selection. */
  private dragOrigin: Vector3 | null = null;
  /** The other selected cards travelling with the dragged one, and where they started. */
  private dragGroup: { id: string; start: [number, number, number] }[] = [];
  /** DOM zones that can absorb a dropped card (registered by the Zones overlay). */
  private readonly dropTargets = new Set<CardDropTarget>();

  readonly hoveredId = signal<string | null>(null);
  readonly draggingId = signal<string | null>(null);
  /** Cards picked by a marquee; they highlight and move together. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** The selection rectangle while it is being dragged, else null. */
  readonly marquee = signal<Marquee | null>(null);
  /** The card currently being dragged, drawn as a cursor-following DOM ghost. */
  readonly dragGhost = signal<DragGhost | null>(null);
  readonly contextMenu = signal<OverlayAnchor | null>(null);
  /** Right-click menu of a die or coin (roll / flip / delete). */
  readonly itemMenu = signal<OverlayAnchor | null>(null);
  readonly viewCardId = signal<string | null>(null);
  readonly relatedPanel = signal<RelatedAnchor | null>(null);
  readonly utilWindow = signal<UtilAnchor | null>(null);
  /** How many cards the context menu's group actions would hit (1 = just this card). */
  readonly selectionSize = computed(() => this.selectedIds().size);

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    // On window, not the canvas: a drag from the hand UI starts over DOM and a
    // drag must keep following (and be releasable) outside the canvas too.
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  detach(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas = undefined;
  }

  /** Cards register their scene object so cursor rays can find them. */
  register(id: string, object: Object3D): void {
    this.objectsById.set(id, object);
  }

  unregister(id: string): void {
    this.objectsById.delete(id);
    if (this.pressed?.id === id) this.pressed = null;
    if (this.hoveredId() === id) this.hoveredId.set(null);
    if (this.draggingId() === id) {
      this.endDrag();
      this.handDrag = null;
    }
    this.deselect(id);
    if (this.contextMenu()?.id === id) this.contextMenu.set(null);
    if (this.itemMenu()?.id === id) this.itemMenu.set(null);
    if (this.viewCardId() === id) this.viewCardId.set(null);
    const related = this.relatedPanel();
    if (related?.ids.includes(id)) {
      const ids = related.ids.filter((other) => other !== id);
      this.relatedPanel.set(ids.length ? { ...related, ids } : null);
    }
  }

  /** Placement targets besides cards (table environment, placeholder floor). */
  addSurface(object: Object3D): void {
    this.surfaces.add(object);
  }

  removeSurface(object: Object3D): void {
    this.surfaces.delete(object);
  }

  /** Register a DOM zone that can absorb a card dropped onto it (Zones overlay). */
  registerDropTarget(target: CardDropTarget): void {
    this.dropTargets.add(target);
  }

  unregisterDropTarget(target: CardDropTarget): void {
    this.dropTargets.delete(target);
  }

  /** Whether a card is part of the current selection (drawn highlighted). */
  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  clearSelection(): void {
    if (this.selectedIds().size) this.selectedIds.set(new Set());
  }

  private deselect(id: string): void {
    const selected = this.selectedIds();
    if (!selected.has(id)) return;
    const next = new Set(selected);
    next.delete(id);
    this.selectedIds.set(next);
  }

  /** End the active drag: clear the drag id, the group, and the DOM ghost together. */
  private endDrag(): void {
    this.draggingId.set(null);
    this.dragGhost.set(null);
    this.dragGroup = [];
    this.dragOrigin = null;
  }

  private dropTargetAt(x: number, y: number): CardDropTarget | null {
    for (const target of this.dropTargets) if (target.hitTest(x, y)) return target;
    return null;
  }

  /**
   * Take over a drag for a card just played from the hand UI: it floats at
   * DRAG_Y under the cursor until the (already held) button is released —
   * over the table commits the play, anywhere else reverts it into the hand.
   */
  beginDragFromHand(id: string, event: PointerEvent, hooks: HandDragHooks): void {
    this.pressed = null;
    this.marqueeStart = null;
    this.hoveredId.set(null);
    this.clearSelection();
    this.handDrag = hooks;
    this.draggingId.set(id);
    this.dragOrigin = null;
    this.dragGroup = [];
    this.dragTo(id, event);
  }

  /**
   * Run a card action; menu and hotkeys both land here. An action in
   * GROUP_ACTIONS aimed at a selected card applies to the whole selection;
   * anything else drops the selection and acts on the one card.
   */
  act(cardId: string, action: CardAction): void {
    this.contextMenu.set(null);
    if (this.isSelected(cardId) && GROUP_ACTIONS.includes(action)) {
      const ids = [...this.selectedIds()];
      if (action === 'related') {
        const anchor = this.screenPointOf(cardId);
        if (anchor) this.relatedPanel.set({ ids, ...anchor });
        return;
      }
      // Snapshot first: deleting mutates the store the selection points into.
      for (const id of ids) this.actOne(id, action);
      if (action === 'delete') this.clearSelection();
      return;
    }
    this.clearSelection();
    this.actOne(cardId, action);
  }

  /**
   * Run an action on a die or coin (their right-click menu). Counters have no
   * menu: they change value on click and go away with the delete hotkey.
   */
  itemAct(id: string, action: ItemAction): void {
    this.itemMenu.set(null);
    const item = this.items.item(id);
    if (!item) return;
    switch (action) {
      case 'roll':
        this.items.roll(id); // logs the result itself
        break;
      case 'flip':
        this.items.flip(id);
        break;
      case 'delete':
        this.items.remove(id);
        this.room.sendAction(`removed a ${itemLabel(item)}`);
        break;
    }
  }

  /** One card, one action — the selection-free core of `act`. */
  private actOne(cardId: string, action: CardAction): void {
    const card = this.store.card(cardId);
    if (!card) return;
    switch (action) {
      case 'view':
        this.viewCardId.set(cardId);
        break;
      case 'tap':
        this.toggleTap(cardId);
        break;
      case 'rotate':
        this.store.update(cardId, { yaw: card.yaw + Math.PI });
        this.room.sendAction(`rotated ${card.name}`);
        break;
      case 'flip':
        this.store.update(cardId, { faceUp: !card.faceUp });
        this.room.sendAction(`turned ${card.name} face ${card.faceUp ? 'down' : 'up'}`);
        break;
      case 'related': {
        const anchor = this.screenPointOf(cardId);
        if (anchor) this.relatedPanel.set({ ids: [cardId], ...anchor });
        break;
      }
      case 'toHand':
        this.toZone(card, 'hand');
        break;
      case 'toDeck':
        this.toZone(card, 'deck');
        break;
      case 'toGrave':
        this.toZone(card, 'graveyard');
        break;
      case 'toExile':
        this.toZone(card, 'exile');
        break;
      case 'delete':
        this.items.removeAttachedTo(cardId); // counters riding on it go too
        this.store.remove(cardId); // Card's destroy calls unregister, clearing stale state
        this.room.sendAction(`removed ${card.name}`);
        break;
    }
  }

  /** Move a card off the table into a zone, taking its counters with it. */
  private toZone(card: CardState, kind: ZoneKind): void {
    this.items.removeAttachedTo(card.id);
    this.zones.takeFromTable(card, kind);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const draggingId = this.draggingId();
    if (draggingId) {
      this.dragTo(draggingId, event);
      return;
    }
    const pressed = this.pressed;
    if (pressed) {
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_THRESHOLD_PX) {
        return; // still within tap tolerance
      }
      this.beginDrag(pressed.id, event); // the press travelled: a drag, not a tap
      return;
    }
    const marqueeStart = this.marqueeStart;
    if (marqueeStart) {
      if (
        this.marquee() === null &&
        Math.hypot(event.clientX - marqueeStart.x, event.clientY - marqueeStart.y) <
          MARQUEE_THRESHOLD_PX
      ) {
        return; // still within click tolerance
      }
      this.marquee.set(this.rectBetween(marqueeStart, event));
      return;
    }
    // Hover only from moves over the canvas itself, not the DOM overlays.
    if (event.target === this.canvas) this.hoveredId.set(this.pick(event));
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.draggingId()) return;
    this.contextMenu.set(null);
    this.itemMenu.set(null);
    this.relatedPanel.set(null);
    this.utilWindow.set(null);
    const picked = this.pick(event);
    if (picked) {
      // Grabbing a card outside the selection drops it (cardselection.md).
      if (!this.isSelected(picked)) this.clearSelection();
      this.pressed = { id: picked, x: event.clientX, y: event.clientY };
      return;
    }
    // Empty table: a click clears the selection, a drag draws a new one.
    this.clearSelection();
    this.marqueeStart = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const pressed = this.pressed;
    this.pressed = null;
    const marqueeStart = this.marqueeStart;
    this.marqueeStart = null;
    if (marqueeStart) {
      const rect = this.marquee();
      this.marquee.set(null);
      if (rect) this.selectWithin(rect);
      return;
    }
    const draggingId = this.draggingId();
    if (draggingId) {
      const handDrag = this.handDrag;
      this.handDrag = null;
      // A drop over a UI zone (hand/deck/graveyard/exile) sends the card there,
      // taking priority over placing it on the table below.
      const card = this.store.card(draggingId);
      const target = card ? this.dropTargetAt(event.clientX, event.clientY) : null;
      if (target && card) {
        this.clearDragPreviews(draggingId);
        this.endDrag();
        this.items.removeAttachedTo(card.id);
        // A hand card dropped straight onto a zone widget never reached the
        // shared world — discard the local copy before the zone absorbs it.
        if (handDrag) this.store.remove(draggingId);
        target.accept(card);
        return;
      }
      if (this.tryPlace(draggingId, event)) {
        handDrag?.commit();
      } else if (handDrag) {
        // A hand card dropped off the table goes back into the hand.
        this.endDrag();
        handDrag.revert();
      } else {
        // Snap back to where the cards were picked up.
        this.clearDragPreviews(draggingId);
        this.endDrag();
      }
      return;
    }
    if (pressed) this.clickObject(pressed.id);
  };

  /** A plain click: cards tap, counters count up, other items do nothing. */
  private clickObject(id: string): void {
    if (!isItemId(id)) {
      this.toggleTap(id);
      return;
    }
    if (this.items.item(id)?.kind === 'counter') this.items.bump(id, 1);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.draggingId() || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.relatedPanel.set(null);
    const picked = this.pick(event);
    if (picked && isItemId(picked)) {
      this.clearSelection();
      this.utilWindow.set(null);
      this.contextMenu.set(null);
      // A counter counts *down* on right-click instead of opening a menu.
      if (this.items.item(picked)?.kind === 'counter') {
        this.itemMenu.set(null);
        this.items.bump(picked, -1);
      } else {
        this.itemMenu.set({ id: picked, x: x + 8, y });
      }
      return;
    }
    this.itemMenu.set(null);
    if (picked) {
      // Right-clicking outside the selection drops it and targets this card.
      if (!this.isSelected(picked)) this.clearSelection();
      this.utilWindow.set(null);
      this.contextMenu.set({ id: picked, x: x + 8, y });
    } else {
      // Empty table: open the util window (add to game) at the clicked spot;
      // added objects appear where the ray meets the table.
      this.clearSelection();
      this.contextMenu.set(null);
      this.utilWindow.set({ x: x + 8, y, world: this.surfacePoint(event) ?? TABLE_CENTER });
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return; // typing (e.g. in chat) must not trigger card actions
    }
    if (event.key === 'Escape') {
      this.pressed = null;
      this.marqueeStart = null;
      this.marquee.set(null);
      const draggingId = this.draggingId();
      if (draggingId) {
        // Cancel the move: back to the shared state (table pose) or, for a
        // card being played from the hand, back into the hand.
        const handDrag = this.handDrag;
        this.handDrag = null;
        if (!handDrag) this.clearDragPreviews(draggingId); // before endDrag drops the group
        this.endDrag();
        if (handDrag) handDrag.revert();
      }
      this.clearSelection();
      this.contextMenu.set(null);
      this.itemMenu.set(null);
      this.relatedPanel.set(null);
      this.utilWindow.set(null);
      return;
    }
    const action = HOTKEYS[event.key];
    const hoveredId = this.hoveredId();
    if (!action || !hoveredId) return;
    // Items only answer to delete — the design doc's way of removing a counter.
    if (isItemId(hoveredId)) {
      if (action !== 'delete') return;
      event.preventDefault();
      this.itemAct(hoveredId, 'delete');
      return;
    }
    event.preventDefault();
    this.act(hoveredId, action);
  };

  /** Start moving the pressed object — and, if it is selected, the whole group. */
  private beginDrag(id: string, event: PointerEvent): void {
    this.pressed = null;
    this.draggingId.set(id);
    this.hoveredId.set(null); // moving clears highlights
    if (isItemId(id)) {
      // Items travel alone (a selection is cards only) and stay 3D — no ghost.
      this.dragGroup = [];
      this.dragOrigin = null;
      this.dragTo(id, event);
      return;
    }
    const selected = this.selectedIds();
    this.dragGroup =
      selected.has(id) && selected.size > 1
        ? [...selected]
            .filter((other) => other !== id)
            .flatMap((other) => {
              const card = this.store.card(other);
              return card ? [{ id: other, start: card.position }] : [];
            })
        : [];
    const primary = this.store.card(id);
    this.dragOrigin = primary ? new Vector3(...primary.position) : null;
    this.dragTo(id, event);
  }

  /** Follow the cursor: intersect its ray with the horizontal plane at DRAG_Y,
   * move the dragged card (and any selection travelling with it), and update
   * the DOM ghost that renders a single dragged card on top of the UI. */
  private dragTo(id: string, event: MouseEvent): void {
    if (isItemId(id)) {
      if (!this.setRayFromCursor(event)) return;
      if (!this.raycaster.ray.intersectPlane(DRAG_PLANE, this.hit)) return;
      // A counter picked up off a card floats free until it lands again, so the
      // preview position is world-space like every other item's.
      this.items.preview(id, {
        position: [this.hit.x, DRAG_Y, this.hit.z],
        attachedTo: null,
      });
      return;
    }
    const card = this.store.card(id);
    // A group keeps its cards visible in the scene (they move together, and
    // none of them is hiding behind the hand UI); a lone card uses the ghost.
    if (this.dragGroup.length === 0) {
      this.dragGhost.set({
        id,
        src: card?.src ?? '',
        faceUp: card?.faceUp ?? true,
        x: event.clientX,
        y: event.clientY,
      });
    }
    if (!this.setRayFromCursor(event)) return;
    if (!this.raycaster.ray.intersectPlane(DRAG_PLANE, this.hit)) return;
    this.store.preview(id, { position: [this.hit.x, DRAG_Y, this.hit.z] });
    if (this.dragGroup.length === 0 || !this.dragOrigin) return;
    const dx = this.hit.x - this.dragOrigin.x;
    const dz = this.hit.z - this.dragOrigin.z;
    for (const member of this.dragGroup) {
      this.store.preview(member.id, {
        position: [member.start[0] + dx, DRAG_Y, member.start[2] + dz],
      });
    }
  }

  /**
   * Drop the card where the ray from the camera through the cursor (Unity's
   * `Camera.ScreenPointToRay`) hits the world — table, floor, or another card
   * (stacking) — committing the move to the shared state. A selection lands
   * with it, each card keeping its offset. Returns false when the ray hits
   * nothing placeable, leaving the card picked up; callers decide whether that
   * means snap back (table drag) or revert to hand (hand drag).
   */
  private tryPlace(id: string, event: MouseEvent): boolean {
    if (!this.setRayFromCursor(event)) return false;
    const moving = new Set([id, ...this.dragGroup.map((m) => m.id)]);
    const targets = [
      ...this.surfaces,
      ...[...this.objectsById.entries()].filter(([other]) => !moving.has(other)).map(([, o]) => o),
    ];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return false;
    const y = hit.point.y + PLACE_OFFSET;
    if (isItemId(id)) {
      this.placeItem(id, [hit.point.x, y, hit.point.z], this.idFor(hit.object));
      this.endDrag();
      return true;
    }
    // One batched commit: the whole group (or the single card) lands atomically.
    const writes: [string, Partial<CardState>][] = [
      [id, { position: [hit.point.x, y, hit.point.z] }],
    ];
    if (this.dragOrigin) {
      const dx = hit.point.x - this.dragOrigin.x;
      const dz = hit.point.z - this.dragOrigin.z;
      for (const member of this.dragGroup) {
        writes.push([member.id, { position: [member.start[0] + dx, y, member.start[2] + dz] }]);
      }
    }
    this.store.updateMany(writes);
    this.endDrag();
    return true;
  }

  /**
   * Land an item: a counter dropped on a card attaches to it (its position
   * becomes an offset, so it rides along), anything else just sits where it
   * fell. Dropping a counter anywhere else detaches it again.
   */
  private placeItem(id: string, point: [number, number, number], hitId: string | null): void {
    const item = this.items.item(id);
    const onCard = hitId && !isItemId(hitId) ? this.store.card(hitId) : undefined;
    if (item?.kind === 'counter' && onCard) {
      this.items.update(id, {
        attachedTo: onCard.id,
        position: [point[0] - onCard.position[0], COUNTER_LIFT, point[2] - onCard.position[2]],
      });
      return;
    }
    this.items.update(id, { attachedTo: null, position: point });
  }

  /** Drop the local drag poses of the dragged object and everything with it. */
  private clearDragPreviews(id: string): void {
    if (isItemId(id)) {
      this.items.clearPreview(id);
      return;
    }
    this.store.clearPreview(id);
    for (const member of this.dragGroup) this.store.clearPreview(member.id);
  }

  /** A click (press released without dragging) taps/untaps a card: a quarter
   * turn tracked in state so every player sees it. Cards in a selection still
   * tap one at a time (cardselection.md). */
  private toggleTap(id: string): void {
    const card = this.store.card(id);
    if (!card) return;
    this.store.update(id, { tapped: !card.tapped });
    this.room.sendAction(`${card.tapped ? 'untapped' : 'tapped'} ${card.name}`);
  }

  /** Normalized rectangle (scene-host CSS px) between the press and the cursor. */
  private rectBetween(start: { x: number; y: number }, event: MouseEvent): Marquee {
    const rect = this.canvas?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: Math.min(start.x, event.clientX) - left,
      y: Math.min(start.y, event.clientY) - top,
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    };
  }

  /** Select every card whose origin projects inside the released marquee. */
  private selectWithin(rect: Marquee): void {
    const canvasRect = this.canvas?.getBoundingClientRect();
    if (!canvasRect || canvasRect.width === 0 || canvasRect.height === 0) return;
    const selected = new Set<string>();
    for (const card of this.store.cards()) {
      const projected = new Vector3(...card.position).project(this.camera);
      const x = ((projected.x + 1) / 2) * canvasRect.width;
      const y = ((1 - projected.y) / 2) * canvasRect.height;
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        selected.add(card.id);
      }
    }
    this.selectedIds.set(selected);
  }

  /** Topmost object under the cursor (excluding one being moved), or null. */
  private pick(event: MouseEvent): string | null {
    if (!this.setRayFromCursor(event)) return null;
    const draggingId = this.draggingId();
    const candidates = [...this.objectsById.entries()]
      .filter(([id]) => id !== draggingId)
      .map(([, o]) => o);
    const hit = this.raycaster.intersectObjects(candidates, true)[0];
    return hit ? this.idFor(hit.object) : null;
  }

  /** Where the cursor's ray meets the table/floor, or null if it misses. */
  private surfacePoint(event: MouseEvent): [number, number, number] | null {
    if (!this.setRayFromCursor(event)) return null;
    const hit = this.raycaster.intersectObjects([...this.surfaces], true)[0];
    return hit ? [hit.point.x, hit.point.y + PLACE_OFFSET, hit.point.z] : null;
  }

  private setRayFromCursor(event: MouseEvent): boolean {
    if (!this.canvas) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return true;
  }

  /** Walk up from a hit mesh to the registered object root it belongs to. */
  private idFor(object: Object3D): string | null {
    for (const [id, root] of this.objectsById) {
      let node: Object3D | null = object;
      while (node) {
        if (node === root) return id;
        node = node.parent;
      }
    }
    return null;
  }

  /** Screen point just right of a card's origin, for popups opened by hotkey. */
  private screenPointOf(cardId: string): { x: number; y: number } | null {
    const card = this.store.card(cardId);
    if (!card || !this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const projected = new Vector3(...card.position).project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width + 24,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  }
}
