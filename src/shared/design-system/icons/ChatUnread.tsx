import { forwardRef } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Tabler-style chat bubble with a separate, designer-requested unread dot. */
export const ChatUnreadArtwork = forwardRef<SVGSVGElement, IconProps>(
  function ChatUnreadArtwork({ size = "1em", ...props }, ref) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        <path d="M13 4.2c-2.3-.3-4.7.3-6.6 1.6C2.9 8.3 2 12.7 4.3 16.1L3 20l4.7-1c4 1.9 8.9.9 11.6-2.3 1.4-1.7 2-3.7 1.7-5.7" />
        <circle cx="19" cy="5" r="3" fill="currentColor" stroke="none" />
      </svg>
    );
  },
);
