import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/** Scoped by each surface's LayoutGroup: window and toolbar never share a flight. */
export function HuddleAvatarMotion({
  participant,
  children,
  enabled = true,
  playful = false,
  level = 0,
}: {
  participant: string;
  children: ReactNode;
  enabled?: boolean;
  playful?: boolean;
  level?: number;
}) {
  const reduced = useReducedMotion();
  // Stable per-person randomness keeps roster changes from reshuffling tilts.
  const seed =
    Array.from(participant).reduce(
      (hash, char) => (hash * 31 + char.charCodeAt(0)) | 0,
      0,
    ) >>> 0;
  const restingTilt = (seed % 2001) / 100 - 10;
  const tilt = playful
    ? Math.max(
        -10,
        Math.min(
          10,
          restingTilt +
            (reduced
              ? 0
              : Math.min(1, Math.max(0, level)) * 1.5 * (seed % 2 ? 1 : -1)),
        ),
      )
    : 0;

  return (
    <motion.span
      {...(!reduced && enabled
        ? { layoutId: `huddle-avatar:${participant}` }
        : {})}
      data-huddle-avatar={participant}
      initial={
        playful &&
        !reduced &&
        !document.documentElement.hasAttribute("data-keyboard-input")
          ? { scale: 0.9, rotate: -10 }
          : false
      }
      animate={{ scale: 1, rotate: 0 }}
      transition={{
        layout: { duration: 0.28, ease: [0.23, 1, 0.32, 1] },
        scale: { type: "spring", stiffness: 380, damping: 16 },
        rotate: { type: "spring", stiffness: 380, damping: 20 },
      }}
      style={{
        display: "grid",
        width: "100%",
        height: "100%",
        borderRadius: "50%",
      }}
    >
      {playful ? (
        <motion.span
          initial={false}
          animate={{ rotate: tilt }}
          transition={
            reduced ||
            document.documentElement.hasAttribute("data-keyboard-input")
              ? { duration: 0 }
              : { type: "spring", stiffness: 60, damping: 20 }
          }
          style={{
            display: "grid",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        >
          {children}
        </motion.span>
      ) : (
        children
      )}
    </motion.span>
  );
}
