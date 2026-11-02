import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { Avatar } from "./Avatar";
import styles from "./AvatarStack.module.css";

type StackAvatar = {
  id: string;
  name: string;
  src?: string | undefined;
  shape: "circle" | "squircle";
};

/** Compact identity artwork. The enclosing control supplies its accessible name. */
export function AvatarStack({
  items,
  size = "compact",
  max = 3,
  animateEntrance = false,
}: {
  items: readonly StackAvatar[];
  size?: "compact" | "small" | "mini" | "hero" | "hero-large";
  /** How many avatars show before the overflow count. */
  max?: number;
  /** Playful hero entry, matching the huddle avatar spring. */
  animateEntrance?: boolean;
}) {
  const Item = animateEntrance ? EntranceItem : "span";
  if (!items.length) return null;
  return (
    <span
      className={`${styles.root} text-caption`}
      aria-hidden="true"
      data-avatar-stack=""
      data-size={size}
    >
      {items.slice(0, max).map((item, index) => (
        <Item
          key={item.id}
          className={styles.item}
          // Each overlaps the one before it.
          style={{ zIndex: index + 1 }}
          data-avatar-shape={item.shape}
          title={item.name}
        >
          <Avatar
            src={item.src}
            alt=""
            fallback={item.name}
            fallbackContent={
              size === "mini" ? (
                <span className={`${styles.miniInitial} text-caption`}>
                  {Array.from(item.name.trim())[0]?.toUpperCase() || "?"}
                </span>
              ) : undefined
            }
            shape={item.shape}
            size="fill"
          />
        </Item>
      ))}
      {items.length > max &&
        (size === "hero" || size === "hero-large" ? (
          // A hero count is one more stack item, shaped like the avatars.
          <span
            className={styles.item}
            data-avatar-shape={items[0]?.shape}
            style={{ zIndex: max + 1 }}
          >
            <span
              className={`${styles.countFill} text-label`}
              data-avatar-shape={items[0]?.shape}
            >
              +{items.length - max}
            </span>
          </span>
        ) : (
          <span className={styles.count}>+{items.length - max}</span>
        ))}
    </span>
  );
}

/** Only opted-in stacks pay for Motion's component and animation lifecycle. */
function EntranceItem(props: HTMLMotionProps<"span">) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      {...props}
      initial={reduced ? false : { scale: 0.9, rotate: -10 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={
        reduced
          ? { duration: 0 }
          : {
              scale: { type: "spring", stiffness: 380, damping: 16 },
              rotate: { type: "spring", stiffness: 380, damping: 20 },
            }
      }
    />
  );
}
