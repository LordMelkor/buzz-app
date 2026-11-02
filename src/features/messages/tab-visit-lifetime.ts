// Retirement records survive reconnects, but leaving their community purges
// them. Features own invalidation; the bundled tab store owns the record schema.
const purges = new Map<string, (scope: string) => void>();

/** Register the current retirement owner without retaining a relay session. */
export function retainTabVisits(
  scope: string,
  forget: (scope: string) => void,
) {
  purges.set(scope, forget);
}

/** Forget one scope and fence late writes from its previous tab stores. */
export function forgetTabVisits(scope: string) {
  const forget = purges.get(scope);
  purges.delete(scope);
  forget?.(scope);
}
