// Wires the engine (engine/) into host contributions (ui/).
import type { Context } from "../../plugins/author";
import { writeClipboardText } from "../../shared/clipboard";
import type { Engine } from "./contract";
import { engine as defaultEngine } from "./engine";
import { createFence } from "./ui/codeblock";
import { createCompletion } from "./ui/completion";
import { createEquationTool } from "./ui/composer";
import { createExpand } from "./ui/expand";
import { createIcons } from "./ui/icons";
import { createInline, trackSelection } from "./ui/inline";
import { installStyles } from "./ui/styles";

export const inject = ["react", "conversation", "agents", "relay"];

export const PLUGIN_ID = "com.squareup.math";

/** Copy goes through the app's clipboard: on macOS the host writes it, since
 * WebKit refuses a web clipboard write once host traffic has cleared the
 * click's activation. */
async function copyText(text: string): Promise<boolean> {
  return writeClipboardText(text).then(
    () => true,
    () => false,
  );
}

export function apply(ctx: Context) {
  setup(ctx, defaultEngine);
}

/** apply() with an injectable Engine, for tests. */
export function setup(ctx: Context, engine: Engine) {
  const React = ctx.react;
  const icons = createIcons(React);
  // Fonts and KaTeX CSS first, so even a first render in a panel is typeset.
  ctx.effect(() => engine.install());
  ctx.effect(() => installStyles());
  ctx.effect(() => trackSelection());
  const Expand = createExpand(React, engine, icons, copyText);
  ctx.conversation.registerCodeBlock(createFence(React, engine, Expand));
  const directory = () => ctx.relay.snapshot().session;
  ctx.conversation.registerInline(
    createInline(React, engine, Expand, directory),
  );
  ctx.conversation.registerTool(
    createEquationTool(React, engine, icons, directory),
  );
  ctx.conversation.registerCompletion(createCompletion(React, engine));
  ctx.agents.addTool(
    engine.tool as Parameters<Context["agents"]["addTool"]>[0],
  );
}
