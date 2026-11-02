/** Pointer-only decoration; keyboard selection and reduced motion stay immediate. */
export const avatarMotionAllowed = () =>
  window.matchMedia(
    "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
  ).matches;

/** One frame loop, stable slot geometry, and time-based smoothing for the whole dock. */
export function createDockMagnifier() {
  let frame = 0;
  let lastTime = 0;
  let dock: HTMLElement | null = null;
  let pointer: number | null = null;
  const values = new Map<HTMLElement, { strength: number; shift: number }>();
  const clear = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    for (const item of values.keys()) {
      item.style.transform = "";
      item.style.zIndex = "";
    }
    values.clear();
  };
  const tick = (time: number) => {
    frame = 0;
    if (!dock?.isConnected) {
      clear();
      return;
    }
    const bounds = dock.getBoundingClientRect();
    const scrollLeft = dock.scrollLeft;
    const blend =
      1 - Math.exp(-Math.min(40, lastTime ? time - lastTime : 16) / 55);
    lastTime = time;
    // Read all untransformed slot positions before writing any transforms.
    const targets = (Array.from(dock.children) as HTMLElement[]).map((item) => {
      const center =
        bounds.left + item.offsetLeft - scrollLeft + item.offsetWidth / 2;
      const distance = pointer === null ? Infinity : center - pointer;
      const influence =
        Math.abs(distance) < 100
          ? (1 + Math.cos((Math.PI * distance) / 100)) / 2
          : 0;
      const edge = Math.max(
        0,
        Math.min(
          1,
          (center - bounds.left - 20) / 24,
          (bounds.right - center - 20) / 24,
        ),
      );
      const strength = influence * edge;
      const shift = Number.isFinite(distance)
        ? Math.sin((Math.max(-1, Math.min(1, distance / 50)) * Math.PI) / 2) *
          strength *
          12
        : 0;
      return { item, strength, shift };
    });
    let moving = false;
    for (const { item, strength, shift } of targets) {
      const current = values.get(item) ?? { strength: 0, shift: 0 };
      current.strength += (strength - current.strength) * blend;
      current.shift += (shift - current.shift) * blend;
      if (
        Math.abs(strength - current.strength) > 0.001 ||
        Math.abs(shift - current.shift) > 0.01
      )
        moving = true;
      else {
        current.strength = strength;
        current.shift = shift;
      }
      values.set(item, current);
      item.style.transform = `translate(${current.shift}px, ${-6 * current.strength}px) scale(${1 + 0.675 * current.strength})`;
      item.style.zIndex = String(Math.round(current.strength * 100));
    }
    if (moving) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  };
  return {
    move(element: HTMLElement, x: number | null, immediate = false) {
      if (dock !== element) clear();
      dock = element;
      pointer = x;
      if (immediate) {
        clear();
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    },
    dispose: clear,
  };
}

/** Two opposing half-ovals exchange artwork without crossing through each other. */
export function swapAvatarArtwork(
  source: HTMLElement,
  target: HTMLElement,
  outgoing: string,
) {
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const animations: Animation[] = [];
  const images: HTMLImageElement[] = [];
  const sourceVisibility = source.style.visibility;
  const targetZIndex = target.style.zIndex;
  target.style.zIndex = "2147483647";
  source.style.visibility = "hidden";
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    animations.forEach((animation) => {
      animation.cancel();
    });
    images.forEach((image) => {
      image.remove();
    });
    source.style.visibility = sourceVisibility;
    target.style.zIndex = targetZIndex;
  };
  for (const [arriving, start, end] of [
    [true, from, to],
    [false, to, from],
  ] as const) {
    // Fly the real incoming view: its video loads and starts during the swap,
    // with no poster-to-video replacement when the animation lands.
    const image = arriving ? target : document.createElement("img");
    if (image instanceof HTMLImageElement) {
      image.src = outgoing;
      image.alt = "";
    }
    if (!arriving) {
      image.setAttribute("aria-hidden", "true");
      Object.assign(image.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: `${start.width}px`,
        height: `${start.height}px`,
        objectFit: "contain",
        pointerEvents: "none",
        zIndex: "2147483647",
        transformOrigin: "center",
      });
      document.body.append(image);
      images.push(image as HTMLImageElement);
    }
    const dx = end.x + end.width / 2 - start.x - start.width / 2;
    const dy = end.y + end.height / 2 - start.y - start.height / 2;
    const length = Math.max(1, Math.hypot(dx, dy));
    const arc = Math.min(90, length * 0.35);
    const frames = Array.from({ length: 25 }, (_, index) => {
      const t = index / 24;
      const bend = Math.sin(t * Math.PI) * arc;
      const x = start.x + dx * t - (dy / length) * bend;
      const y = start.y + dy * t + (dx / length) * bend;
      const size = start.width + (end.width - start.width) * t;
      return {
        transform: arriving
          ? `translate(${x + start.width / 2 - to.x - to.width / 2}px, ${y + start.height / 2 - to.y - to.height / 2}px) scale(${size / to.width})`
          : `translate(${x}px, ${y}px) scale(${size / start.width})`,
      };
    });
    animations.push(
      image.animate(frames, {
        duration: 420,
        easing: "cubic-bezier(0.77, 0, 0.175, 1)",
        fill: "forwards",
      }),
    );
  }
  void Promise.all(animations.map((animation) => animation.finished)).then(
    cleanup,
    cleanup,
  );
  return cleanup;
}
