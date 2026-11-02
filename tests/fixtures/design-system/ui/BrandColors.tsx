import { BRAND_GRADIENTS } from "../../../../src/shared/design-system/tokens/brand";
import { Section } from "./primitives";

export function BrandColors() {
  return (
    <Section
      title="Colorways and plugin gradients"
      description="Plugin artwork uses named palette steps. Its current step-9 endpoints have the same values in light and dark mode. Complete palette ramps are shown in Layer 0 below."
    >
      <div className="brand-gradient-grid">
        {BRAND_GRADIENTS.map((gradient) => (
          <div
            key={gradient.category}
            className="flex w-full min-w-0 flex-col gap-2"
          >
            <div
              className="h-16 rounded-md"
              style={{
                background: `var(--art-plugin-${gradient.category}-gradient)`,
              }}
            />
            <span className="text-body-sm text-primary">{gradient.name}</span>
            <span className="text-body-sm text-secondary">
              {gradient.start} → {gradient.end}
            </span>
            <p className="text-body-sm text-secondary">{gradient.compromise}</p>
          </div>
        ))}
      </div>
      <p className="text-body-sm text-secondary">
        Family references follow the active theme. Shared luminance, chroma,
        contrast and the original 35° hue shifts are no longer guaranteed.
        Compare the real catalog in both modes before judging the mapping.
      </p>
    </Section>
  );
}
