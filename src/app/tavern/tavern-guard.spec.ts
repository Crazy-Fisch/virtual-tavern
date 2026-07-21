import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { UrlTree, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { RoomService } from '../room/room.service';
import { tavernGuard } from './tavern-guard';

function runGuard(joined: boolean, resume: boolean): Promise<boolean | UrlTree> {
  const resumeFn = vi.fn(async () => resume);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: RoomService, useValue: { joined: () => joined, resume: resumeFn } },
    ],
  });
  return TestBed.runInInjectionContext(() =>
    tavernGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  ) as Promise<boolean | UrlTree>;
}

describe('tavernGuard', () => {
  it('allows activation when a room is joined', async () => {
    expect(await runGuard(true, false)).toBe(true);
  });

  it('allows activation when the previous room can be resumed', async () => {
    expect(await runGuard(false, true)).toBe(true);
  });

  it('redirects to the menu when there is no room and nothing to resume', async () => {
    const result = await runGuard(false, false);
    expect(result).toBeInstanceOf(UrlTree);
    expect(result.toString()).toBe('/');
  });
});
