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
    // Check/load the local card database — deliberately not awaited: first
    // run downloads the Scryfall bulk file, which must never block boot.
    provideAppInitializer(() => {
      void inject(CardDatabaseService).init();
    }),
  ],
};
