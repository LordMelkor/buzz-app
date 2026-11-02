// The agent card about to be exported, as drawn: it tilts toward the pointer
// and a rainbow sheen follows it, as a foil card does in the hand.
import type { CSSProperties, PointerEvent } from "react";
import {
  CARD_HEIGHT,
  CARD_RADIUS,
  CARD_WIDTH,
  FOIL_SHEEN,
} from "../../features/agents/share-card";
import styles from "./AgentCardPreview.module.css";

/** The drawn card's proportions and corner, which the preview clips to. */
const geometry = {
  "--card-aspect": `${CARD_WIDTH} / ${CARD_HEIGHT}`,
  "--card-tall": CARD_HEIGHT / CARD_WIDTH,
  "--card-radius": `${(CARD_RADIUS / CARD_WIDTH) * 100}% / ${(CARD_RADIUS / CARD_HEIGHT) * 100}%`,
} as CSSProperties;

const lean = (event: PointerEvent<HTMLDivElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  const style = event.currentTarget.style;
  style.setProperty("--card-x", String((event.clientX - box.left) / box.width));
  style.setProperty("--card-y", String((event.clientY - box.top) / box.height));
};

const rest = (event: PointerEvent<HTMLDivElement>) => {
  event.currentTarget.style.removeProperty("--card-x");
  event.currentTarget.style.removeProperty("--card-y");
};

/** Without `src`, the card's place is held while it is drawn. */
export function AgentCardPreview({
  src,
  alt,
}: {
  src?: string | undefined;
  alt: string;
}) {
  return (
    <div className={styles.stage} style={geometry}>
      {src ? (
        <div className={styles.card} onPointerMove={lean} onPointerLeave={rest}>
          <img className={styles.image} src={src} alt={alt} draggable={false} />
          <span
            className={styles.sheen}
            style={{ "--card-sheen": FOIL_SHEEN } as CSSProperties}
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className={`${styles.card} ${styles.placeholder}`} />
      )}
    </div>
  );
}
