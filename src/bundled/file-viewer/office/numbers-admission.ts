import { required } from "./required";
import {
  MAX_INFLATED_BYTES,
  MAX_PART_BYTES,
  MAX_RENDER_CHARS,
  MAX_SHEETS,
} from "../office-types";
import type { OfficeInput } from "./load";
import { OfficeFailure } from "./zip";

type Fields = Map<number, Uint8Array[]>;
type Message = { type: number; data: Uint8Array };
type Cost = { refs: number; bytes: number; cells: number; sheets: number };
const fail = (): never => {
  throw new Error("Invalid Numbers archive");
};
const large = (): never => {
  throw new OfficeFailure("too-large", "Numbers work budget exceeded");
};
function vint(bytes: Uint8Array, at = { n: 0 }): number {
  let value = 0;
  for (let shift = 0; shift <= 49 && at.n < bytes.length; shift += 7) {
    const byte = required(bytes[at.n++]);
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
  }
  return fail();
}
const integer = (bytes: Uint8Array): number => vint(bytes) | 0;
const first = (pb: Fields, field: number): Uint8Array =>
  pb.get(field)?.[0] ?? fail();

/** Admit the work SheetJS actually repeats, before its Numbers reader runs.
 * Only structural costs are memoized: every rooted reference occurrence still
 * pays them. Dimensions are not work; sparse tile arrays and replayed cells are.
 * Wire fields match @e965/xlsx's parse_numbers_iwa / TN_* / TST_* readers. */
