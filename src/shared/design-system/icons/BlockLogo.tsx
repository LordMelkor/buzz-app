import { forwardRef, type SVGProps } from "react";

const cells = [0, 3.28, 6.56];

/** The Block, Inc. mark: a three-by-three grid of rounded squares. */
export const BlockLogoArtwork = forwardRef<
  SVGSVGElement,
  SVGProps<SVGSVGElement> & { size?: number | string }
>(function BlockLogoArtwork({ size = "1em", ...props }, ref) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the public gateway supplies accessibility semantics.
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="-1 -1 11.03 11.03"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {cells.flatMap((y) =>
        cells.map((x) => (
          <rect
            key={`${x},${y}`}
            x={x}
            y={y}
            width="2.46"
            height="2.46"
            rx="0.41"
          />
        )),
      )}
    </svg>
  );
});
