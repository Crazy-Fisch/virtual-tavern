import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three';
import { vi } from 'vitest';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { AssetLoaderService } from '../asset-loader.service';
import { SceneCamera } from '../scene-camera';
import { SceneGraph } from '../scene-graph';
import { Card } from './card';
import { CardInteractions } from './card-interactions';
import { CardStore } from './card-store';
import { CardState } from './card.types';

/** Mirrors the real Card.glb: a stray cube next to the card node with 3 face materials. */
function makeCardModel(): Group {
  const root = new Group();
  const stray = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  stray.name = 'Cube';
  const cardNode = new Group();
  cardNode.name = 'MagicCardMesh';
  for (const name of ['CardArtwork', 'CardBack', 'CardSide']) {
    const material = new MeshStandardMaterial();
    material.name = name;
    const mesh = new Mesh(new BoxGeometry(), material);
    mesh.name = name;
    cardNode.add(mesh);
  }
  root.add(stray, cardNode);
  return root;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r));
};

const baseState = (): CardState => ({
  id: 'card-1',
  name: 'Water Worm',
  src: 'https://example.com/front.jpg',
  position: [0, 0.5, 0],
  yaw: 0,
  faceUp: true,
  tapped: false,
  relatedIds: [],
});

describe('Card', () => {
  let graph: SceneGraph;
  let interactions: CardInteractions;
  let textures: Map<string, Texture>;
  let loadTexture: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<Card>;

  beforeEach(async () => {
    textures = new Map();
    loadTexture = vi.fn(async (url: string) => {
      const t = textures.get(url) ?? new Texture();
      textures.set(url, t);
      return t;
    });
    TestBed.configureTestingModule({
      providers: [
        SceneGraph,
        SceneCamera,
        CardStore,
        CardInteractions,
        { provide: RoomService, useValue: new FakeRoomService() },
        {
          provide: AssetLoaderService,
          useValue: { load: vi.fn(async () => makeCardModel()), loadTexture },
        },
      ],
    });
    graph = TestBed.inject(SceneGraph);
    interactions = TestBed.inject(CardInteractions);
    fixture = TestBed.createComponent(Card);
    fixture.componentRef.setInput('state', baseState());
    fixture.detectChanges();
    await flush();
  });

  function frontMesh(): Mesh {
    let found: Mesh | undefined;
    graph.root.traverse((obj) => {
      if (
        obj instanceof Mesh &&
        !Array.isArray(obj.material) &&
        obj.material.name === 'CardArtwork'
      ) {
        found = obj;
      }
    });
    expect(found).toBeDefined();
    return found!;
  }

  it('spawns only the card node into the scene graph, positioned above the table', () => {
    expect(graph.root.children).toHaveLength(1);
    const wrapper = graph.root.children[0]!;
    expect(wrapper.position.y).toBeGreaterThan(0);
    const names: string[] = [];
    wrapper.traverse((o) => names.push(o.name));
    expect(names).toContain('MagicCardMesh');
    expect(names).not.toContain('Cube'); // stray sibling mesh dropped
  });

  it('applies the state image to a per-instance clone of the front material', () => {
    const front = frontMesh();
    const material = front.material as MeshStandardMaterial;
    expect(loadTexture).toHaveBeenCalledWith('https://example.com/front.jpg');
    expect(material.map).toBe(textures.get('https://example.com/front.jpg'));
  });

  it('swaps the front texture when the state src changes', async () => {
    fixture.componentRef.setInput('state', {
      ...baseState(),
      src: 'https://example.com/other.jpg',
    });
    fixture.detectChanges();
    await flush();
    expect(loadTexture).toHaveBeenCalledWith('https://example.com/other.jpg');
    const material = frontMesh().material as MeshStandardMaterial;
    expect(material.map).toBe(textures.get('https://example.com/other.jpg'));
  });

  it('follows position, yaw, and flip from state', async () => {
    fixture.componentRef.setInput('state', {
      ...baseState(),
      position: [1, 0.3, -0.5],
      yaw: Math.PI,
      faceUp: false,
    });
    fixture.detectChanges();
    await flush();
    const wrapper = graph.root.children[0]!;
    expect(wrapper.position.x).toBeCloseTo(1);
    expect(wrapper.position.y).toBeCloseTo(0.3);
    expect(wrapper.position.z).toBeCloseTo(-0.5);
    expect(wrapper.rotation.y).toBeCloseTo(Math.PI);
    expect(wrapper.rotation.x).toBeCloseTo(Math.PI / 2); // turned over
  });

  it('a tapped card turns a quarter turn on top of its yaw', async () => {
    fixture.componentRef.setInput('state', { ...baseState(), tapped: true });
    fixture.detectChanges();
    await flush();
    const wrapper = graph.root.children[0]!;
    expect(wrapper.rotation.y).toBeCloseTo(-Math.PI / 2);
    fixture.componentRef.setInput('state', baseState());
    fixture.detectChanges();
    await flush();
    expect(wrapper.rotation.y).toBeCloseTo(0);
  });

  it('tints all materials while hovered and clears the tint after', async () => {
    interactions.hoveredId.set('card-1');
    fixture.detectChanges();
    await flush();
    const material = frontMesh().material as MeshStandardMaterial;
    expect(material.emissive.getHex()).toBeGreaterThan(0);
    interactions.hoveredId.set(null);
    fixture.detectChanges();
    await flush();
    expect(material.emissive.getHex()).toBe(0);
  });

  it('removes its object, unregisters, and disposes only its own materials on destroy', () => {
    const material = frontMesh().material as MeshStandardMaterial;
    const dispose = vi.spyOn(material, 'dispose');
    interactions.hoveredId.set('card-1');
    fixture.destroy();
    expect(graph.root.children).toHaveLength(0);
    expect(dispose).toHaveBeenCalled();
    expect(interactions.hoveredId()).toBeNull(); // unregister clears stale hover
  });
});