export function guardNumbers(input: OfficeInput): void {
  // sheetInput has already selected one family and removed competing routes.
  if (
    ![...input.package.parts.keys()].some(
      (name) => name.toLowerCase() === "index/document.iwa",
    )
  )
    return;
  const messages = new Map<number, Message[]>(),
    indices: number[] = [],
    inflated = new Map<string, Uint8Array>();
  const parsed = new WeakMap<Uint8Array, Fields>();
  let fieldCount = 0;
  const pb = (bytes: Uint8Array, skip: number[] = []): Fields => {
    const saved = parsed.get(bytes);
    if (saved && !skip.length) return saved;
    const fields: Fields = new Map(),
      at = { n: 0 };
    while (at.n < bytes.length) {
      // Bound our own views/field arrays before retaining untrusted metadata.
      if (++fieldCount > MAX_RENDER_CHARS) large();
      const tagAt = at.n,
        tag = vint(bytes, at),
        field = (tag / 8) | 0,
        wire = tag & 7;
      // Retag unused routes to field 15, ignored in these reader objects.
      // Preserve tag width and payload lengths, including overlong varints.
      const omit = skip.includes(field);
      if (omit)
        for (let i = tagAt; i < at.n; i++)
          bytes[i] = (i === tagAt ? 120 | wire : 0) | (i + 1 < at.n ? 128 : 0);
      let start = at.n,
        end: number;
      if (wire === 0) {
        vint(bytes, at);
        end = at.n;
      } else {
        const length =
          wire === 2
            ? vint(bytes, at)
            : wire === 1
              ? 8
              : wire === 5
                ? 4
                : fail();
        start = at.n;
        end = at.n += length;
      }
      if (end > bytes.length) fail();
      if (omit) continue;
      const data = bytes.subarray(start, end),
        values = fields.get(field);
      if (values) values.push(data);
      else fields.set(field, [data]);
    }
    parsed.set(bytes, fields);
    return fields;
  };
  let total = 0;
  for (const [name, bytes] of input.package.parts) {
    if (!name.endsWith(".iwa")) continue;
    input.package.check();
    const chunks: Uint8Array[] = [];
    let part = 0;
    for (let frame = 0; frame < bytes.length; ) {
      if (frame + 4 > bytes.length || bytes[frame] !== 0) fail();
      const length =
        required(bytes[frame + 1]) |
        (required(bytes[frame + 2]) << 8) |
        (required(bytes[frame + 3]) << 16);
      const end = frame + 4 + length;
      if (end > bytes.length) fail();
      const compressed = bytes.subarray(frame + 4, end),
        at = { n: 0 },
        declared = vint(compressed, at);
      // Bound both the allocation and actual instructions; the prefix alone
      // cannot certify expansion. Copies may overlap within this frame.
      if (
        declared > MAX_PART_BYTES - part ||
        declared > MAX_INFLATED_BYTES - total
      )
        large();
      const output = new Uint8Array(declared);
      let expanded = 0;
      while (at.n < compressed.length) {
        const tag = required(compressed[at.n++]),
          kind = tag & 3;
        let count: number;
        if (!kind) {
          count = (tag >>> 2) + 1;
          if (count > 60) {
            const width = count - 60;
            count = 0;
            if (at.n + width > compressed.length) fail();
            for (let n = 0; n < width; n++)
              count += required(compressed[at.n++]) * 2 ** (n * 8);
            count++;
          }
          if (at.n + count > compressed.length) fail();
          if (
            count > MAX_PART_BYTES - part ||
            count > MAX_INFLATED_BYTES - total
          )
            large();
          if (expanded + count <= declared)
            output.set(compressed.subarray(at.n, at.n + count), expanded);
          at.n += count;
        } else {
          const width = kind === 1 ? 1 : kind === 2 ? 2 : 4;
          if (at.n + width > compressed.length) fail();
          count = kind === 1 ? ((tag >>> 2) & 7) + 4 : (tag >>> 2) + 1;
          let offset = kind === 1 ? (tag & 224) << 3 : 0;
          for (let n = 0; n < width; n++)
            offset += required(compressed[at.n++]) * 2 ** (n * 8);
          if (!offset || offset > expanded) fail();
          if (expanded + count <= declared)
            for (let n = 0; n < count; n++)
              output[expanded + n] = required(output[expanded + n - offset]);
        }
        expanded += count;
        part += count;
        total += count;
        if (part > MAX_PART_BYTES || total > MAX_INFLATED_BYTES) large();
      }
      if (expanded !== declared) fail();
      chunks.push(output);
      frame = end;
    }
    const data = new Uint8Array(part);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    inflated.set(name, data);
    const at = { n: 0 };
    while (at.n < data.length) {
      const size = vint(data, at),
        end = at.n + size;
      if (end > data.length) fail();
      const header = pb(data.subarray(at.n, end));
      at.n = end;
      const id = integer(first(header, 1)),
        packet: Message[] = [];
      for (const metadata of header.get(2) ?? []) {
        const meta = pb(metadata),
          length = integer(first(meta, 3));
        if (length < 0 || at.n + length > data.length) fail();
        packet.push({
          type: integer(first(meta, 1)),
          data: data.subarray(at.n, at.n + length),
        });
        at.n += length;
      }
      messages.set(id, packet);
      indices.push(id);
    }
  }
  if (!indices.length) return;
  const refs = (data: Uint8Array): Message[] =>
    messages.get(integer(first(pb(data), 1))) ?? fail();
  const add = (cost: Cost, other: Cost): void => {
    cost.refs += other.refs;
    cost.bytes += other.bytes;
    cost.cells += other.cells;
    cost.sheets += other.sheets;
    if (
      cost.refs > MAX_RENDER_CHARS ||
      cost.bytes > MAX_INFLATED_BYTES ||
      cost.cells > MAX_RENDER_CHARS ||
      cost.sheets > MAX_SHEETS
    )
      large();
  };
  const memo = new Map<Message, Cost>();
  const costOf = (message: Message): Cost => {
    const saved = memo.get(message);
    if (saved) return saved;
    input.package.check();
    const fields = pb(message.data, message.type === 2001 ? [11] : []),
      cost: Cost = { refs: 1, bytes: message.data.length, cells: 0, sheets: 0 };
    const follow = (
      data: Uint8Array,
      type?: number,
      onlyFirst = false,
    ): void => {
      add(cost, { refs: 1, bytes: 0, cells: 0, sheets: 0 });
      const candidates = refs(data);
      for (const next of onlyFirst ? candidates.slice(0, 1) : candidates) {
        if (type === undefined || next.type === type) add(cost, costOf(next));
        else add(cost, { refs: 1, bytes: 0, cells: 0, sheets: 0 });
      }
    };
    if (message.type === 1 || message.type === 2) {
      for (const data of fields.get(message.type === 1 ? 1 : 2) ?? [])
        follow(data, message.type === 1 ? 2 : 6000);
    } else if (message.type === 6000) {
      // Bound emitted sheet occurrences, including repeated names: SheetJS's
      // suffix collision search otherwise grows cubically before display caps.
      cost.sheets = 1;
      follow(first(fields, 2), 6001, true);
    } else if (message.type === 6001) {
      // Formula/error lists and comments never contribute to the viewer.
      const store = pb(first(fields, 4), [6, 12, 19]);
      // Table lists are reparsed on each table occurrence too.
      for (const key of [4, 11, 17, 22, 13])
        if (store.has(key)) {
          const list = refs(first(store, key))[0] ?? fail();
          if (key !== 13) {
            const entries = pb(list.data);
            const type = integer(first(entries, 1));
            // Wire type selects the parser regardless of the store slot.
            if (type === 10) pb(list.data, [3]);
            else if (type === 8)
              for (const entry of entries.get(3) ?? []) {
                const item = pb(entry);
                if (item.has(1)) {
                  const text = refs(first(item, 9))[0] ?? fail();
                  add(cost, {
                    refs: 1,
                    bytes: text.data.length,
                    cells: 0,
                    sheets: 0,
                  });
                  const rich = refs(first(pb(text.data), 1))[0] ?? fail();
                  if (rich.type !== 2001) fail();
                  add(cost, costOf(rich));
                }
              }
          }
          add(cost, { refs: 1, bytes: list.data.length, cells: 0, sheets: 0 });
        }
      const tiles = pb(first(store, 3)).get(1) ?? [];
      for (const row of pb(first(store, 9)).get(1) ?? []) {
        const index = integer(first(pb(row), 2)),
          tile = tiles[index] ?? fail();
        follow(first(pb(tile), 2), 6002, true);
      }
    } else if (message.type === 6002) {
      const rows = new Map<number, number>();
      let span = 0;
      for (const row of fields.get(5) ?? []) {
        const info = pb(row),
          r = integer(first(info, 1)) >>> 0;
        const mode = fields.has(7)
          ? integer(first(fields, 7)) >>> 0
            ? 1
            : 0
          : -1;
        const offsets = first(info, info.has(7) && mode !== 0 ? 7 : 4);
        if (offsets.length % 2) fail();
        let columns = 0;
        for (let c = 0; c < offsets.length; c += 2)
          if ((required(offsets[c]) | (required(offsets[c + 1]) << 8)) < 65535)
            columns = c / 2 + 1;
        span = Math.max(span, r + 1);
        rows.set(r, Math.max(rows.get(r) ?? 0, columns));
      }
      // These separately bounded sparse row/column walks cost at most twice
      // the logical cells charged here; ordinary million-cell files still fit.
      cost.cells = Math.max(
        span,
        [...rows.values()].reduce((sum, columns) => sum + columns, 0),
      );
    }
    add(cost, { refs: 0, bytes: 0, cells: 0, sheets: 0 });
    memo.set(message, cost);
    return cost;
  };
  let root = messages.get(1)?.[0];
  if (root?.type !== 1) root = undefined;
  if (!root)
    for (const id of indices)
      for (const message of messages.get(id) ?? [])
        if (message.type === 1) {
          if (root) fail();
          root = message;
        }
  if (root) costOf(root);
  // SheetJS periodically concatenates the entire decoded prefix for copy
  // commands. Hand it our linear decode as literal-only frames instead.
  // Eight MiB payloads fit the framing format's 24-bit length.
  for (const [name, data] of inflated) {
    const output = new Uint8Array(
      data.length + Math.ceil(data.length / 8388608) * 13,
    );
    for (let at = 0, to = 0; at < data.length; ) {
      const n = Math.min(8388608, data.length - at),
        size = n + 9,
        literal = n - 1;
      output.set(
        [
          0,
          size & 255,
          (size >>> 8) & 255,
          size >>> 16,
          (n & 127) | 128,
          ((n >>> 7) & 127) | 128,
          ((n >>> 14) & 127) | 128,
          n >>> 21,
          252,
          literal & 255,
          (literal >>> 8) & 255,
          (literal >>> 16) & 255,
          literal >>> 24,
        ],
        to,
      );
      output.set(data.subarray(at, at + n), to + 13);
      at += n;
      to += n + 13;
    }
    (input.package.parts as Map<string, Uint8Array>).set(name, output);
  }
}
