// A current container block is a temporary lexical view, never a retained AST.
import { fenceLine } from "./markdown-fences";
import type { FenceState, Owner } from "./markdown-fences";
import { referenceDefinitions } from "./markdown-references";
import type {
  DefinitionBudget,
  ReferenceDefinition,
} from "./markdown-references";
import { required } from "./markdown-limits";

export type ContainedDefinition = ReferenceDefinition & {
  owners?: readonly Owner[] | undefined;
  bodyStart?: number | undefined;
  padding?: number | undefined;
};
export type DefinitionReader = ReturnType<typeof referenceDefinitions> & {
  contained?(
    offset: number,
    bodyStart: number,
    state: FenceState,
    padding?: number,
  ): ContainedDefinition | undefined;
};

export function containerDefinitions(
  text: string,
  budget: DefinitionBudget,
): DefinitionReader {
  const read: DefinitionReader = referenceDefinitions(text, budget);
  let cached:
    | {
        start: number;
        end: number;
        owners: readonly Owner[];
        read(offset: number): ContainedDefinition | undefined;
      }
    | undefined;
  read.contained = (offset, bodyStart, state, padding = 0) => {
    if (
      !state.owners.length ||
      !/^ {0,3}\[/.test(
        " ".repeat(padding) + text.slice(bodyStart, bodyStart + 5),
      )
    )
      return undefined;
    if (
      !cached ||
      offset < cached.start ||
      offset >= cached.end ||
      cached.owners.length !== state.owners.length ||
      cached.owners.some((owner, at) => owner.id !== state.owners[at]?.id)
    ) {
      const owners = state.owners;
      const rows: {
        physical: number;
        body: number;
        padding: number;
        virtual: number;
        next: number;
      }[] = [];
      const chunks: string[] = [];
      const endings = /\r\n|\r|\n/g;
      let at = offset,
        virtual = 0,
        current = state;
      while (at < text.length) {
        endings.lastIndex = at;
        const ending = endings.exec(text),
          end = ending?.index ?? text.length,
          next = ending ? endings.lastIndex : text.length;
        const raw = text.slice(at, end);
        const step =
          at === offset
            ? undefined
            : fenceLine(raw, { ...current, paragraph: false }, true);
        const syntax =
          at === offset
            ? undefined
            : fenceLine(raw, { ...current, paragraph: true }, false);
        if (
          syntax &&
          (syntax.after.owners.length !== owners.length ||
            syntax.after.owners.some(
              (owner, index) => owner.id !== owners[index]?.id,
            ))
        )
          break;
        if (
          step &&
          (step.after.owners.length !== owners.length ||
            step.after.owners.some(
              (owner, index) => owner.id !== owners[index]?.id,
            ))
        )
          break;
        const body = at === offset ? bodyStart : at + required(step).bodyOffset;
        const bodyPadding =
          at === offset ? padding : required(step).bodyPadding;
        const content = " ".repeat(bodyPadding) + text.slice(body, next);
        rows.push({ physical: at, body, padding: bodyPadding, virtual, next });
        chunks.push(content);
        virtual += content.length;
        at = next;
        if (syntax) current = syntax.after;
        if (
          !ending ||
          /^[\t ]*$/.test(content.slice(0, content.length - (next - end)))
        )
          break;
      }
      const source = chunks.join(""),
        definitions = referenceDefinitions(source, budget);
      const byPhysical = new Map(rows.map((row) => [row.physical, row]));
      cached = {
        start: offset,
        end: at,
        owners,
        read(physical) {
          const row = byPhysical.get(physical);
          if (!row) return undefined;
          const definition = definitions(row.virtual);
          if (!definition) return undefined;
          let low = 0,
            high = rows.length;
          while (low + 1 < high) {
            const middle = (low + high) >>> 1;
            if (required(rows[middle]).virtual < definition.end) low = middle;
            else high = middle;
          }
          const last = required(rows[low]);
          return {
            label: definition.label,
            start: physical,
            end: Math.min(
              last.next,
              last.body + definition.end - last.virtual - last.padding,
            ),
            owners,
            bodyStart: row.body,
            padding: row.padding,
          };
        },
      };
    }
    return cached.read(offset);
  };
  return read;
}

/** Remove only the definition's owning containers, preserving note indentation. */
export function definitionSource(
  text: string,
  span: {
    start: number;
    end: number;
    owners?: readonly Owner[] | undefined;
    bodyStart?: number | undefined;
    padding?: number | undefined;
  },
): string {
  if (!span.owners?.length) return text.slice(span.start, span.end);
  const chunks: string[] = [];
  const endings = /\r\n|\r|\n/g;
  let at = span.start,
    state: FenceState = { owners: span.owners };
  while (at < span.end) {
    endings.lastIndex = at;
    const ending = endings.exec(text),
      end = Math.min(ending?.index ?? span.end, span.end),
      next = Math.min(ending ? endings.lastIndex : span.end, span.end);
    const raw = text.slice(at, end),
      step = fenceLine(raw, state, true);
    const body =
      at === span.start ? (span.bodyStart ?? at) : at + step.bodyOffset;
    const padding = at === span.start ? (span.padding ?? 0) : step.bodyPadding;
    chunks.push(" ".repeat(padding), text.slice(body, next));
    if (at !== span.start) state = step.after;
    at = next;
  }
  return chunks.join("");
}
