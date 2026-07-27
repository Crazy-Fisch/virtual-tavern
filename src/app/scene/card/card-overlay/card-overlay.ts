import { Component, computed, inject } from '@angular/core';
import { Dialog } from '../../../shared/dialog/dialog';
import { ItemStore } from '../../item/item-store';
import { ItemAction, isDice } from '../../item/item.types';
import { CardInteractions } from '../card-interactions';
import { CardStore } from '../card-store';
import { CardAction, CardState } from '../card.types';

/**
 * DOM-side table-object UI (plain Angular/HTML, not Three): the right-click
 * context menu for cards, the selection marquee, the related-cards window, and
 * the large card view dialog. Reads its state from CardInteractions; positions
 * are CSS px relative to the Scene host, which this overlay spans.
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
  private readonly items = inject(ItemStore);

  /** The die or coin whose right-click menu is open, if any. */
  protected readonly itemMenu = computed(() => {
    const anchor = this.interactions.itemMenu();
    if (!anchor) return null;
    const item = this.items.item(anchor.id);
    return item ? { ...anchor, item, rollable: isDice(item.kind) } : null;
  });

  /**
   * The menu's card plus how many cards its group actions would hit — 1 for a
   * lone card, the selection size when the right-clicked card is part of one.
   */
  protected readonly cardMenu = computed(() => {
    const anchor = this.interactions.contextMenu();
    if (!anchor) return null;
    const card = this.store.card(anchor.id);
    if (!card) return null;
    const group = this.interactions.isSelected(anchor.id) ? this.interactions.selectionSize() : 1;
    return { ...anchor, card, group };
  });

  protected readonly viewCard = computed(() => {
    const id = this.interactions.viewCardId();
    return id ? (this.store.card(id) ?? null) : null;
  });

  /** Related cards of every owner in the panel (a selection contributes all of theirs). */
  protected readonly related = computed(() => {
    const anchor = this.interactions.relatedPanel();
    if (!anchor) return null;
    const owners = anchor.ids
      .map((id) => this.store.card(id))
      .filter((c): c is CardState => c !== undefined);
    if (owners.length === 0) return null;
    const ids = new Set(owners.flatMap((owner) => owner.relatedIds));
    const cards = [...ids]
      .map((id) => this.store.card(id))
      .filter((c): c is CardState => c !== undefined);
    return { ...anchor, cards, owners: owners.length };
  });

  /** Suffix marking a menu entry that will hit the whole selection. */
  protected groupSuffix(group: number): string {
    return group > 1 ? ` (${group})` : '';
  }

  protected act(cardId: string, action: CardAction): void {
    this.interactions.act(cardId, action);
  }

  protected itemAct(itemId: string, action: ItemAction): void {
    this.interactions.itemAct(itemId, action);
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
