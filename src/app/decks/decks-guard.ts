import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Decks are an account feature (persisted per signed-in user): guests and
 * signed-out visitors are sent back to the menu, mirroring the hidden Decks
 * button there.
 */
export const decksGuard: CanActivateFn = () => {
  const supabase = inject(SupabaseService);
  if (supabase.session() && !supabase.isGuest()) return true;
  return inject(Router).createUrlTree(['/']);
};
