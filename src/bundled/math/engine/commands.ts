import type { CommandInfo } from "../contract";

// Ordered for common writing/completion, not generated from KaTeX internals.
const groups: readonly [string, string][] = [
  [
    "Structure",
    "frac sqrt sum prod int lim binom text overline underline vec hat bar dot ddot",
  ],
  [
    "Greek letter",
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega digamma",
  ],
  [
    "Relation",
    "ne neq le leq ge geq ll gg lll ggg leqq geqq lneq gneq lneqq gneqq lesssim gtrsim lessapprox gtrapprox lessgtr gtrless lesseqgtr gtreqless lesseqqgtr gtreqqless nless ngtr nleq ngeq nleqq ngeqq prec succ preceq succeq precsim succsim precapprox succapprox nprec nsucc npreceq nsucceq preccurlyeq succcurlyeq curlyeqprec curlyeqsucc sim simeq approx approxeq cong asymp doteq Doteq fallingdotseq risingdotseq eqcirc circeq triangleq bumpeq Bumpeq backsim backsimeq nsim ncong equiv propto vdash dashv models Vdash Vvdash vDash nvdash nVdash nvDash nVDash perp mid nmid parallel nparallel shortmid shortparallel nshortmid nshortparallel bowtie Join smile frown pitchfork between varpropto",
  ],
  [
    "Set relation",
    "in ni notin owns subset supset subseteq supseteq subsetneq supsetneq subsetneqq supsetneqq nsubseteq nsupseteq nsubseteqq nsupseteqq Subset Supset subseteqq supseteqq sqsubset sqsupset sqsubseteq sqsupseteq varsubsetneq varsupsetneq varsubsetneqq varsupsetneqq",
  ],
  [
    "Arrow",
    "to gets mapsto longmapsto leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow longleftarrow longrightarrow longleftrightarrow Longleftarrow Longrightarrow Longleftrightarrow iff implies impliedby hookleftarrow hookrightarrow uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow nwarrow leftharpoonup leftharpoondown rightharpoonup rightharpoondown rightleftharpoons leftrightharpoons leadsto rightsquigarrow leftrightsquigarrow twoheadleftarrow twoheadrightarrow leftleftarrows rightrightarrows leftrightarrows rightleftarrows Lleftarrow Rrightarrow leftarrowtail rightarrowtail looparrowleft looparrowright curvearrowleft curvearrowright circlearrowleft circlearrowright multimap nleftarrow nrightarrow nleftrightarrow nLeftarrow nRightarrow nLeftrightarrow restriction upharpoonleft upharpoonright downharpoonleft downharpoonright",
  ],
  [
    "Binary operator",
    "pm mp times div cdot ast star circ bullet oplus ominus otimes oslash odot bigcirc dagger ddagger amalg cap cup uplus sqcap sqcup vee wedge land lor setminus smallsetminus wr diamond triangleleft triangleright lhd rhd unlhd unrhd bigtriangleup bigtriangledown boxplus boxminus boxtimes boxdot dotplus divideontimes intercal centerdot circledast circledcirc circleddash barwedge veebar doublebarwedge curlyvee curlywedge leftthreetimes rightthreetimes ltimes rtimes backslash",
  ],
  [
    "Big operator",
    "coprod bigcap bigcup bigsqcup bigvee bigwedge biguplus bigoplus bigotimes bigodot iint iiint oint oiint oiiint smallint limsup liminf injlim projlim varlimsup varliminf varinjlim varprojlim",
  ],
  [
    "Function",
    "sin cos tan cot sec csc arcsin arccos arctan arctg arcctg sinh cosh tanh coth arg det dim exp gcd hom inf ker lg ln log max min Pr sup deg mod bmod pmod pod operatorname",
  ],
  [
    "Symbol",
    "infty partial nabla ell hbar hslash imath jmath Re Im wp aleph beth gimel daleth emptyset varnothing forall exists nexists neg lnot top bot angle measuredangle sphericalangle triangle triangledown blacktriangle blacktriangledown square Box blacksquare lozenge Diamond blacklozenge prime backprime surd complement checkmark mho eth Finv Game yen pounds S P dag ddag clubsuit diamondsuit heartsuit spadesuit flat natural sharp cdots ldots vdots ddots dots dotsc dotsb dotsm dotsi dotso colon ratio therefore because degree",
  ],
  [
    "Accent",
    "widehat widetilde tilde acute grave breve check mathring overbrace underbrace overrightarrow overleftarrow overleftrightarrow underrightarrow underleftarrow underleftrightarrow overgroup undergroup overlinesegment underlinesegment overset underset stackrel cancel bcancel xcancel phantom hphantom vphantom smash boxed fbox",
  ],
  [
    "Font",
    "mathrm mathit mathbf mathsf mathtt mathbb mathcal mathscr mathfrak boldsymbol bm textrm textsf texttt textnormal textbf textit textup textmd",
  ],
  [
    "Delimiter",
    "langle rangle lceil rceil lfloor rfloor lvert rvert lVert rVert vert Vert lang rang lbrace rbrace lbrack rbrack lparen rparen ulcorner urcorner llcorner lrcorner",
  ],
];
const examples: Record<string, [string, string?]> = {
  frac: [String.raw`\frac{a}{b}`, String.raw`\frac{}{}`],
  sqrt: [String.raw`\sqrt{x}`, String.raw`\sqrt{}`],
  binom: [String.raw`\binom{n}{k}`, String.raw`\binom{}{}`],
  sum: [String.raw`\sum_{i=1}^n i`],
  prod: [String.raw`\prod_{i=1}^n a_i`],
  int: [String.raw`\int_0^1 x\,dx`],
  lim: [String.raw`\lim_{x\to0} f(x)`],
  text: [String.raw`\text{where}`, String.raw`\text{}`],
  mod: [String.raw`a\mod n`, String.raw`\mod{}`],
  pmod: [String.raw`a\equiv b\pmod{n}`, String.raw`\pmod{}`],
  pod: [String.raw`a\pod{n}`, String.raw`\pod{}`],
  operatorname: [
    String.raw`\operatorname{rank}(A)`,
    String.raw`\operatorname{}`,
  ],
  overset: [String.raw`\overset{!}{=}`, String.raw`\overset{}{}`],
  underset: [String.raw`\underset{x}{\lim}`, String.raw`\underset{}{}`],
  stackrel: [String.raw`\stackrel{!}{=}`, String.raw`\stackrel{}{}`],
};
function groupCommands(name: string): string {
  const group = groups.find(([detail]) => detail === name);
  if (!group) throw new Error(`Missing command group: ${name}`);
  return group[1];
}
const argumentCommands = new Set(
  (
    groupCommands("Accent") +
    " " +
    groupCommands("Font") +
    " overline underline vec hat bar dot ddot"
  ).split(" "),
);
const list: CommandInfo[] = [];
const names = new Set<string>();
for (const [detail, commands] of groups)
  for (const name of commands.split(" ")) {
    if (names.has(name)) continue;
    names.add(name);
    const fallback = argumentCommands.has(name) ? `\\${name}{x}` : `\\${name}`;
    const [preview, insert] = examples[name] ?? [
      fallback,
      argumentCommands.has(name) ? `\\${name}{}` : `\\${name}`,
    ];
    list.push(
      Object.freeze({
        name: `\\${name}`,
        detail,
        preview,
        insert: insert ?? `\\${name}`,
      }),
    );
  }
