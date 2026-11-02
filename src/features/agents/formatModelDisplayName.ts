const MODEL_WORD_LABELS: ReadonlyMap<string, string> = new Map([
  ["bge", "BGE"],
  ["claude", "Claude"],
  ["en", "EN"],
  ["glm", "GLM"],
  ["gpt", "GPT"],
  ["gte", "GTE"],
  ["llama", "Llama"],
  ["meta", "Meta"],
  ["mlflow", "MLflow"],
  ["openai", "OpenAI"],
]);

/** A Unity Catalog model service: `catalog.schema.name`. */
const MODEL_SERVICE = /^([^.\s/]+\.[^.\s/]+)\.([^.\s/]+)$/;

const prefixOf = (model: string, prefixes: readonly string[]) =>
  prefixes.find((value) => model.toLowerCase().startsWith(value.toLowerCase()));

/**
 * Turns a Databricks gateway endpoint or Unity Catalog model service into its
 * human-facing model name while preserving the ID everywhere it is sent to the
 * runtime. Without `prefixes`, a provider's names are its own.
 *
 * Examples:
 * - `databricks-claude-opus-4-7` → `Claude Opus 4.7`
 * - `databricks-gpt-5-5` → `GPT-5.5`
 * - `system.ai.gpt-6-1-sol` → `GPT-6.1 Sol`
 */
export function formatModelDisplayName(
  model: string,
  prefixes: readonly string[] = [],
) {
  const trimmed = model?.trim();
  if (!trimmed) return "";
  if (!prefixes.length) return trimmed;

  const service = MODEL_SERVICE.exec(trimmed)?.[2];
  const name = service ?? trimmed;
  const prefix = prefixOf(name, prefixes);
  // A workspace endpoint without a known prefix is another team's name.
  if (!prefix && !service) {
    return trimmed;
  }

  const parts = name.slice(prefix?.length ?? 0).split("-");
  const labelParts: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const nextPart = parts[index + 1];

    if (/^\d+$/.test(part) && nextPart && /^\d+$/.test(nextPart)) {
      labelParts.push(`${part}.${nextPart}`);
      index += 1;
      continue;
    }

    if (/^\d+b$/i.test(part)) {
      labelParts.push(part.toUpperCase());
      continue;
    }

    labelParts.push(
      MODEL_WORD_LABELS.get(part.toLowerCase()) ??
        `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    );
  }

  const label = labelParts.join(" ");
  return label.replace(/^GPT (\d)/, "GPT-$1");
}

/**
 * Formats each model's label. A formatted label that distinct models share,
 * case-insensitively, keeps its raw label instead, so each row stays distinct.
 * The default `""` row stands for the model its label names.
 */
export function formatModelChoices<T extends { id: string; label: string }>(
  models: readonly T[],
  prefixes: readonly string[] = [],
): T[] {
  const labels = models.map((model) =>
    formatModelDisplayName(model.label, prefixes),
  );
  const ids = new Map<string, Set<string>>();
  models.forEach((model, index) => {
    const key = (labels[index] ?? "").toLowerCase();
    ids.set(key, (ids.get(key) ?? new Set()).add(model.id || model.label));
  });
  return models.map((model, index) => {
    const label = labels[index] ?? model.label;
    const shared = (ids.get(label.toLowerCase())?.size ?? 0) > 1;
    return { ...model, label: shared ? model.label : label };
  });
}
