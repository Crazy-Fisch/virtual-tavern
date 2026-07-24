import { Injectable, inject, signal } from '@angular/core';
import { Object3D, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { ZoneStore } from '../../zones/zone-store';
import { SceneCamera } from '../scene-camera';
import { CardStore } from './card-store';
import { CardAction, CardState } from './card.types';

/** Height a card floats at while being moved (tabletop is at y ≈ 0.2). */
export const DRAG_Y = 0.5;
/** Lift above the surface hit when placing, so stacked cards don't z-fight. */
const PLACE_OFFSET = 0.01;
/** Cursor travel (CSS px) past which a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD_PX = 4;
const DRAG_PLANE = new Plane(new Vector3(0, 1, 0), -DRAG_Y);
/** Where added objects appear when no better spot is known (table center, tabletop ≈ 0.2). */
const TABLE_CENTER: [number, number, number] = [0, 0.21, 0];

/** Hotkeys firing card actions while a card is hovered (user-configurable later). */
const HOTKEYS: Readonly<Record<string, CardAction>> = {
  v: 'view',
  r: 'rotate',
  f: 'flip',
  g: 'related',
  h: 'toHand',
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

/** Anchor for the util window: screen point plus the table point that was clicked. */
export interface UtilAnchor {
  x: number;
  y: number;
  /** World position where added objects should appear. */
  world: [number, number, number];
}

/** What to do when a drag that started in the hand UI ends. */
export interface HandDragHooks {
  /** The drop landed on the table — the caller logs the play. */
  commit(): void;
  /** The drop missed (or Escape) — undo: remove the card, back into the hand. */
  revert(): void;
}

/**
 * A DOM zone (hand/deck/graveyard UI) that can absorb a card dropped onto it,
 * registered by the Zones overlay. A card released over a hit target is routed
 * into that zone instead of being placed on the table.
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
 * snapping back. Also owns the popup state rendered by CardOverlay: the card
 * context menu, the view/related panels, and the util window opened by
 * right-clicking empty table. Provided BY the Scene component, which attaches
 * it to the canvas.
 */
@Injectable()
export class CardInteractions {
  private readonly store = inject(CardStore);
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
  /** Set while the active drag came from the hand UI (missed drop → revert). */
  private handDrag: HandDragHooks | null = null;
  /** DOM zones that can absorb a dropped card (registered by the Zones overlay). */
  private readonly dropTargets = new Set<CardDropTarget>();

  readonly hoveredId = signal<string | null>(null);
  readonly draggingId = signal<string | null>(null);
  /** The card currently being dragged, drawn as a cursor-following DOM ghost. */
  readonly dragGhost = signal<DragGhost | null>(null);
  readonly contextMenu = signal<OverlayAnchor | null>(null);
  readonly viewCardId = signal<string | null>(null);
  readonly relatedPanel = signal<OverlayAnchor | null>(null);
  readonly utilWindow = signal<UtilAnchor | null>(null);

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
    if (this.contextMenu()?.id === id) this.contextMenu.set(null);
    if (this.viewCardId() === id) this.viewCardId.set(null);
    if (this.relatedPanel()?.id === id) this.relatedPanel.set(null);
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

  /** End the active drag: clear the drag id and the DOM ghost together. */
  private endDrag(): void {
    this.draggingId.set(null);
    this.dragGhost.set(null);
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
    this.hoveredId.set(null);
    this.handDrag = hooks;
    this.draggingId.set(id);
    this.dragTo(id, event);
  }

  /** Run a card action; menu/hotkeys both land here. Closes the menu it came from. */
  act(cardId: string, action: CardAction): void {
    this.contextMenu.set(null);
    const card = this.store.card(cardId);
    if (!card) return;
    switch (action) {
      case 'view':
        this.viewCardId.set(cardId);
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
        const anchor = this.anchorFor(cardId);
        if (anchor) this.relatedPanel.set(anchor);
        break;
      }
      case 'toHand':
        this.zones.takeFromTable(card, 'hand');
        break;
      case 'toDeck':
        this.zones.takeFromTable(card, 'deck');
        break;
      case 'toGrave':
        this.zones.takeFromTable(card, 'graveyard');
        break;
      case 'delete':
        this.store.remove(cardId); // Card's destroy calls unregister, clearing stale state
        this.room.sendAction(`removed ${card.name}`);
        break;
    }
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
      // The press travelled: it's a drag, not a tap.
      this.pressed = null;
      this.draggingId.set(pressed.id);
      this.hoveredId.set(null); // moving clears highlights
      this.dragTo(pressed.id, event);
      return;
    }
    // Hover only from moves over the canvas itself, not the DOM overlays.
    if (event.target === this.canvas) this.hoveredId.set(this.pick(event));
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.draggingId()) return;
    this.contextMenu.set(null);
    this.relatedPanel.set(null);
    this.utilWindow.set(null);
    const picked = this.pick(event);
    if (picked) this.pressed = { id: picked, x: event.clientX, y: event.clientY };
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const pressed = this.pressed;
    this.pressed = null;
    const draggingId = this.draggingId();
    if (draggingId) {
      const handDrag = this.handDrag;
      this.handDrag = null;
      // A drop over a UI zone (hand/deck/graveyard) sends the card there,
      // taking priority over placing it on the table below.
      const card = this.store.card(draggingId);
      const target = card ? this.dropTargetAt(event.clientX, event.clientY) : null;
      if (target && card) {
        this.store.clearPreview(draggingId);
        this.endDrag();
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
        // Snap back to where the card was picked up.
        this.store.clearPreview(draggingId);
        this.endDrag();
      }
      return;
    }
    if (pressed) this.toggleTap(pressed.id);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.draggingId() || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.relatedPanel.set(null);
    const picked = this.pick(event);
    if (picked) {
      this.utilWindow.set(null);
      this.contextMenu.set({ id: picked, x: x + 8, y });
    } else {
      // Empty table: open the util window (card search) at the clicked spot;
      // added objects appear where the ray meets the table.
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
      const draggingId = this.draggingId();
      if (draggingId) {
        // Cancel the move: back to the shared state (table pose) or, for a
        // card being played from the hand, back into the hand.
        const handDrag = this.handDrag;
        this.handDrag = null;
        this.endDrag();
        if (handDrag) handDrag.revert();
        else this.store.clearPreview(draggingId);
      }
      this.contextMenu.set(null);
      this.relatedPanel.set(null);
      this.utilWindow.set(null);
      return;
    }
    const action = HOTKEYS[event.key];
    const hoveredId = this.hoveredId();
    if (!action || !hoveredId) return;
    event.preventDefault();
    this.act(hoveredId, action);
  };

  /** Follow the cursor: intersect its ray with the horizontal plane at DRAG_Y,
   * and update the DOM ghost that renders the dragged card on top of the UI. */
  private dragTo(id: string, event: MouseEvent): void {
    const card = this.store.card(id);
    this.dragGhost.set({
      src: card?.src ?? '',
      faceUp: card?.faceUp ?? true,
      x: event.clientX,
      y: event.clientY,
    });
    if (!this.setRayFromCursor(event)) return;
    if (this.raycaster.ray.intersectPlane(DRAG_PLANE, this.hit)) {
      this.store.preview(id, { position: [this.hit.x, DRAG_Y, this.hit.z] });
    }
  }

  /**
   * Drop the card where the ray from the camera through the cursor (Unity's
   * `Camera.ScreenPointToRay`) hits the world — table, floor, or another card
   * (stacking) — committing the move to the shared state. Returns false when
   * the ray hits nothing placeable, leaving the card picked up; callers decide
   * whether that means snap back (table drag) or revert to hand (hand drag).
   */
  private tryPlace(id: string, event: MouseEvent): boolean {
    if (!this.setRayFromCursor(event)) return false;
    const targets = [
      ...this.surfaces,
      ...[...this.objectsById.entries()].filter(([other]) => other !== id).map(([, o]) => o),
    ];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return false;
    this.store.update(id, {
      position: [hit.point.x, hit.point.y + PLACE_OFFSET, hit.point.z],
    });
    this.endDrag();
    return true;
  }

  /** A click (press released without dragging) taps/untaps a card: a quarter
   * turn tracked in state so every player sees it. */
  private toggleTap(id: string): void {
    const card = this.store.card(id);
    if (!card) return;
    this.store.update(id, { tapped: !card.tapped });
    this.room.sendAction(`${card.tapped ? 'untapped' : 'tapped'} ${card.name}`);
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
  private anchorFor(cardId: string): OverlayAnchor | null {
    const card = this.store.card(cardId);
    if (!card || !this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const projected = new Vector3(...card.position).project(this.camera);
    return {
      id: cardId,
      x: ((projected.x + 1) / 2) * rect.width + 24,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  }
}
