import type { Total } from "./stats";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** USD to the cent; a nonzero amount under a cent as such. */
export const cost = (usd: number) =>
  usd > 0 && usd < 0.005 ? "<$0.01" : dollars.format(usd);
export const percent = (share: number) => `${Math.round(share * 100)}%`;
/** A count in compact form, e.g. 12.4M, with `noun` pluralized. */
export function count(value: number, noun?: string) {
  const number = compact.format(value);
  return noun ? `${number} ${noun}${value === 1 ? "" : "s"}` : number;
}
/** A cost total as text: `Unavailable` when unknown, marked when partial. */
export const costText = (total: Total) =>
  total.value === undefined
    ? "Unavailable"
    : `${cost(total.value)}${total.partial ? " · partial" : ""}`;
/** A total's known value in `format`; `Unavailable` when none was known. */
export const amount = (total: Total, format: (value: number) => string) =>
  total.value === undefined ? "Unavailable" : format(total.value);
