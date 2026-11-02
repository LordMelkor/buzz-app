import type { Context } from "../../plugins/author";
export type AttentionValue = NonNullable<
  Parameters<Context["agents"]["save"]>[1]["attention"]
>[string];

export type Agent = ReturnType<
  Context["agents"]["snapshot"]
>["running"][number];
export type Watch = Exclude<NonNullable<AttentionValue>, { type: "interest" }>;
