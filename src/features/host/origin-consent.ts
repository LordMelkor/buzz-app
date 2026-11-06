// The questions plugins ask the person using Buzz about network origins,
// answered one at a time by `OriginConsentPrompt`.
export type OriginQuestion = Readonly<{
  /** The plugin's id and its own display name. */
  plugin: Readonly<{ id: string; name: string }>;
  /** An exact HTTPS origin. */
  origin: string;
}>;
type Pending = OriginQuestion & {
  /** Unique per question, so a repeat of one is still a new prompt. */
  id: number;
  answer(approved: boolean): void;
};

/** A plugin cannot grow the queue without bound by asking in a loop. */
const QUEUE_MAX = 16;
let queue: readonly Pending[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/** Resolves true only when the person allows it; closing the prompt or
 * leaving the app declines. `signal` withdraws the question, closing its
 * prompt, and rejects with its reason. */
export function askOriginConsent(
  question: OriginQuestion,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (queue.length >= QUEUE_MAX)
    return Promise.reject(new Error("Too many origin requests are waiting"));
  return new Promise((resolve, reject) => {
    const withdraw = () => {
      queue = queue.filter((item) => item !== pending);
      publish();
      reject(signal.reason);
    };
    const pending: Pending = {
      ...question,
      id: nextId++,
      answer(approved) {
        signal.removeEventListener("abort", withdraw);
        resolve(approved);
      },
    };
    signal.addEventListener("abort", withdraw, { once: true });
    queue = [...queue, pending];
    publish();
  });
}
export const originConsent = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The question on screen, or none. */
  current: () => queue[0],
  /** Answers the question on screen; the next one follows. */
  answer(approved: boolean) {
    const [first, ...rest] = queue;
    if (!first) return;
    queue = rest;
    first.answer(approved);
    publish();
  },
  /** Declines everything waiting. */
  declineAll() {
    const waiting = queue;
    queue = [];
    for (const item of waiting) item.answer(false);
    publish();
  },
};
