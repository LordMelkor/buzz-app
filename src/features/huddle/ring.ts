import type { Huddles } from "./service";

export const HUDDLE_RING = "/sounds/huddle-ping.m4a";

/** One main-window player for both request surfaces; repeats one second after each clip. */
export function createHuddleRing(
  huddles: Pick<Huddles, "snapshot" | "subscribe">,
  makeAudio = () => new Audio(HUDDLE_RING),
) {
  let key: string | undefined;
  let answered: string | undefined;
  let stopRing: (() => void) | undefined;
  function sync() {
    const call = huddles.snapshot();
    if (
      call.phase === "connecting" &&
      key === `${call.destination?.scope}:${call.room}`
    )
      answered = key;
    const request =
      call.phase === "incoming"
        ? `${call.destination?.scope}:${call.id}`
        : undefined;
    const next = request === answered ? undefined : request;
    if (next === key) return;
    stopRing?.();
    stopRing = undefined;
    key = next;
    if (!next) return;
    const audio = makeAudio();
    audio.preload = "auto";
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = () => {
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
    };
    function play() {
      unlisten();
      if (stopped) return;
      audio.currentTime = 0;
      void audio.play().catch((error: unknown) => {
        // A browser may require the first interaction. Never spin/retry a broken file.
        if (
          !stopped &&
          error instanceof DOMException &&
          error.name === "NotAllowedError"
        ) {
          window.addEventListener("pointerdown", play, { once: true });
          window.addEventListener("keydown", play, { once: true });
        }
      });
    }
    const ended = () => {
      if (!stopped) timer = setTimeout(play, 1000);
    };
    audio.addEventListener("ended", ended);
    stopRing = () => {
      stopped = true;
      clearTimeout(timer);
      unlisten();
      audio.removeEventListener("ended", ended);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
    play();
  }
  const unsubscribe = huddles.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    stopRing?.();
  };
}
