import { worktreeIcon } from "./worktree-icon.mjs";

// Pull `--<name> <value>` and `--<name>=<value>` out of a launcher's arguments.
// Scanning stops at `--`, after which everything belongs to Tauri's runner, and the
// last occurrence wins, as it does for Tauri's own repeated flags. A named option
// with no value yields "", which every caller rejects rather than silently deriving.
export function options(args, names) {
  const values = {};
  const forwarded = [];
  let index = 0;
  for (; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    const name = names.find(
      (candidate) =>
        arg === `--${candidate}` || arg.startsWith(`--${candidate}=`),
    );
    if (name === undefined) forwarded.push(arg);
    else
      values[name] =
        arg === `--${name}`
          ? (args[++index] ?? "")
          : arg.slice(name.length + 3);
  }
  return { values, forwarded, rest: args.slice(index) };
}

// Development launches keep their own app storage, copied once from the
// installed app's, so they never take or block it, but share its Agents folder
// (see `src-tauri/src/sign_out/legacy_identifier.rs`).
const DEV_IDENTIFIER = "xyz.block.buzz.desktop.dev";

export function desktopOverlay(root) {
  const config = { identifier: DEV_IDENTIFIER };
  const icon = worktreeIcon(root);
  if (icon) config.bundle = { icon: [icon] };
  return config;
}
