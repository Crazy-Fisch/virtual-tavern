import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RoomService } from '../room/room.service';

/**
 * /tavern needs an active room. On a page reload the in-memory room is gone,
 * so the guard first tries to resume the previous room (stored unless the user
 * explicitly left); only when that fails does it redirect to the menu.
 */
export const tavernGuard: CanActivateFn = async () => {
  const room = inject(RoomService);
  const router = inject(Router);
  if (room.joined() || (await room.resume())) return true;
  return router.createUrlTree(['/']);
};
