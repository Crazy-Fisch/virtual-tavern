import { TestBed } from '@angular/core/testing';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { vi } from 'vitest';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { ZoneStore } from '../../zones/zone-store';
import { SceneCamera } from '../scene-camera';
import { CardInteractions } from './card-interactions';
import { CardStore } from './card-store';
import { newCardId } from './card.types';

describe('CardInteractions', () => {
  let interactions: CardInteractions;
  let store: CardStore;
  let zones: ZoneStore;
  let room: FakeRoomService;
  let cardId: string;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    room = new FakeRoomService();
    TestBed.configureTestingModule({
      providers: [
        SceneCamera,
        CardStore,
        CardInteractions,
        { provide: RoomService, useValue: room },
      ],
    });
    interactions = TestBed.inject(CardInteractions);
    store = TestBed.inject(CardStore);
    zones = TestBed.inject(ZoneStore);
    cardId = newCardId();
    store.add({
      id: cardId,
      name: 'Water Worm',
      src: 'https://example.com/worm.jpg',
      position: [0, 0.5, 0],
      yaw: 0,
      faceUp: true,
      tapped: false,
      relatedIds: [],
    });
    room.actions.length = 0; // only assert on actions triggered by the test itself
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    interactions.attach(canvas);
  });

  afterEach(() => {
    interactions.detach();
    canvas.remove();
  });

  it('rotate adds a half turn, flip toggles facing — both logged to history', () => {
    interactions.act(cardId, 'rotate');
    expect(store.card(cardId)!.yaw).toBeCloseTo(Math.PI);
    interactions.act(cardId, 'flip');
    expect(store.card(cardId)!.faceUp).toBe(false);
    interactions.act(cardId, 'flip');
    expect(store.card(cardId)!.faceUp).toBe(true);
    expect(room.actions).toEqual([
      'rotated Water Worm',
      'turned Water Worm face down',
      'turned Water Worm face up',
    ]);
  });

  it('view opens the view dialog and closes the context menu', () => {
    interactions.contextMenu.set({ id: cardId, x: 10, y: 10 });
    interactions.act(cardId, 'view');
    expect(interactions.viewCardId()).toBe(cardId);
    expect(interactions.contextMenu()).toBeNull();
  });

  it('delete removes the card from the shared state and logs it', () => {
    interactions.act(cardId, 'delete');
    expect(store.card(cardId)).toBeUndefined();
    expect(room.actions).toEqual(['removed Water Worm']);
  });

  it('toGrave moves the card off the table into my graveyard zone', () => {
    interactions.act(cardId, 'toGrave');
    expect(store.card(cardId)).toBeUndefined();
    expect(zones.mine().graveyard).toMatchObject([{ name: 'Water Worm' }]);
    expect(room.actions).toEqual(['put Water Worm into their graveyard']);
  });

  it('unregister clears every reference to that object', () => {
    interactions.register(cardId, new Group());
    interactions.hoveredId.set(cardId);
    interactions.draggingId.set(cardId);
    interactions.contextMenu.set({ id: cardId, x: 0, y: 0 });
    interactions.viewCardId.set(cardId);
    interactions.relatedPanel.set({ id: cardId, x: 0, y: 0 });
    interactions.unregister(cardId);
    expect(interactions.hoveredId()).toBeNull();
    expect(interactions.draggingId()).toBeNull();
    expect(interactions.contextMenu()).toBeNull();
    expect(interactions.viewCardId()).toBeNull();
    expect(interactions.relatedPanel()).toBeNull();
  });

  it('hotkeys act on the hovered card', () => {
    interactions.hoveredId.set(cardId);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    expect(store.card(cardId)!.faceUp).toBe(false);
  });

  it('hotkeys are ignored while typing in an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    interactions.hoveredId.set(cardId);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    expect(store.card(cardId)!.faceUp).toBe(true);
    input.remove();
  });

  it('Escape closes the popups', () => {
    interactions.contextMenu.set({ id: cardId, x: 0, y: 0 });
    interactions.relatedPanel.set({ id: cardId, x: 0, y: 0 });
    interactions.utilWindow.set({ x: 0, y: 0, world: [0, 0.5, 0] });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(interactions.contextMenu()).toBeNull();
    expect(interactions.relatedPanel()).toBeNull();
    expect(interactions.utilWindow()).toBeNull();
  });

  it('Escape cancels a move: the drag preview is dropped, not committed', () => {
    interactions.draggingId.set(cardId);
    store.preview(cardId, { position: [9, 0.8, 9] });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(interactions.draggingId()).toBeNull();
    expect(store.card(cardId)!.position).toEqual([0, 0.5, 0]);
  });

  it('right-clicking empty table opens the util window at a world position', () => {
    canvas.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 30 }));
    const anchor = interactions.utilWindow();
    expect(anchor).not.toBeNull();
    expect(anchor!.world).toHaveLength(3);
    expect(interactions.contextMenu()).toBeNull();
  });

  describe('pointer flow (tap / drag / place)', () => {
    const WIDTH = 800;
    const HEIGHT = 600;

    beforeEach(() => {
      // jsdom's canvas has a zero rect, which disables every cursor ray; give
      // it a real one and pose the camera over the table like CameraRig does.
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: WIDTH,
        bottom: HEIGHT,
        width: WIDTH,
        height: HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
      const camera = TestBed.inject(SceneCamera).camera;
      camera.aspect = WIDTH / HEIGHT;
      camera.position.set(0, 8, 6);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      // A 20×20 table surface at y=0 and real geometry for the card, so the
      // camera-through-cursor rays have something to hit.
      const table = new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial());
      table.rotation.x = -Math.PI / 2;
      table.updateMatrixWorld(true);
      interactions.addSurface(table);
      const cardObject = new Group();
      cardObject.add(new Mesh(new BoxGeometry(0.6, 0.04, 0.9), new MeshBasicMaterial()));
      cardObject.position.set(0, 0.5, 0);
      cardObject.updateMatrixWorld(true);
      interactions.register(cardId, cardObject);
    });

    /** Client coordinates where a world point appears on screen. */
    function screenAt(x: number, y: number, z: number): { clientX: number; clientY: number } {
      const camera = TestBed.inject(SceneCamera).camera;
      const p = new Vector3(x, y, z).project(camera);
      return {
        clientX: ((p.x + 1) / 2) * WIDTH,
        clientY: ((1 - p.y) / 2) * HEIGHT,
      };
    }

    const down = (at: { clientX: number; clientY: number }) =>
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, ...at }));
    // Moves bubble like real pointer events: the drag-follow listener is on window.
    const move = (at: { clientX: number; clientY: number }) =>
      canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...at }));
    const up = (at: { clientX: number; clientY: number }) =>
      window.dispatchEvent(new MouseEvent('pointerup', { button: 0, ...at }));

    it('a click without dragging taps the card; a second click untaps it', () => {
      const at = screenAt(0, 0.5, 0);
      down(at);
      up(at);
      expect(store.card(cardId)!.tapped).toBe(true);
      expect(store.card(cardId)!.position).toEqual([0, 0.5, 0]); // tap is not a move
      down(at);
      up(at);
      expect(store.card(cardId)!.tapped).toBe(false);
      expect(room.actions).toEqual(['tapped Water Worm', 'untapped Water Worm']);
    });

    it('dragging places the card where the camera ray through the cursor hits the table', () => {
      const target = screenAt(2, 0, 1);
      down(screenAt(0, 0.5, 0));
      move(target);
      expect(interactions.draggingId()).toBe(cardId);
      up(target);
      const placed = store.card(cardId)!;
      expect(placed.position[0]).toBeCloseTo(2, 3);
      expect(placed.position[1]).toBeCloseTo(0.01, 3); // table + PLACE_OFFSET
      expect(placed.position[2]).toBeCloseTo(1, 3);
      expect(placed.tapped).toBe(false); // a drag is not a tap
      expect(interactions.draggingId()).toBeNull();
    });

    it('a drag released where the ray hits nothing snaps the card back', () => {
      const offTable = screenAt(15, 0, 15); // beyond the 20×20 surface
      down(screenAt(0, 0.5, 0));
      move(offTable);
      up(offTable);
      expect(store.card(cardId)!.position).toEqual([0, 0.5, 0]);
      expect(store.card(cardId)!.tapped).toBe(false);
      expect(interactions.draggingId()).toBeNull();
    });

    /** A card freshly played from the hand UI, mid-drag via beginDragFromHand. */
    function beginHandDrag(at: { clientX: number; clientY: number }) {
      const playedId = newCardId();
      store.add({
        id: playedId,
        name: 'Played',
        src: 'https://example.com/played.jpg',
        position: [0, 0.5, 0],
        yaw: 0,
        faceUp: true,
        tapped: false,
        relatedIds: [],
      });
      const hooks = { commit: vi.fn(), revert: vi.fn() };
      interactions.beginDragFromHand(
        playedId,
        new MouseEvent('pointermove', at) as PointerEvent,
        hooks,
      );
      return { playedId, hooks };
    }

    it('a hand card dragged onto the table places at the release point and commits', () => {
      const at = screenAt(-1, 0, 2);
      const { playedId, hooks } = beginHandDrag(at);
      expect(interactions.draggingId()).toBe(playedId);
      up(at);
      const placed = store.card(playedId)!;
      expect(placed.position[0]).toBeCloseTo(-1, 3);
      expect(placed.position[2]).toBeCloseTo(2, 3);
      expect(hooks.commit).toHaveBeenCalledOnce();
      expect(hooks.revert).not.toHaveBeenCalled();
      expect(interactions.draggingId()).toBeNull();
    });

    it('a hand card released off the table reverts into the hand', () => {
      const offTable = screenAt(15, 0, 15); // beyond the 20×20 surface
      const { hooks } = beginHandDrag(offTable);
      up(offTable);
      expect(hooks.revert).toHaveBeenCalledOnce();
      expect(hooks.commit).not.toHaveBeenCalled();
      expect(interactions.draggingId()).toBeNull();
    });

    it('Escape cancels a hand drag back into the hand', () => {
      const { hooks } = beginHandDrag(screenAt(0, 0, 0));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(hooks.revert).toHaveBeenCalledOnce();
      expect(interactions.draggingId()).toBeNull();
    });
  });
});
