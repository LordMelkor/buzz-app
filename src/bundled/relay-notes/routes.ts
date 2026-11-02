import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

export type NotesRoute = { author: string; note?: string; profile?: string };
export function notesRoute(
  value: JsonValue | undefined,
): NotesRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Record<string, JsonValue>;
  if (
    Object.keys(route).some(
      (key) => key !== "author" && key !== "note" && key !== "profile",
    ) ||
    (route.profile !== undefined &&
      (typeof route.profile !== "string" ||
        !/^[a-f0-9]{64}$/.test(route.profile))) ||
    (route.profile !== undefined && route.note !== undefined) ||
    typeof route.author !== "string" ||
    (route.author !== "" && !/^[a-f0-9]{64}$/.test(route.author)) ||
    (route.note !== undefined &&
      (typeof route.note !== "string" ||
        (route.note !== "" && !/^30023:[a-f0-9]{64}:/.test(route.note))))
  )
    return;
  return {
    author: route.author,
    ...(typeof route.profile === "string" ? { profile: route.profile } : {}),
    ...(typeof route.note === "string" ? { note: route.note } : {}),
  };
}
export function notesTarget(
  target: Extract<OpenTarget, { kind: "page" }>,
  route: NotesRoute,
): OpenTarget {
  return { ...target, route: { version: 1, params: { ...route } } };
}
