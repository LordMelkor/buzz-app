import type { AttentionSource } from "./attention-sources";

/** Saved identities belong to their bundled owners, including legacy aliases. */
export const bundledAttention = {
  providers: [
    { plugin: "buzz.agents", id: "command", provider: "attention/command" },
    { plugin: "buzz.github", id: "github-pr", provider: "attention/github-pr" },
  ],
} as const;

type Sources = {
  addAttentionSource(source: AttentionSource): void;
};

/** Attention owns when the producer runs and where output goes. The process
 * host kills descendants on cancellation; no owner credentials are passed as arguments. */
export function registerAttention(
  ctx: {
    agents: Sources;
  },
  ids: readonly "command"[] = ["command"],
) {
  for (const id of ids)
    ctx.agents.addAttentionSource({
      id,
      description: "Run a command as the subscribed agent",
      configExample: {
        command: ["program", "argument"],
        cwd: "/absolute/optional/directory",
      },
      async run({ watch, signal, emit, spawn }) {
        let omitted = 0;
        let buffer = "",
          stderr = "",
          timer: ReturnType<typeof setTimeout> | undefined,
          ended = false;
        let resolveDrain: (() => void) | undefined;
        const drained = new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
        const flush = () => {
          clearTimeout(timer);
          timer = undefined;
          if (signal.aborted) {
            buffer = "";
            resolveDrain?.();
            return;
          }
          if (buffer.trim()) {
            try {
              emit(
                `${omitted ? `[${omitted} characters omitted while delivery was unavailable]\n` : ""}${buffer}`,
              );
              buffer = "";
              omitted = 0;
            } catch {
              timer = setTimeout(flush, 5000);
              return;
            }
          }
          if (ended) resolveDrain?.();
        };
        const append = (data: string) => {
          // Deliver full chunks before applying the bound to refused output.
          for (let offset = 0; offset < data.length; ) {
            if (buffer.length === 65536) flush();
            let end = Math.min(
              data.length,
              offset + (65536 - buffer.length || 65536),
            );
            if (
              /[\uD800-\uDBFF]/u.test(data.charAt(end - 1)) &&
              /[\uDC00-\uDFFF]/u.test(data.charAt(end))
            ) {
              if (end - offset === 1) {
                flush();
                end = Math.min(data.length, offset + 2);
              } else end--;
            }
            const chunk = data.slice(offset, end);
            const combined = buffer + chunk;
            let start = Math.max(0, combined.length - 65536);
            if (
              start &&
              /[\uDC00-\uDFFF]/u.test(combined.charAt(start)) &&
              /[\uD800-\uDBFF]/u.test(combined.charAt(start - 1))
            )
              start++;
            omitted += start;
            buffer = combined.slice(start);
            offset += chunk.length;
          }
          if (!timer)
            timer = setTimeout(() => {
              timer = undefined;
              flush();
            }, 1000);
        };
        const command = watch.config.command;
        if (
          !Array.isArray(command) ||
          !command.length ||
          command.some(
            (part) => typeof part !== "string" || part.includes("\0"),
          ) ||
          !command[0]
        )
          throw new Error("A command watch needs a non-empty argument list");
        const cwd = watch.config.cwd;
        if (
          cwd !== undefined &&
          (typeof cwd !== "string" ||
            !(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd)))
        )
          throw new Error("cwd must be absolute");
        if (!spawn)
          throw new Error(
            "This host cannot run commands as the agent. Update Buzz first.",
          );
        let failure: Error | undefined;
        const process = await spawn("attention-command", {
          args: command,
          ...(typeof cwd === "string" ? { cwd } : {}),
          onStdout: append,
          onStderr: (data) => {
            stderr = (stderr + data).slice(-16384);
            console.warn("Attention command:", data);
          },
        }).catch((error) => {
          failure = new Error(
            `Attention command could not start: ${String(error)}`,
          );
          append(`${failure.message}\n`);
          ended = true;
          flush();
          return undefined;
        });
        if (!process) {
          signal.addEventListener("abort", flush, { once: true });
          if (signal.aborted) flush();
          await drained;
          signal.removeEventListener("abort", flush);
          if (!signal.aborted) throw failure;
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          buffer = "";
          resolveDrain?.();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          await process.end().catch((error: unknown) => {
            // A fast command may exit before the close reaches the native host.
            if (
              (error instanceof Error ? error.message : String(error)) !==
              "No such process"
            )
              throw error;
          });
          const code = await process.exited;
          if (!signal.aborted && code !== 0) {
            failure = new Error(
              `Attention command exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            );
            append(`\n${failure.message}\n`);
          }
          ended = true;
          clearTimeout(timer);
          timer = undefined;
          flush();
          await drained;
          if (!signal.aborted && failure) throw failure;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      },
    });
}
