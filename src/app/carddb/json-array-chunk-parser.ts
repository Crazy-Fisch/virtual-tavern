/**
 * Incremental scanner for a huge JSON array of objects (the Scryfall bulk
 * file, hundreds of MB — far too large to buffer and JSON.parse whole).
 * Feed it decoded text chunks as they arrive; each push returns the JSON
 * source of every top-level array element the chunk completed, each small
 * enough to JSON.parse individually. Memory stays bounded by one element
 * plus the unscanned tail. Elements must be objects (true for every
 * Scryfall card object).
 */
export class JsonArrayChunkParser {
  private buffer = '';
  private pos = 0;
  /** Element start index in the buffer, -1 while between elements. */
  private start = -1;
  /** Brace depth inside the current element. */
  private depth = 0;
  private inArray = false;
  private inString = false;
  private escaped = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (let i = this.pos; i < this.buffer.length; i++) {
      const c = this.buffer[i]!;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
        continue;
      }
      if (!this.inArray) {
        if (c === '[') this.inArray = true;
        continue;
      }
      if (this.start === -1) {
        if (c === '{') {
          this.start = i;
          this.depth = 1;
        }
        continue; // skips commas, whitespace, and the array's closing ]
      }
      if (c === '{') this.depth++;
      else if (c === '}' && --this.depth === 0) {
        out.push(this.buffer.slice(this.start, i + 1));
        this.start = -1;
      }
    }
    // Keep only the in-progress element (or nothing) for the next chunk.
    if (this.start === -1) {
      this.buffer = '';
    } else {
      this.buffer = this.buffer.slice(this.start);
      this.start = 0;
    }
    this.pos = this.buffer.length;
    return out;
  }
}
