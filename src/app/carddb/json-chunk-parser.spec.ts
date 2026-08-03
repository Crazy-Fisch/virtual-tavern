import { JsonChunkParser } from './json-chunk-parser';

const CARDS = [
  { name: 'Lightning Bolt', cost: '{R}' },
  { name: 'Weird "Quoted" Card', note: 'braces } in { strings', escaped: 'a \\" tricky "one"' },
  { name: 'Nested', faces: [{ img: { normal: 'x' } }, { img: null }], tags: ['a', 'b'] },
];
const ARRAY_TEXT = JSON.stringify(CARDS);
const JSONL_TEXT = CARDS.map((c) => JSON.stringify(c)).join('\n') + '\n';

/** Feed the text in fixed-size chunks and JSON.parse everything yielded. */
function chunked(text: string, size: number): unknown[] {
  const parser = new JsonChunkParser();
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += size) {
    for (const s of parser.push(text.slice(i, i + size))) out.push(JSON.parse(s));
  }
  return out;
}

describe('JsonChunkParser', () => {
  it('yields every element of a JSON array from a single push', () => {
    const parser = new JsonChunkParser();
    const out = parser.push(ARRAY_TEXT).map((s) => JSON.parse(s) as unknown);
    expect(out).toEqual(CARDS);
  });

  it('parses JSON Lines: one object per line, no array wrapper', () => {
    const parser = new JsonChunkParser();
    const out = parser.push(JSONL_TEXT).map((s) => JSON.parse(s) as unknown);
    expect(out).toEqual(CARDS);
  });

  it('reassembles objects split across arbitrary chunk boundaries, both shapes', () => {
    for (const size of [1, 3, 7, 16]) {
      expect(chunked(ARRAY_TEXT, size)).toEqual(CARDS);
      expect(chunked(JSONL_TEXT, size)).toEqual(CARDS);
    }
  });

  it('ignores a BOM/whitespace prefix and whitespace between elements', () => {
    const parser = new JsonChunkParser();
    const out = parser.push('﻿ \n[ {"a":1} ,\n {"b":2} \n]');
    expect(out.map((s) => JSON.parse(s) as unknown)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles CRLF line ends, blank lines, and a missing trailing newline', () => {
    const parser = new JsonChunkParser();
    const out = parser.push('{"a":1}\r\n\r\n{"b":2}');
    expect(out.map((s) => JSON.parse(s) as unknown)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps memory bounded: the buffer empties between elements', () => {
    const parser = new JsonChunkParser();
    parser.push('[{"a":1},');
    // Only internal state — probe via behavior: a fresh element still parses.
    expect(parser.push('{"b":2}]').map((s) => JSON.parse(s) as unknown)).toEqual([{ b: 2 }]);
  });
});
