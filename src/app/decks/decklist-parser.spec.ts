import { parseDecklist } from './decklist-parser';

describe('parseDecklist', () => {
  it('parses plain lists: counts, x-counts, and bare names', () => {
    expect(
      parseDecklist('4 Lightning Bolt\n2x Counterspell\nBlack Lotus\nLlanowar Elves x3'),
    ).toEqual([
      { card: 'Lightning Bolt', count: 4 },
      { card: 'Counterspell', count: 2 },
      { card: 'Black Lotus', count: 1 },
      { card: 'Llanowar Elves', count: 3 },
    ]);
  });

  it('parses an Arena export: sections, deck-name line, and (SET) 123 suffixes', () => {
    const text = [
      'About',
      'Name Izzet Phoenix',
      '',
      'Deck',
      '4 Consider (MID) 44',
      '2 Arclight Phoenix (GRN) 91',
      '',
      'Sideboard',
      '1 Abrade (VOW) 139',
    ].join('\n');
    expect(parseDecklist(text)).toEqual([
      { card: 'Consider', count: 4 },
      { card: 'Arclight Phoenix', count: 2 },
      { card: 'Abrade', count: 1 },
    ]);
  });

  it('parses an Archidekt export: category and foil markers', () => {
    expect(parseDecklist('1x Abrade (voc) 220 *F* [Removal]\n1x Sol Ring (c21) 263 [Ramp]')).toEqual(
      [
        { card: 'Abrade', count: 1 },
        { card: 'Sol Ring', count: 1 },
      ],
    );
  });

  it('handles the MTGO SB: prefix', () => {
    expect(parseDecklist('4 Thoughtseize\nSB: 2 Duress')).toEqual([
      { card: 'Thoughtseize', count: 4 },
      { card: 'Duress', count: 2 },
    ]);
  });

  it('merges duplicate names case-insensitively, keeping the first spelling', () => {
    expect(parseDecklist('2 Lightning Bolt\n1 lightning bolt (2X2) 117')).toEqual([
      { card: 'Lightning Bolt', count: 3 },
    ]);
  });

  it('skips blanks and comments, keeps split-card names with //', () => {
    expect(parseDecklist('// my burn deck\n# scratch\n\n3 Fire // Ice (apc) 128')).toEqual([
      { card: 'Fire // Ice', count: 3 },
    ]);
  });

  it('does not mistake a parenthesized name part for a set code', () => {
    expect(parseDecklist('1 B.F.M. (Big Furry Monster)')).toEqual([
      { card: 'B.F.M. (Big Furry Monster)', count: 1 },
    ]);
  });

  it('returns [] for unparseable text', () => {
    expect(parseDecklist('')).toEqual([]);
    expect(parseDecklist('\n\n// nothing\nSideboard\n')).toEqual([]);
  });
});
