import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Decks are available to everyone signed in — guests keep them in the browser,
 * accounts in the cloud. Only fully signed-out visitors (no session at all) are
 * sent back to the menu, mirroring the hidden Decks button there.
 */
export const decksGuard: CanActivateFn = () => {
  const supabase = inject(SupabaseService);
  if (supabase.session()) return true;
  return inject(Router).createUrlTree(['/']);
};
