import { TestBed } from '@angular/core/testing';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { vi } from 'vitest';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { ZoneStore } from '../../zones/zone-store';
import { ItemStore } from '../item/item-store';
import { newItem } from '../item/item.types';
import { SceneCamera } from '../scene-camera';
import { CardInteractions } from './card-interactions';
import { CardStore } from './card-store';
import { newCardId } from './card.types';

describe('CardInteractions', () => {
  let interactions: CardInteractions;
  let store: CardStore;
  let items: ItemStore;
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
    items = TestBed.inject(ItemStore);
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

  it('toExile moves the card off the table into my exile zone', () => {
    interactions.act(cardId, 'toExile');
    expect(store.card(cardId)).toBeUndefined();
    expect(zones.mine().exile).toMatchObject([{ name: 'Water Worm' }]);
    expect(room.actions).toEqual(['exiled Water Worm']);
  });

  it('a card leaving the table takes the counters attached to it along', () => {
    const counter = newItem('counter', [0, 0.5, 0]);
    items.add(counter);
    items.update(counter.id, { attachedTo: cardId });
    interactions.act(cardId, 'toGrave');
    expect(items.item(counter.id)).toBeUndefined();
  });

  it('unregister clears every reference to that object', () => {
    interactions.register(cardId, new Group());
    interactions.hoveredId.set(cardId);
    interactions.draggingId.set(cardId);
    interactions.contextMenu.set({ id: cardId, x: 0, y: 0 });
    interactions.viewCardId.set(cardId);
    interactions.relatedPanel.set({ ids: [cardId], x: 0, y: 0 });
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
    interactions.relatedPanel.set({ ids: [cardId], x: 0, y: 0 });
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
      const sceneCamera = TestBed.inject(SceneCamera);
      sceneCamera.setAspect(WIDTH / HEIGHT);
      const camera = sceneCamera.camera;
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

    it('a drag released over a registered drop target routes the card there, not the table', () => {
      const accept = vi.fn();
      const target = { hitTest: () => true, accept };
      interactions.registerDropTarget(target);
      down(screenAt(0, 0.5, 0));
      move(screenAt(2, 0, 1));
      up(screenAt(2, 0, 1));
      expect(accept).toHaveBeenCalledOnce();
      expect((accept.mock.calls[0]![0] as { id: string }).id).toBe(cardId);
      expect(store.card(cardId)!.position).toEqual([0, 0.5, 0]); // not placed on the table
      expect(interactions.draggingId()).toBeNull();
      interactions.unregisterDropTarget(target);
    });

    it('exposes a cursor-following drag ghost while dragging and clears it on drop', () => {
      down(screenAt(0, 0.5, 0));
      move(screenAt(2, 0, 1));
      expect(interactions.dragGhost()).not.toBeNull();
      expect(interactions.dragGhost()!.src).toBe('https://example.com/worm.jpg');
      up(screenAt(2, 0, 1));
      expect(interactions.dragGhost()).toBeNull();
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

    /** A card freshly played from the hand UI, mid-drag via beginDragFromHand.
     * Local-only, like Zones.beginPlay spawns it — nothing on the network yet. */
    function beginHandDrag(at: { clientX: number; clientY: number }) {
      const playedId = newCardId();
      store.addLocal({
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

    it('a hand card stays off the network until the drop lands (game stability)', () => {
      const at = screenAt(-1, 0, 2);
      const { playedId } = beginHandDrag(at);
      // Mid-drag: visible locally, but the shared world has never seen it.
      expect(store.card(playedId)).toBeDefined();
      expect(room.worldState()[playedId]).toBeUndefined();
      up(at);
      expect(room.worldState()[playedId]).toBeDefined();
    });

    it('a hand card released off the table reverts into the hand', () => {
      const offTable = screenAt(15, 0, 15); // beyond the 20×20 surface
      const { hooks } = beginHandDrag(offTable);
      up(offTable);
      expect(hooks.revert).toHaveBeenCalledOnce();
      expect(hooks.commit).not.toHaveBeenCalled();
      expect(interactions.draggingId()).toBeNull();
    });

    it('a hand card dropped onto a zone widget is absorbed without a table trace', () => {
      const accept = vi.fn();
      const target = { hitTest: () => true, accept };
      interactions.registerDropTarget(target);
      const at = screenAt(-1, 0, 2);
      const { playedId } = beginHandDrag(at);
      up(at);
      expect(accept).toHaveBeenCalledOnce();
      expect(store.card(playedId)).toBeUndefined(); // local copy discarded
      expect(room.worldState()[playedId]).toBeUndefined(); // never networked
      interactions.unregisterDropTarget(target);
    });

    it('Escape cancels a hand drag back into the hand', () => {
      const { hooks } = beginHandDrag(screenAt(0, 0, 0));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(hooks.revert).toHaveBeenCalledOnce();
      expect(interactions.draggingId()).toBeNull();
    });

    /**
     * A pickable object at a world position, standing in for a rendered
     * card/item. Returned so a test can move it where the real component would
     * (the scene objects follow state; nothing here does).
     */
    function registerObject(id: string, position: [number, number, number]): Group {
      const object = new Group();
      object.add(new Mesh(new BoxGeometry(0.6, 0.04, 0.9), new MeshBasicMaterial()));
      object.position.set(...position);
      object.updateMatrixWorld(true);
      interactions.register(id, object);
      return object;
    }

    /** A second table card, registered for picking. */
    function addSecondCard(position: [number, number, number] = [1, 0.5, 0]): string {
      const id = newCardId();
      store.add({
        id,
        name: 'Second',
        src: '',
        position,
        yaw: 0,
        faceUp: true,
        tapped: false,
        relatedIds: [],
      });
      registerObject(id, position);
      return id;
    }

    /** Drag a marquee across empty table between two world points. */
    function marqueeBetween(from: [number, number, number], to: [number, number, number]): void {
      down(screenAt(...from));
      move(screenAt(...to));
      up(screenAt(...to));
    }

    describe('selection (cardselection.md)', () => {
      it('dragging over empty table selects every card whose origin it covers', () => {
        const second = addSecondCard();
        const outside = addSecondCard([6, 0.5, 0]); // beyond the marquee
        down(screenAt(-2, 0, -2));
        move(screenAt(2, 0, 2));
        expect(interactions.marquee()).not.toBeNull();
        up(screenAt(2, 0, 2));
        expect(interactions.marquee()).toBeNull();
        expect([...interactions.selectedIds()].sort()).toEqual([cardId, second].sort());
        expect(interactions.isSelected(outside)).toBe(false);
      });

      it('a click on empty table clears the selection', () => {
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        expect(interactions.selectedIds().size).toBeGreaterThan(0);
        const at = screenAt(-2, 0, -2);
        down(at);
        up(at);
        expect(interactions.selectedIds().size).toBe(0);
      });

      it('dragging one selected card moves the whole selection, keeping offsets', () => {
        const second = addSecondCard();
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        const target = screenAt(2, 0, 1);
        down(screenAt(0, 0.5, 0));
        move(target);
        expect(interactions.dragGhost()).toBeNull(); // a group stays 3D, no ghost
        up(target);
        const moved = store.card(cardId)!;
        const follower = store.card(second)!;
        expect(moved.position[0]).toBeCloseTo(2, 3);
        expect(moved.position[2]).toBeCloseTo(1, 3);
        expect(follower.position[0]).toBeCloseTo(3, 3); // kept its +1 offset
        expect(follower.position[2]).toBeCloseTo(1, 3);
        expect(follower.position[1]).toBeCloseTo(moved.position[1], 5);
      });

      it('clicking one card of a selection taps only that card and keeps the selection', () => {
        const second = addSecondCard();
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        const at = screenAt(0, 0.5, 0);
        down(at);
        up(at);
        expect(store.card(cardId)!.tapped).toBe(true);
        expect(store.card(second)!.tapped).toBe(false);
        expect(interactions.selectedIds().size).toBe(2);
      });

      it('group actions hit the whole selection; other actions drop it and hit one card', () => {
        const second = addSecondCard();
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        interactions.act(cardId, 'tap');
        expect(store.card(cardId)!.tapped).toBe(true);
        expect(store.card(second)!.tapped).toBe(true);

        interactions.act(cardId, 'flip'); // not a group action
        expect(store.card(cardId)!.faceUp).toBe(false);
        expect(store.card(second)!.faceUp).toBe(true);
        expect(interactions.selectedIds().size).toBe(0);
      });

      it('deleting through a selection removes every selected card', () => {
        const second = addSecondCard();
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        interactions.act(second, 'delete');
        expect(store.card(cardId)).toBeUndefined();
        expect(store.card(second)).toBeUndefined();
        expect(interactions.selectedIds().size).toBe(0);
      });

      it('the related panel of a selection lists every selected card as an owner', () => {
        const second = addSecondCard();
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        interactions.act(cardId, 'related');
        expect([...interactions.relatedPanel()!.ids].sort()).toEqual([cardId, second].sort());
      });

      it('grabbing or right-clicking a card outside the selection drops it', () => {
        const outside = addSecondCard([6, 0.5, 0]);
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        expect(interactions.isSelected(cardId)).toBe(true);
        canvas.dispatchEvent(new MouseEvent('contextmenu', screenAt(6, 0.5, 0)));
        expect(interactions.selectedIds().size).toBe(0);
        expect(interactions.contextMenu()!.id).toBe(outside);
      });
    });

    describe('table items (additionalitems.md)', () => {
      /** An item on the table, registered for picking; the Group is its stand-in mesh. */
      function addItem(
        kind: 'counter' | 'd6',
        position: [number, number, number],
      ): { id: string; object: Group } {
        const item = newItem(kind, position);
        items.add(item);
        const object = registerObject(item.id, position);
        room.actions.length = 0;
        return { id: item.id, object };
      }

      it('left-click counts a counter up, right-click counts it down', () => {
        const { id } = addItem('counter', [2, 0.21, 0]);
        const at = screenAt(2, 0.21, 0);
        down(at);
        up(at);
        expect(items.item(id)!.value).toBe(2);
        canvas.dispatchEvent(new MouseEvent('contextmenu', at));
        expect(items.item(id)!.value).toBe(1);
        expect(interactions.itemMenu()).toBeNull(); // counters have no menu
      });

      it('right-clicking a die opens the item menu, and Roll changes its facing', () => {
        const { id } = addItem('d6', [2, 0.21, 0]);
        canvas.dispatchEvent(new MouseEvent('contextmenu', screenAt(2, 0.21, 0)));
        expect(interactions.itemMenu()!.id).toBe(id);
        expect(interactions.contextMenu()).toBeNull();
        interactions.itemAct(id, 'roll');
        expect(items.item(id)!.rotation).not.toEqual([0, 0, 0]);
        expect(interactions.itemMenu()).toBeNull();
        expect(room.actions.at(-1)).toMatch(/^rolled [1-6] on a d6$/);
      });

      it('the delete hotkey removes a hovered item', () => {
        const { id } = addItem('d6', [2, 0.21, 0]);
        interactions.hoveredId.set(id);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
        expect(items.item(id)).toBeUndefined();
        expect(room.actions).toEqual(['removed a d6']);
      });

      it('a counter dropped on a card attaches to it as an offset, and detaches elsewhere', () => {
        const { id, object } = addItem('counter', [2, 0.21, 0]);
        down(screenAt(2, 0.21, 0));
        move(screenAt(0, 0.5, 0));
        up(screenAt(0, 0.5, 0));
        const attached = items.item(id)!;
        expect(attached.attachedTo).toBe(cardId);
        expect(attached.position[0]).toBeCloseTo(0, 1); // offset from the card's origin
        expect(attached.position[2]).toBeCloseTo(0, 1);

        // The rendered object follows the state in the app; do it by hand here.
        object.position.set(1, 0.4, 0);
        object.updateMatrixWorld(true);
        down(screenAt(1, 0.4, 0));
        move(screenAt(3, 0, 2));
        up(screenAt(3, 0, 2));
        const loose = items.item(id)!;
        expect(loose.attachedTo).toBeNull();
        expect(loose.position[0]).toBeCloseTo(3, 3);
      });

      describe('spawn drag (tableitems.md)', () => {
        it('a util-window spawn follows the cursor locally and a click places and logs it', () => {
          const item = newItem('d6', [0, 0.5, 0]);
          interactions.beginSpawnDrag(item);
          expect(interactions.draggingId()).toBe(item.id);
          move(screenAt(2, 0, 1));
          // Mid-spawn: visible on this client, but the shared world has never seen it.
          expect(items.item(item.id)).toBeDefined();
          expect(room.worldState()[item.id]).toBeUndefined();
          down(screenAt(2, 0, 1));
          up(screenAt(2, 0, 1));
          const placed = items.item(item.id)!;
          expect(room.worldState()[item.id]).toBeDefined();
          expect(placed.position[0]).toBeCloseTo(2, 3);
          expect(placed.position[2]).toBeCloseTo(1, 3);
          expect(interactions.draggingId()).toBeNull();
          expect(room.actions).toEqual(['added a d6']);
        });

        it('a spawn click that hits nothing placeable keeps the item on the cursor', () => {
          const item = newItem('coin', [0, 0.5, 0]);
          interactions.beginSpawnDrag(item);
          const offTable = screenAt(15, 0, 15); // beyond the 20×20 surface
          move(offTable);
          down(offTable);
          up(offTable);
          expect(interactions.draggingId()).toBe(item.id); // still attached
          expect(room.worldState()[item.id]).toBeUndefined();
          expect(room.actions).toEqual([]);
        });

        it('Escape discards an unplaced spawn without a trace', () => {
          const item = newItem('counter', [0, 0.5, 0]);
          interactions.beginSpawnDrag(item);
          move(screenAt(2, 0, 1));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          expect(interactions.draggingId()).toBeNull();
          expect(items.item(item.id)).toBeUndefined();
          expect(room.worldState()[item.id]).toBeUndefined();
          expect(room.actions).toEqual([]);
        });

        it('a spawned counter clicked onto a card attaches to it', () => {
          const item = newItem('counter', [0, 0.5, 0]);
          interactions.beginSpawnDrag(item);
          const onCard = screenAt(0, 0.5, 0); // the Water Worm's object
          move(onCard);
          down(onCard);
          up(onCard);
          const placed = items.item(item.id)!;
          expect(placed.attachedTo).toBe(cardId);
          expect(room.actions).toEqual(['added a +1/+1 counter']);
        });
      });

      it('items are never picked up by a marquee — a selection is cards only', () => {
        const { id } = addItem('counter', [1, 0.21, 0]);
        marqueeBetween([-2, 0, -2], [2, 0, 2]);
        expect(interactions.isSelected(id)).toBe(false);
        expect(interactions.isSelected(cardId)).toBe(true);
      });
    });
  });
});
