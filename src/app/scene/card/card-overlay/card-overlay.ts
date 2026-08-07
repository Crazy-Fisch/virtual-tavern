import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { CardDatabaseService } from '../../../carddb/card-database.service';
import { Dialog } from '../../../shared/dialog/dialog';
import { ItemStore } from '../../item/item-store';
import { ItemAction, isDice } from '../../item/item.types';
import { CardInteractions, SpawnCard } from '../card-interactions';
import { CardStore } from '../card-store';
import { CardAction, CardState, faceName, faceSrc } from '../card.types';

/** A related-panel entry: a name resolved (best-effort) against the card database. */
interface RelatedEntry extends SpawnCard {
  related: string[];
}

/**
 * What the large card view is showing, normalised over its three sources: a
 * card on the table, a related-panel entry, and a card in my hand. Only the
 * images differ — a double-faced card carries both (mdfcs.md).
 */
interface ViewedCard {
  name: string;
  src: string;
  backSrc?: string;
}

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
  private readonly db = inject(CardDatabaseService);

  /** The die or coin whose right-click menu is open, if any. */
  protected readonly itemMenu = computed(() => {
    const anchor = this.interactions.itemMenu();
    if (!anchor) return null;
    const item = this.items.item(anchor.id);
    return item ? { ...anchor, item, rollable: isDice(item.kind) } : null;
  });

  /** Which face the large view is showing; local to the dialog — flipping the
   * view never touches the card on the table. */
  private readonly viewFlipped = signal(false);

  /**
   * The menu's card plus how many cards its group actions would hit — 1 for a
   * lone card, the selection size when the right-clicked card is part of one.
   * `flip` is the doc's double-faced flip: on a two-sided card lying face up it
   * names the face it turns to, and the card's own "turn face down" moves to a
   * separate entry only such a card shows.
   */
  protected readonly cardMenu = computed(() => {
    const anchor = this.interactions.contextMenu();
    if (!anchor) return null;
    const card = this.store.card(anchor.id);
    if (!card) return null;
    const group = this.interactions.isSelected(anchor.id) ? this.interactions.selectionSize() : 1;
    const transforms = !!card.backSrc && card.faceUp;
    return {
      ...anchor,
      card,
      group,
      twoSided: !!card.backSrc,
      flipLabel: transforms
        ? `Flip to ${faceName({ ...card, flipped: !card.flipped })}`
        : card.faceUp
          ? 'Flip face down'
          : 'Flip face up',
    };
  });

  private readonly viewCard = computed(() => {
    const id = this.interactions.viewCardId();
    return id ? (this.store.card(id) ?? null) : null;
  });

  /**
   * The card the large view shows: a table card if one was opened, else the
   * "no table instance" popup a related entry or a hand card opens. Both go
   * through the same dialog, so the flip button below serves all three.
   */
  private readonly viewed = computed<ViewedCard | null>(() => {
    const card = this.viewCard();
    if (card) return { name: card.name, src: card.src, backSrc: card.backSrc };
    const image = this.interactions.viewImage();
    return image ? { name: image.name, src: image.src, backSrc: image.back } : null;
  });

  /** The viewed card resolved onto the face being shown, plus the name of the
   * other face — non-null exactly when the card is double-faced, which is what
   * puts the flip button in the dialog (mdfcs.md). */
  protected readonly viewing = computed(() => {
    const card = this.viewed();
    if (!card) return null;
    const flipped = this.viewFlipped();
    return {
      heading: faceName({ ...card, flipped }),
      src: faceSrc({ ...card, flipped }),
      otherFace: card.backSrc ? faceName({ ...card, flipped: !flipped }) : null,
    };
  });

  /** Identity of what the large view is showing; a change resets the face. */
  private readonly viewKey = computed(
    () => this.interactions.viewCardId() ?? this.interactions.viewImage()?.src ?? null,
  );

  constructor() {
    // Opening the view starts on the face the card is actually showing; closing
    // it (or viewing another card) resets, so the button never leaks the face
    // from the card viewed before.
    effect(() => {
      const key = this.viewKey();
      untracked(() => this.viewFlipped.set((key ? this.viewCard()?.flipped : false) ?? false));
    });
  }

  protected flipView(): void {
    this.viewFlipped.update((flipped) => !flipped);
  }

  /**
   * Related cards of every owner in the panel (a selection contributes all of
   * theirs): the owners' related *names* (from the card data's all_parts),
   * resolved to images via the card database — tokens are indexed like any
   * other card. A name the database can't resolve still shows, as a text tile.
   */
  protected readonly related = computed(() => {
    const anchor = this.interactions.relatedPanel();
    if (!anchor) return null;
    const owners = anchor.ids
      .map((id) => this.store.card(id))
      .filter((c): c is CardState => c !== undefined);
    if (owners.length === 0) return null;
    const names = new Set(owners.flatMap((owner) => owner.relatedNames));
    const cards: RelatedEntry[] = [...names].map((name) => {
      const record = this.db.lookup(name);
      return {
        name: record?.name ?? name,
        src: record?.src ?? '',
        ...(record?.back ? { back: record.back } : {}),
        related: record?.related ?? [],
      };
    });
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

  /** Drag a related card onto the table (or a zone widget); the panel closes
   * once the drag actually starts, a plain click views the card instead. */
  protected dragRelated(event: PointerEvent, card: RelatedEntry): void {
    this.interactions.armSpawnCardDrag(event, card, () => this.closeRelated());
  }

  /** A card with no table instance — a related entry, or one in my hand — is
   * viewed through the shared `viewImage` popup (finaltouches.md). */
  protected viewRelated(card: RelatedEntry): void {
    this.interactions.viewImage.set({ name: card.name, src: card.src, back: card.back });
  }

  /** One dialog serves both sources, so closing it clears both. */
  protected closeView(): void {
    this.interactions.viewCardId.set(null);
    this.interactions.viewImage.set(null);
  }

  protected closeRelated(): void {
    this.interactions.relatedPanel.set(null);
  }
}
