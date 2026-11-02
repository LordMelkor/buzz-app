import { motion, useMotionValue } from "motion/react";
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./Huddles.module.css";

/** Local, temporary displacement: the cloud still owns every resting position. */
export function HuddleAvatarToss({
  stage,
  children,
}: {
  stage: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [motionPreference] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)"),
  );
  const [constraints, setConstraints] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>();
  const velocity = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const [moving, setMoving] = useState(false);
  const [returning, setReturning] = useState(false);
  const reset = useCallback(() => {
    setReturning(false);
    velocity.current = null;
    dragging.current = false;
    x.set(0);
    y.set(0);
    setMoving(false);
  }, [x, y]);
  useEffect(() => {
    const area = stage.current;
    if (!area) return;
    // Window and panel resizing reset temporary displacement.
    const observer = new ResizeObserver(() => {
      setReturning(false);
      velocity.current = null;
      x.set(0);
      y.set(0);
      setMoving(false);
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [stage, x, y]);
  useEffect(() => {
    if (!returning) return;
    let previous = performance.now();
    let frame: number;
    const step = (now: number) => {
      const delta = now - previous;
      previous = now;
      const speed = velocity.current;
      if (!speed) return;
      if (motionPreference.matches || !element.current || !stage.current) {
        reset();
        return;
      }
      const portrait = element.current.getBoundingClientRect();
      const area = stage.current.getBoundingClientRect();
      // Small integration steps keep collisions stable after a slow frame.
      const dt = Math.min(delta, 32) / 1000;
      const advance = (
        position: number,
        momentum: number,
        min: number,
        max: number,
      ) => {
        let nextSpeed = momentum + (-65 * position - 13 * momentum) * dt;
        let next = position + nextSpeed * dt;
        if (next < min) {
          next = min;
          nextSpeed = Math.abs(nextSpeed) * 0.4;
        }
        if (next > max) {
          next = max;
          nextSpeed = -Math.abs(nextSpeed) * 0.4;
        }
        return [next, nextSpeed] as const;
      };
      const [nextX, vx] = advance(
        x.get(),
        speed.x,
        area.left - portrait.left + x.get(),
        area.right - portrait.right + x.get(),
      );
      const [nextY, vy] = advance(
        y.get(),
        speed.y,
        area.top - portrait.top + y.get(),
        area.bottom - portrait.bottom + y.get(),
      );
      x.set(nextX);
      y.set(nextY);
      speed.x = vx;
      speed.y = vy;
      if (Math.hypot(nextX, nextY) < 0.5 && Math.hypot(vx, vy) < 5) {
        reset();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [returning, motionPreference, stage, x, y, reset]);
  return (
    <motion.span
      ref={element}
      className={styles.avatarToss}
      data-avatar-moving={moving || undefined}
      drag
      dragConstraints={constraints ?? false}
      dragElastic={0}
      dragMomentum={false}
      style={{ x, y }}
      onPointerDown={() => {
        setReturning(false);
        velocity.current = null;
        // Capture bounds for this gesture; ref constraints also rescale resting
        // displacement when the roster layout changes.
        const portrait = element.current?.getBoundingClientRect();
        const area = stage.current?.getBoundingClientRect();
        if (portrait && area)
          setConstraints({
            left: area.left - portrait.left + x.get(),
            right: area.right - portrait.right + x.get(),
            top: area.top - portrait.top + y.get(),
            bottom: area.bottom - portrait.bottom + y.get(),
          });
      }}
      onPointerUp={() => {
        if (!dragging.current) {
          if (motionPreference.matches) reset();
          else if (x.get() || y.get()) {
            velocity.current = { x: 0, y: 0 };
            setReturning(true);
          }
        }
      }}
      onPointerCancel={reset}
      onDragStart={() => {
        dragging.current = true;
        setMoving(true);
      }}
      onDragEnd={(event, info) => {
        dragging.current = false;
        if (event.type === "pointercancel" || motionPreference.matches) {
          reset();
          return;
        }
        velocity.current = {
          x: Math.max(-1400, Math.min(1400, info.velocity.x)),
          y: Math.max(-1400, Math.min(1400, info.velocity.y)),
        };
        setReturning(true);
      }}
    >
      {children}
    </motion.span>
  );
}
