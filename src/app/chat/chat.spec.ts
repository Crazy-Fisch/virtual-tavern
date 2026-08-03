import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { P2pService } from '../p2p/p2p.service';
import { RoomService } from '../room/room.service';
import { ChatMessage } from '../room/room.types';
import { Chat } from './chat';

const MESSAGES: ChatMessage[] = [
  { id: 'm1', from: 'user-1', name: 'Tim', text: 'hello', kind: 'chat', t: 1 },
  { id: 'm2', from: 'user-2', name: 'Ana', text: 'played Water Worm', kind: 'action', t: 2 },
  { id: 'm3', from: 'user-2', name: 'Ana', text: 'hi back', kind: 'chat', t: 3 },
];

describe('Chat', () => {
  function setup() {
    const room = {
      currentRoom: signal({ id: 'r1', code: 'ABC123', name: 'Tavern', ownerId: 'user-1' }),
      messages: signal(MESSAGES),
      userId: signal('user-1'),
      sendChat: vi.fn(),
      leave: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: RoomService, useValue: room },
        { provide: P2pService, useValue: { peerCount: signal(0) } },
      ],
    });
    const fixture = TestBed.createComponent(Chat);
    fixture.detectChanges();
    return { fixture, room };
  }

  const host = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;
  const texts = (fixture: { nativeElement: unknown }) =>
    [...host(fixture).querySelectorAll('.msg')].map((el) => el.textContent?.trim());

  it('opens on the Chat tab, showing only user-typed messages', () => {
    const { fixture } = setup();
    expect(texts(fixture)).toEqual(['Timhello', 'Anahi back']);
  });

  it('the History tab shows only the action lines', () => {
    const { fixture } = setup();
    const historyTab = [...host(fixture).querySelectorAll('.tab')].find((b) =>
      b.textContent?.includes('History'),
    ) as HTMLButtonElement;
    historyTab.click();
    fixture.detectChanges();
    expect(texts(fixture)).toEqual(['Ana: played Water Worm']);
  });
});
