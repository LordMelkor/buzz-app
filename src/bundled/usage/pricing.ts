// Estimated cost of token counts at providers' published list prices, from
// the price data `@pydantic/genai-prices` bundles. Harnesses that record their
// own cost are not estimated.
//
// Keep no price data or per-model corrections here: we rely on genai-prices
// alone so that nobody has to keep prices current. When a price is wrong or a
// model is missing, fix it upstream in genai-prices and bump the package.
import type { calcPrice } from "@pydantic/genai-prices";
import type { TokenCounts } from "../../features/agents/service";

let calc: typeof calcPrice | undefined;

/** Loads the price data, about 1 MB, when Usage first needs it rather than
 * with the app. `estimateCost` knows no rates before it resolves. */
export async function loadPrices() {
  calc ??= (await import("@pydantic/genai-prices")).calcPrice;
}

/** The Claude model a provider names, without its prefix or a dated
 * snapshot's date: `databricks-claude-sonnet-5-5`, `claude-haiku-4-5-20251001`. */
export const claudeModel = (model: string) =>
  model.slice(Math.max(0, model.indexOf("claude-"))).replace(/-\d{8}$/, "");

/** The estimated USD of the known counts, `partial` when one it prices is
 * unknown, and without `usd` when none is known; undefined when the model has
 * no known rates. */
export function estimateCost(
  model: string,
  tokens: TokenCounts,
): { usd?: number; partial: boolean } | undefined {
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = tokens;
  const priced = [input, output, cacheRead, cacheWrite];
  const price = calc?.(
    {
      // The price data counts cached prompt tokens in the input.
      input_tokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
      output_tokens: output ?? 0,
      cache_read_tokens: cacheRead ?? 0,
      cache_write_tokens: cacheWrite ?? 0,
      cache_write_1h_tokens: Math.min(cacheWrite1h ?? 0, cacheWrite ?? 0),
    },
    claudeModel(model),
  );
  if (!price) return undefined;
  if (priced.every((count) => count === undefined)) return { partial: true };
  return {
    usd: price.total_price,
    partial: priced.some((count) => count === undefined),
  };
}
