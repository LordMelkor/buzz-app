import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import inlineStyles from "../../shared/InlineReference.module.css";

/** Names a Settings section within a sentence. With `open`, it is a link to
 * that section; without one, the sentence still reads as plain text. */
export function SettingsSectionLink({
  section,
  open,
  children,
}: {
  section: string;
  open?: ((section: string) => void) | undefined;
  children: ReactNode;
}) {
  return open ? (
    <BaseButton
      data-buzz-ui=""
      className={inlineStyles.link}
      onClick={() => open(section)}
    >
      {children}
    </BaseButton>
  ) : (
    children
  );
}