for (const [name, body] of [
  ["matrix", "a & b \\\\ c & d"],
  ["pmatrix", "a & b \\\\ c & d"],
  ["bmatrix", "a & b \\\\ c & d"],
  ["vmatrix", "a & b \\\\ c & d"],
  ["aligned", "a &= b \\\\ c &= d"],
  ["cases", "x & x>0 \\\\ 0 & x\\le0"],
  ["gathered", "a=b \\\\ c=d"],
  ["alignedat", "{2}a&=b & c&=d"],
]) {
  const tex = `\\begin{${name}}${body}\\end{${name}}`;
  list.push(
    Object.freeze({
      name: `\\begin{${name}}`,
      detail: "Environment",
      preview: tex,
      insert: tex,
    }),
  );
}
list.push(
  Object.freeze({
    name: "\\ce",
    detail: "Chemistry",
    preview: String.raw`\ce{2 H2 + O2 -> 2 H2O}`,
    insert: String.raw`\ce{}`,
  }),
);
export const commandList: readonly CommandInfo[] = Object.freeze(list);
export function commands(
  prefix: string,
  limit: number,
): readonly CommandInfo[] {
  if (!prefix || prefix === "\\" || !Number.isFinite(limit) || limit < 1)
    return [];
  return commandList
    .filter((command) => command.name.startsWith(prefix))
    .slice(0, Math.floor(limit));
}
