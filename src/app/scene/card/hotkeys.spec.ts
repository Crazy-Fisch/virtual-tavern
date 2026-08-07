import { CardAction } from './card.types';
import { CARD_ACTION_LABELS, HOTKEYS, HOTKEY_GUIDE } from './hotkeys';

/** Every row of every group, flattened. */
const rows = () => HOTKEY_GUIDE.flatMap((g) => g.entries);

describe('hotkey guide (hotkeys.md)', () => {
  it('lists every key CardInteractions dispatches on, so the two cannot drift', () => {
    const listed = rows()
      .flatMap((entry) => entry.keys.split(' / '))
      .map((key) => key.toLowerCase());
    for (const key of Object.keys(HOTKEYS)) {
      expect(listed).toContain(key.toLowerCase());
    }
  });

  it('shows the two delete keys as one row', () => {
    const remove = rows().find((entry) => entry.description === CARD_ACTION_LABELS.delete)!;
    expect(remove.keys).toBe('X / Delete');
  });

  it('describes every card action it lists, with no empty rows', () => {
    for (const action of Object.values(HOTKEYS)) {
      expect(CARD_ACTION_LABELS[action as CardAction]).toBeTruthy();
    }
    for (const entry of rows()) {
      expect(entry.keys.trim()).not.toBe('');
      expect(entry.description.trim()).not.toBe('');
    }
    expect(HOTKEY_GUIDE.every((group) => group.entries.length > 0)).toBe(true);
  });

  it('includes duplicate on D', () => {
    expect(HOTKEYS['d']).toBe('duplicate');
    const duplicate = rows().find((entry) => entry.description === CARD_ACTION_LABELS.duplicate)!;
    expect(duplicate.keys).toBe('D');
  });
});
