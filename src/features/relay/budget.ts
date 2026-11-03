export const OUTBOX_INPUT_MAX_BYTES = 32 * 1024;

/** Deterministic UTF-8 budget, used for both warm data and persisted records. */
export const byteSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const sizes = new WeakMap<object, number>();
/** `byteSize` of a list whose members never change, such as verified events.
 * A live window checks its budget on every message; each member is serialized
 * once instead of the whole window each time. */
export function listByteSize(values: readonly object[]) {
  let bytes = 2 + Math.max(0, values.length - 1);
  for (const value of values) {
    let size = sizes.get(value);
    if (size === undefined) {
      size = byteSize(value);
      sizes.set(value, size);
    }
    bytes += size;
  }
  return bytes;
}

export class ByteLru<T> {
  private items = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {}
  get(key: string): T | undefined {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }
  peek(key: string) {
    return this.items.get(key)?.value;
  }
  set(key: string, value: T, bytes = byteSize(value)): boolean {
    this.delete(key);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
    this.evict();
    return true;
  }
  /** Replace a present entry without making it the most recent. */
  replace(key: string, value: T, bytes = byteSize(value)): boolean {
    const entry = this.items.get(key);
    if (!entry || bytes > this.maxBytes) {
      this.delete(key);
      return false;
    }
    this.bytes += bytes - entry.bytes;
    this.items.set(key, { value, bytes });
    this.evict();
    return true;
  }
  private evict() {
    for (const oldest of this.items.keys()) {
      if (this.items.size <= this.maxEntries && this.bytes <= this.maxBytes)
        break;
      this.delete(oldest);
    }
  }
  delete(key: string) {
    const entry = this.items.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
  keys() {
    return [...this.items.keys()];
  }
  entries(): [string, T][] {
    return [...this.items].map(([key, entry]) => [key, entry.value]);
  }
  stats() {
    return { entries: this.items.size, bytes: this.bytes };
  }
}
