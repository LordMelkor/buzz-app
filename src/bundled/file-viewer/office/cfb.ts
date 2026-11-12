import { required } from "./required";
import { checkAbort } from "./xml";
import { OfficeFailure } from "./zip";
import { MAX_RENDER_CHARS } from "../office-types";

const FREE = 0xffffffff,
  END = 0xfffffffe,
  FAT = 0xfffffffd,
  DIF = 0xfffffffc;
const invalid = (): never => {
  throw new Error("Invalid Office compound-file allocation");
};

/** Validate allocation before either CFB.read or XLSX.read can follow a chain.
 * All work and allocations are bounded by the bytes present, never a count
 * claimed by the file. Shared chains are invalid too: they can make a reader
 * repeatedly copy the same tail even when every individual chain terminates.
 */
export function validateCfb(bytes: Uint8Array, signal: AbortSignal): void {
  if (bytes[0] !== 0xd0 || bytes[1] !== 0xcf) return;
  checkAbort(signal);
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < 512 || signature.some((b, i) => bytes[i] !== b)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true),
    u32 = (at: number) => view.getUint32(at, true);
  const version = u16(26),
    shift = u16(30);
  if (
    u16(28) !== 0xfffe ||
    (version !== 3 && version !== 4) ||
    shift !== (version === 3 ? 9 : 12) ||
    u16(32) !== 6 ||
    u32(56) !== 4096
  )
    invalid();
  const size = 2 ** shift,
    count = bytes.length / size - 1,
    perFat = size / 4;
  if (!Number.isInteger(count) || count < 1) invalid();
  const sector = (id: number): number => {
    if (id >= count) invalid();
    return (id + 1) * size;
  };
  const fatCount = u32(44),
    difCount = u32(72),
    miniCount = u32(64),
    dirCount = u32(40);
  if (
    !fatCount ||
    fatCount > count ||
    difCount > count ||
    miniCount > count ||
    dirCount > count ||
    (version === 3 && dirCount !== 0)
  )
    invalid();
  const fatIds: number[] = [],
    difIds = new Set<number>(),
    reserved = new Set<number>();
  const addFat = (id: number) => {
    if (id === FREE) return;
    sector(id);
    if (reserved.has(id) || fatIds.length >= fatCount) invalid();
    reserved.add(id);
    fatIds.push(id);
  };
  for (let at = 76; at < 512; at += 4) addFat(u32(at));
  let nextDif = u32(68);
  for (let i = 0; i < difCount; i++) {
    checkAbort(signal);
    const at = sector(nextDif);
    if (reserved.has(nextDif)) invalid();
    reserved.add(nextDif);
    difIds.add(nextDif);
    for (let j = 0; j < perFat - 1; j++) addFat(u32(at + j * 4));
    nextDif = u32(at + size - 4);
  }
  if (
    (nextDif !== END && nextDif !== FREE) ||
    fatIds.length !== fatCount ||
    fatCount * perFat < count
  )
    invalid();
  const fat = (id: number) =>
    u32(sector(required(fatIds[Math.floor(id / perFat)])) + (id % perFat) * 4);
  // Apple's textutil writes END for its FAT sector. Both markers terminate;
  // reserved-sector ownership below still prevents a stream from using it.
  for (const id of fatIds) if (fat(id) !== FAT && fat(id) !== END) invalid();
  for (const id of difIds) if (fat(id) !== DIF) invalid();

  // Examine every allocation, including chains not reached from a directory.
  // Gray nodes are on the current walk; black nodes have already terminated.
  function checkGraph(length: number, get: (id: number) => number): void {
    const color = new Uint8Array(length),
      incoming = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const to = get(i);
      if (to < length) {
        incoming[to] = required(incoming[to]) + 1;
        if (incoming[to] > 1) invalid();
      } else if (to !== FREE && to !== END) {
        if ((to !== FAT && to !== DIF) || !reserved.has(i)) invalid();
      }
    }
    for (let i = 0; i < length; i++) {
      checkAbort(signal);
      let id = i;
      while (id < length && color[id] === 0) {
        color[id] = 1;
        id = get(id);
      }
      if (id < length && color[id] === 1) invalid();
      id = i;
      while (id < length && color[id] === 1) {
        color[id] = 2;
        id = get(id);
      }
    }
  }
  checkGraph(count, fat);
  const used = new Uint8Array(count);
  for (const id of reserved) used[id] = 1;
  function claim(start: number, expected?: number): number[] {
    const chain: number[] = [];
    let id = start;
    while (id < count) {
      checkAbort(signal);
      if (used[id]) invalid();
      used[id] = 1;
      chain.push(id);
      id = fat(id);
    }
    if (id !== END || (expected !== undefined && chain.length !== expected))
      invalid();
    return chain;
  }
  const dirs = claim(u32(48), version === 4 ? dirCount : undefined);
  if (!dirs.length) invalid();
  const miniFat = miniCount ? claim(u32(60), miniCount) : [];
  if (!miniCount && u32(60) !== END && u32(60) !== FREE) invalid();
  const entries = (dirs.length * size) / 128;
  // MS-CFB has no small directory-count limit. SheetJS's path builder searches
  // its full index per sibling edge (quadratic even for a rooted acyclic tree).
  // Bound all slots, including inactive padding which also enters that index.
  if (entries > 4096)
    throw new OfficeFailure(
      "too-large",
      "Compound-file directory limit exceeded",
    );
  const atEntry = (i: number) =>
    sector(required(dirs[Math.floor((i * 128) / size)])) + ((i * 128) % size);
  const streamSize = (at: number) => {
    // Even version 4 cannot legitimately claim >4 GiB in this bounded input.
    if (u32(at + 124) !== 0) invalid();
    const n = u32(at + 120);
    if (n > bytes.length) invalid();
    return n;
  };
  if (bytes[atEntry(0) + 66] !== 5) invalid();
  const rootAt = atEntry(0),
    rootSize = streamSize(rootAt);
  if (rootSize) {
    if (claim(u32(rootAt + 116)).length * size < rootSize) invalid();
  }
  const miniSectors = Math.ceil(rootSize / 64);
  if (miniSectors > miniFat.length * perFat) invalid();
  const mfat = (id: number) =>
    u32(sector(required(miniFat[Math.floor(id / perFat)])) + (id % perFat) * 4);
  // Only directory-referenced mini chains are consumed by the reader. Apple's
  // textutil leaves zero-filled, unused mini-FAT entries, so don't interpret
  // that padding as allocated chains. miniUsed detects cycles and sharing below.
  const miniUsed = new Uint8Array(miniSectors),
    active = new Uint8Array(entries);
  active[0] = 1;
  for (let i = 1; i < entries; i++) {
    checkAbort(signal);
    const at = atEntry(i),
      type = bytes[at + 66];
    // The dependency reads size/start even on inactive and storage entries.
    // Those entries own no stream under MS-CFB; reject hidden allocations.
    const n = streamSize(at);
    if ((type === 0 || type === 1) && n !== 0) invalid();
    if (type === 0) {
      // The dependency decodes even inactive names; zero is unused padding.
      const nameBytes = u16(at + 64);
      if (nameBytes && (nameBytes < 2 || nameBytes > 64 || nameBytes % 2))
        invalid();
      // Some producers zero-fill unused entries. Other references could alter
      // the dependency's parent walk even though the entry owns no stream.
      for (const offset of [68, 72, 76])
        if (u32(at + offset) !== FREE && u32(at + offset) !== 0) invalid();
      continue;
    }
    if (type !== 1 && type !== 2) invalid();
    active[i] = 1;
    if (type !== 2) continue;
    const start = u32(at + 116);
    if (!n) continue;
    if (n >= 4096) {
      if (claim(start).length * size < n) invalid();
    } else {
      let id = start,
        length = 0;
      while (id < miniSectors) {
        checkAbort(signal);
        if (miniUsed[id]) invalid();
        miniUsed[id] = 1;
        length++;
        id = mfat(id);
      }
      if (id !== END || length * 64 < n) invalid();
    }
  }
  // The dependency also walks sibling/child directory pointers to build paths.
  // Require one rooted tree so those walks cannot revisit or loop.
  const seen = new Uint8Array(entries),
    pending: [number, number][] = [[0, 0]];
  let pathChars = 0;
  while (pending.length) {
    const [i, parentChars] = required(pending.pop());
    if (i >= entries || !active[i] || seen[i]) invalid();
    seen[i] = 1;
    const at = atEntry(i),
      nameBytes = u16(at + 64);
    if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2) invalid();
    const path = parentChars + nameBytes / 2 - 1;
    // FullPaths retains every expanded path; CFB.find uppercases and splits
    // them again. Charge root prefixes and storage slashes before either read.
    pathChars += path + (bytes[at + 66] === 2 ? 0 : 1);
    if (pathChars > MAX_RENDER_CHARS)
      throw new OfficeFailure(
        "too-large",
        "Compound-file path budget exceeded",
      );
    for (const offset of [68, 72, 76]) {
      const ref = u32(at + offset);
      if (ref !== FREE)
        pending.push([ref, offset === 76 ? path + 1 : parentChars]);
    }
  }
  for (let i = 0; i < entries; i++) if (active[i] && !seen[i]) invalid();
}
