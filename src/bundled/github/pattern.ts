// Rule patterns match untrusted GitHub text in the renderer. A backtracking
// matcher can take exponential time, so a rule like /^(a+)+$/ would hang the
// app on a 30-character comment. A Pattern takes JavaScript's syntax and
// flags but runs every way to match at once, as an automaton, so its time
// grows with the text times the pattern. Backreferences and lookaround need
// backtracking, so a Pattern refuses them.

/** One step: a character test, a test of the position, a fork, a jump, or
 * the match. */
type Op =
  | { char: RegExp }
  | { at: (text: string, index: number) => boolean }
  | { fork: [number, number] }
  | { jump: number }
  | { match: true };

type Node =
  | Op
  | { seq: Node[] }
  | { alt: Node[] }
  | { repeat: Node; min: number; max: number };

/** The most steps a pattern compiles to, which bounds the work per character. */
const STEPS = 1000;
const LINE = /[\n\r\u2028\u2029]/;

export class Pattern {
  readonly #program: Op[] = [];
  readonly #unicode: boolean;

  /** Throws JavaScript's error for invalid syntax, or why a valid pattern is
   * not one. */
  constructor(
    readonly source: string,
    readonly flags: string,
  ) {
    new RegExp(source, flags);
    const unicode = flags.includes("u");
    this.#unicode = unicode;
    const lines = flags.includes("m");
    const word = new RegExp("^\\w$", flags);
    const isWord = (char?: string) => char !== undefined && word.test(char);
    // The escapes that mean on their own what they mean in the pattern. Others,
    // such as \c1 or \U0041, mean something else alone, so they are refused.
    const ESCAPE = unicode
      ? // An escaped surrogate pair is one character.
        /^\\(?:u[dD][89abAB][\da-fA-F]{2}\\u[dD][c-fC-F][\da-fA-F]{2}|x[\da-fA-F]{2}|u[\da-fA-F]{4}|u\{[\da-fA-F]+\}|c[a-zA-Z]|[pP]\{[^}]*\}|0|[dDsSwWfnrtv]|[^\dA-Za-z])/u
      : // A legacy octal escape such as \012 is one character too.
        /^\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|c[a-zA-Z]|0[0-7]{0,2}|[dDsSwWfnrtv]|[^\dA-Za-z])/;
    let at = 0;
    const alternation = (): Node => {
      const options = [sequence()];
      while (source[at] === "|") {
        at++;
        options.push(sequence());
      }
      return options.length > 1 ? { alt: options } : (options[0] as Node);
    };
    const sequence = (): Node => {
      const seq: Node[] = [];
      while (at < source.length && source[at] !== "|" && source[at] !== ")") {
        const node = atom();
        const q = /^(?:([*+?])|\{(\d+)(,(\d*))?\})\??/.exec(source.slice(at));
        if (!q) {
          seq.push(node);
          continue;
        }
        at += q[0].length;
        const [, sign, low, comma, high] = q;
        const min = sign ? +(sign === "+") : Number(low);
        const max =
          sign === "?"
            ? 1
            : sign || (comma && !high)
              ? Infinity
              : Number(high ?? low);
        seq.push({ repeat: node, min, max });
      }
      return { seq };
    };
    const atom = (): Node => {
      const rest = source.slice(at);
      if (rest[0] === "(") {
        const open = /^\((?:\?:|\?<(?![=!])[^>]*>)?/.exec(rest)?.[0] ?? "(";
        if (rest.startsWith("(?") && open === "(")
          throw new Error(
            "a pattern's groups can only be (…), (?:…) and (?<name>…), not lookaround",
          );
        at += open.length;
        const group = alternation();
        at++;
        return group;
      }
      if (rest[0] === "^" || rest[0] === "$") {
        at++;
        return rest[0] === "^"
          ? {
              at: (text, i) =>
                i === 0 || (lines && LINE.test(text[i - 1] ?? "")),
            }
          : {
              at: (text, i) =>
                i === text.length || (lines && LINE.test(text[i] ?? "")),
            };
      }
      if (/^\\[bB]/.test(rest)) {
        at += 2;
        const inside = rest[1] === "b";
        return {
          at: (text, i) => (isWord(text[i - 1]) !== isWord(text[i])) === inside,
        };
      }
      if (/^\\(?:[1-9]|k<)/.test(rest))
        throw new Error("a pattern cannot use backreferences");
      if (rest[0] === "\\" && !ESCAPE.test(rest))
        throw new Error(`a pattern cannot use the escape ${rest.slice(0, 2)}`);
      const token =
        /^\[\^?(?:\\[\s\S]|[^\]\\])*\]/.exec(rest)?.[0] ??
        ESCAPE.exec(rest)?.[0] ??
        (unicode ? /^[\s\S]/u : /^[\s\S]/).exec(rest)?.[0] ??
        "";
      at += token.length;
      // JavaScript decides what one character a token matches.
      return { char: new RegExp(`^(?:${token})$`, flags) };
    };
    const program = this.#program;
    let work = 0;
    const emit = (node: Node) => {
      if (++work > STEPS || program.length > STEPS)
        throw new Error(
          "a pattern this long or repetitive is too slow to match",
        );
      if ("seq" in node) for (const part of node.seq) emit(part);
      else if ("alt" in node) {
        const jumps: { jump: number }[] = [];
        for (const option of node.alt.slice(0, -1)) {
          const fork: { fork: [number, number] } = { fork: [0, 0] };
          program.push(fork);
          fork.fork[0] = program.length;
          emit(option);
          const jump = { jump: 0 };
          jumps.push(jump);
          program.push(jump);
          fork.fork[1] = program.length;
        }
        emit(node.alt.at(-1) as Node);
        for (const jump of jumps) jump.jump = program.length;
      } else if ("repeat" in node) {
        for (let i = 0; i < node.min; i++) emit(node.repeat);
        if (node.max === Infinity) {
          const fork: { fork: [number, number] } = { fork: [0, 0] };
          const start = program.push(fork) - 1;
          fork.fork[0] = program.length;
          emit(node.repeat);
          program.push({ jump: start });
          fork.fork[1] = program.length;
        } else {
          const forks: { fork: [number, number] }[] = [];
          for (let i = node.min; i < node.max; i++) {
            const fork: { fork: [number, number] } = { fork: [0, 0] };
            forks.push(fork);
            program.push(fork);
            fork.fork[0] = program.length;
            emit(node.repeat);
          }
          for (const fork of forks) fork.fork[1] = program.length;
        }
      } else program.push(node);
    };
    emit(alternation());
    program.push({ match: true });
  }

  /** Whether the pattern matches anywhere in `text`. */
  test(text: string) {
    const program = this.#program;
    const end = program.length - 1;
    /** Adds the steps reachable from `start` at `index` without a character. */
    const add = (steps: Set<number>, start: number, index: number) => {
      const stack = [start];
      for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
        if (steps.has(step)) continue;
        steps.add(step);
        const op = program[step] as Op;
        if ("jump" in op) stack.push(op.jump);
        else if ("fork" in op) stack.push(op.fork[1], op.fork[0]);
        else if ("at" in op && op.at(text, index)) stack.push(step + 1);
      }
    };
    let steps = new Set<number>();
    for (let index = 0; ; ) {
      add(steps, 0, index);
      if (steps.has(end)) return true;
      if (index >= text.length) return false;
      const width =
        this.#unicode && (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      const char = text.slice(index, index + width);
      const next = new Set<number>();
      for (const step of steps) {
        const op = program[step] as Op;
        if ("char" in op && op.char.test(char))
          add(next, step + 1, index + width);
      }
      steps = next;
      index += width;
    }
  }
}
