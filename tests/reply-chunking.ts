import { expect } from "vitest";

type Wire = {
  ids: (number | string | undefined)[];
  replies: Promise<unknown>[];
  stdout: (chunk: string) => void;
};

export async function checkReplyChunking(open: () => Promise<Wire>) {
  async function deliver(split: (payload: string) => string[]) {
    const { ids, replies, stdout } = await open();
    expect(ids).toHaveLength(3);
    const lines = ids.map((id, index) =>
      JSON.stringify({ jsonrpc: "2.0", id, result: index + 1 }),
    );
    const payload = `${lines[1]}\r\n\n  ${lines[0]}  \n${lines[2]}`;
    const delivered: unknown[] = [];
    const answers = replies.map((reply) =>
      reply.then((value) => delivered.push(value)),
    );
    for (const chunk of split(payload)) stdout(chunk);
    await Promise.all(answers.slice(0, 2));
    const beforeNewline = [...delivered];
    stdout("\n");
    await Promise.all(answers);
    return { length: payload.length, beforeNewline, delivered };
  }

  const whole = await deliver((payload) => [payload]);
  expect(whole.beforeNewline).toEqual([2, 1]);
  expect(whole.delivered).toEqual([2, 1, 3]);
  for (let cut = 0; cut <= whole.length; cut++) {
    const split = await deliver((payload) => [
      payload.slice(0, cut),
      payload.slice(cut),
    ]);
    expect(split, `split at ${cut}`).toEqual(whole);
  }
  expect(await deliver((payload) => [...payload])).toEqual(whole);
}
