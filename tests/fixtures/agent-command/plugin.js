// A small Linux/macOS example. Scheduling and output delivery belong to Attention;
// the first-party launcher supplies the command's identity and process lifetime.
export const inject = ["agents"];
export function apply({ agents }) {
  agents.addAttentionSource({
    id: "command",
    description: "Run a command using the scheduling agent's Buzz identity",
    configExample: { command: ["bash", "-c", "buzz tools"] },
    async run({ watch, signal, emit, spawn }) {
      const command = watch.config.command;
      if (
        !Array.isArray(command) ||
        !command.length ||
        command.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
        !command[0]
      )
        throw new Error("A nonempty command argument list is required");
      let output = "";
      const process = await spawn("command", {
        cwd: watch.config.cwd,
        args: command,
        onStdout: (text) => {
          output = (output + text).slice(-65536);
        },
        onStderr: (text) => {
          output = (output + text).slice(-65536);
        },
      });
      const code = await process.exited;
      signal.throwIfAborted();
      if (code !== 0) output += `\nCommand exited with status ${code}`;
      if (output.trim()) emit(output);
    },
  });
}
