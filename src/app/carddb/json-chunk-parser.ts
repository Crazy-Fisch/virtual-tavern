/**
 * Incremental scanner for a huge stream of JSON card objects — either a JSON
 * *array* of objects or JSON *Lines* (one object per line), the two shapes
 * bulk card exports come in; both far too large to buffer and JSON.parse
 * whole. Feed it decoded text chunks as they arrive; each push returns the
 * JSON source of every top-level object the chunk completed, small enough to
 * JSON.parse individually. Memory stays bounded by one object plus the
 * unscanned tail. Objects are extracted by brace balance, so whatever
 * separates them — the array's commas or JSONL's newlines — is skipped the
 * same way.
 */
export class JsonChunkParser {
  private buffer = '';
  private pos = 0;
  /** Object start index in the buffer, -1 while between objects. */
  private start = -1;
  /** Brace depth inside the current object. */
  private depth = 0;
  /** Set once the payload shape is known (a leading '[', or a bare '{'). */
  private started = false;
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
      if (!this.started) {
        // '[' opens an array of objects; a bare '{' means JSON Lines, and is
        // itself the first object's opening brace (fall through).
        if (c === '[') {
          this.started = true;
          continue;
        }
        if (c !== '{') continue;
        this.started = true;
      }
      if (this.start === -1) {
        if (c === '{') {
          this.start = i;
          this.depth = 1;
        }
        continue; // skips commas, newlines, whitespace, and a closing ]
      }
      if (c === '{') this.depth++;
      else if (c === '}' && --this.depth === 0) {
        out.push(this.buffer.slice(this.start, i + 1));
        this.start = -1;
      }
    }
    // Keep only the in-progress object (or nothing) for the next chunk.
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
