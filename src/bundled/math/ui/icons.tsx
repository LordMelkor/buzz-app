// Stroke icons that follow the text colour (Phosphor-like, 20px grid).
import type * as ReactNS from "react";

export type Icons = ReturnType<typeof createIcons>;

// JSX here uses the app's automatic runtime, not the injected React.
export function createIcons(_React: typeof ReactNS) {
  const icon = (size: number, ...paths: string[]) =>
    function Icon() {
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 256 256"
          fill="none"
          stroke="currentColor"
          strokeWidth={16}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      );
    };
  return {
    /** Σ: the composer Equation tool. */
    Sigma: icon(20, "M192 56H64l72 72-72 72h128"),
    Expand: icon(
      16,
      "M160 48h48v48",
      "M144 112l64-64",
      "M96 208H48v-48",
      "M112 144l-64 64",
    ),
    Close: icon(16, "M200 56L56 200", "M200 200L56 56"),
  };
}
