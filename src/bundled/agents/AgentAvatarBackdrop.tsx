import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import styles from "./AgentCreate.module.css";

const fade = {
  hidden: (duration: number) => ({ opacity: 0, transition: { duration } }),
  visible: (duration: number) => ({ opacity: 1, transition: { duration } }),
};

/** Crossfade the artwork tint without interpolating or repainting its blur. */
export function AgentAvatarBackdrop({
  src,
  animate,
}: {
  src: string | null | undefined;
  animate: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const duration = animate && !reducedMotion ? 0.24 : 0;
  return (
    <AnimatePresence initial={false} custom={duration}>
      <motion.div
        key={src}
        className={styles.avatarBackdropLayer}
        custom={duration}
        variants={fade}
        initial="hidden"
        animate="visible"
        exit="hidden"
      >
        <ProfileBackdrop src={src} />
      </motion.div>
    </AnimatePresence>
  );
}
