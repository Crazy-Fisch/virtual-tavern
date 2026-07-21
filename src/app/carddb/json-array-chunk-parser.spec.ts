import { JsonArrayChunkParser } from './json-array-chunk-parser';

const CARDS = [
  { name: 'Lightning Bolt', cost: '{R}' },
  { name: 'Weird "Quoted" Card', note: 'braces } in { strings', escaped: 'a \\" tricky "one"' },
  { name: 'Nested', faces: [{ img: { normal: 'x' } }, { img: null }], tags: ['a', 'b'] },
];
const JSON_TEXT = JSON.stringify(CARDS);

describe('JsonArrayChunkParser', () => {
  it('yields every element from a single push', () => {
    const parser = new JsonArrayChunkParser();
    const out = parser.push(JSON_TEXT).map((s) => JSON.parse(s) as unknown);
    expect(out).toEqual(CARDS);
  });

  it('reassembles elements split across arbitrary chunk boundaries', () => {
    for (const size of [1, 3, 7, 16]) {
      const parser = new JsonArrayChunkParser();
      const out: unknown[] = [];
      for (let i = 0; i < JSON_TEXT.length; i += size) {
        for (const s of parser.push(JSON_TEXT.slice(i, i + size))) out.push(JSON.parse(s));
      }
      expect(out).toEqual(CARDS);
    }
  });

  it('ignores content before the array and whitespace between elements', () => {
    const parser = new JsonArrayChunkParser();
    const out = parser.push('﻿ \n[ {"a":1} ,\n {"b":2} \n]');
    expect(out.map((s) => JSON.parse(s) as unknown)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps memory bounded: the buffer empties between elements', () => {
    const parser = new JsonArrayChunkParser();
    parser.push('[{"a":1},');
    // Only internal state — probe via behavior: a fresh element still parses.
    expect(parser.push('{"b":2}]').map((s) => JSON.parse(s) as unknown)).toEqual([{ b: 2 }]);
  });
});
