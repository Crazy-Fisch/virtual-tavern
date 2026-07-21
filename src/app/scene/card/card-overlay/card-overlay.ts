import { Component, computed, inject } from '@angular/core';
import { Dialog } from '../../../shared/dialog/dialog';
import { CardInteractions } from '../card-interactions';
import { CardStore } from '../card-store';
import { CardAction, CardState } from '../card.types';

/**
 * DOM-side table-object UI (plain Angular/HTML, not Three): the right-click
 * context menu for cards, the related-cards window, and the large card view
 * dialog. Reads its state from CardInteractions; positions are CSS px relative
 * to the Scene host, which this overlay spans.
 */
@Component({
  selector: 'app-card-overlay',
  imports: [Dialog],
  templateUrl: './card-overlay.html',
  styleUrl: './card-overlay.scss',
  standalone: true,
})
export class CardOverlay {
  protected readonly interactions = inject(CardInteractions);
  private readonly store = inject(CardStore);

  protected readonly cardMenu = computed(() => {
    const anchor = this.interactions.contextMenu();
    if (!anchor) return null;
    const card = this.store.card(anchor.id);
    return card ? { ...anchor, card } : null;
  });

  protected readonly viewCard = computed(() => {
    const id = this.interactions.viewCardId();
    return id ? (this.store.card(id) ?? null) : null;
  });

  protected readonly related = computed(() => {
    const anchor = this.interactions.relatedPanel();
    if (!anchor) return null;
    const owner = this.store.card(anchor.id);
    if (!owner) return null;
    const cards = owner.relatedIds
      .map((id) => this.store.card(id))
      .filter((c): c is CardState => c !== undefined);
    return { ...anchor, cards };
  });

  protected act(cardId: string, action: CardAction): void {
    this.interactions.act(cardId, action);
  }

  protected view(cardId: string): void {
    this.interactions.viewCardId.set(cardId);
  }

  protected closeView(): void {
    this.interactions.viewCardId.set(null);
  }

  protected closeRelated(): void {
    this.interactions.relatedPanel.set(null);
  }
}
