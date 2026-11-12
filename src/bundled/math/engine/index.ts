// Plain-TypeScript engine; the UI depends only on this contract-shaped object.
import type { Engine } from "../contract";
import { indexMessage, insideMath, fenceMode } from "./detect";
import { render, toMathML } from "./render";
import { install } from "./fonts";
import { commands } from "./commands";
import { tool } from "./tool";

export const engine: Engine = {
  index: indexMessage,
  render,
  toMathML,
  fenceMode,
  commands,
  insideMath,
  install,
  tool,
};
