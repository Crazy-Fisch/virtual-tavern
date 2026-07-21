import { Routes } from '@angular/router';
import { Menu } from './menu/menu';
import { Decks } from './decks/decks';
import { decksGuard } from './decks/decks-guard';
import { Tavern } from './tavern/tavern';
import { tavernGuard } from './tavern/tavern-guard';

export const routes: Routes = [
  { path: '', component: Menu },
  { path: 'decks', component: Decks, canActivate: [decksGuard] },
  { path: 'tavern', component: Tavern, canActivate: [tavernGuard] },
  { path: '**', redirectTo: '' },
];
