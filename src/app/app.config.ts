import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { CardDatabaseService } from './carddb/card-database.service';
import { SupabaseService } from './supabase/supabase.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // Restore the persisted Supabase session before first render.
    provideAppInitializer(() => inject(SupabaseService).init()),
    // Create the card database early: it follows the user-deposited card API
    // by effect (legal.md) and loads/downloads only once one exists —
    // deliberately never awaited, a first-run download must not block boot.
    provideAppInitializer(() => {
      inject(CardDatabaseService);
    }),
  ],
};
