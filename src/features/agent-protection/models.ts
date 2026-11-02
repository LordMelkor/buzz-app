export type ReviewModel = Readonly<{
  runtime: string;
  provider?: string;
  id: string;
}>;
export type ReviewModelChoice = Readonly<{
  provider?: string;
  id: string;
  label: string;
}>;
import type { HostProcess, HostProcessOptions } from "../host/service";
/** Launches only a review worker declared by the protecting plugin. */
export type ProtectedSpawn = (
  options: Omit<HostProcessOptions, "protection">,
) => Promise<HostProcess>;
/** Plugin-owned instructions and evidence, separate from runtime credentials. */
export type ReviewPrompt = Readonly<{
  system: string;
  input: string;
  outputSchema?: Readonly<Record<string, unknown>>;
}>;
/** Runtime-owned inference uses its configured credentials, with no tools. */
export type ReviewModelProvider = Readonly<{
  label: string;
  models(): Promise<readonly ReviewModelChoice[]>;
  complete(
    model: Omit<ReviewModel, "runtime">,
    prompt: ReviewPrompt,
    signal: AbortSignal,
    spawn?: ProtectedSpawn,
  ): Promise<{ text: string; model: Omit<ReviewModel, "runtime"> }>;
}>;
