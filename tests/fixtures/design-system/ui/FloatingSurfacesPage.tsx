import { SurfaceInteractionSpecimen } from "./SurfaceInteractionSpecimen";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { PreviewCard } from "../../../../src/shared/design-system/ui/PreviewCard";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Note, PageHeader, Section } from "./primitives";

export function FloatingSurfacesPage() {
  const [value, setValue] = useState("all");
  return (
    <>
      <PageHeader
        title="Floating surfaces"
        intro="Use floating surfaces for menus, choices, previews, and supporting content above the page. Shared materials keep their fill, border, corners, and shadow consistent."
      />
      <SurfaceInteractionSpecimen />
      <Section
        title="The shared recipe"
        description="Apply floating-surface to the outer container. The component owns width, padding, placement, and interaction; the material supplies these four visual roles."
      >
        <div className="flex flex-wrap gap-6 rounded-xl bg-surface-panel p-6">
          <div className="floating-surface flex min-w-0 max-w-full flex-col gap-3 p-6">
            <span className="text-label text-standard">
              A card above the page
            </span>
            <span className="text-body text-subtle">Opaque, not glass.</span>
          </div>
          <dl className="flex min-w-0 flex-col gap-2 text-body text-standard">
            {[
              ["Background", "surface-popover"],
              ["Border", "transparent"],
              ["Corners", "radius-container"],
              ["Shadow", "shadow-panel"],
            ].map(([label, token]) => (
              <div key={label} className="flex flex-wrap gap-x-4 gap-y-1">
                <dt>{label}</dt>
                <dd className="text-mono-sm text-subtle">{token}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
      <p className="text-body-sm text-subtle">
        Small action menus opt into 10px outer corners, 8px rows, and a 4px
        inset. Other floating surfaces retain the 24px panel radius. See the{" "}
        <Link to="/design/components/$slug" params={{ slug: "popover" }}>
          Popover examples
        </Link>{" "}
        for the content-based sizing rule and both treatments.
      </p>
      <Section
        title="Same surface, different behavior"
        description="Hover or focus the preview trigger, then open the Select with a pointer or keyboard. Use the appearance control in the navigation header to compare both modes."
      >
        <div className="flex flex-wrap items-start gap-8 rounded-xl bg-surface-panel p-6">
          <div className="flex min-w-0 flex-col gap-3">
            <PreviewCard
              trigger={<Button variant="ghost">Preview example</Button>}
            >
              <span className="text-label text-standard">Design review</span>
              <span className="text-body-sm text-subtle">
                Supplemental context without leaving the page.
              </span>
            </PreviewCard>
            <Link
              to="/design/components/$component"
              params={{ component: "preview-card" }}
              className="text-body text-link underline"
            >
              Preview Card component
            </Link>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Select
              label="Notifications"
              value={value}
              onValueChange={setValue}
              groups={[
                {
                  label: "Notify me about",
                  options: [
                    { value: "all", label: "All messages" },
                    { value: "mentions", label: "Mentions only" },
                  ],
                },
              ]}
            />
            <Link
              to="/design/components/$component"
              params={{ component: "select" }}
              className="text-body text-link underline"
            >
              Select component
            </Link>
          </div>
        </div>
      </Section>
      <Section
        title="Shared and product uses"
        description="PreviewCard, Select, Combobox, Menu, and Popover reuse floating-surface. Product pickers also use popover-surface for their shared outer treatment."
      >
        <Note>
          Product popover-surface shares the floating fill, border, and shadow,
          and adds popup layering. Compact menus and emoji suggestions retain
          their documented corner treatments. Their product owners keep
          placement, scrolling, and specialized keyboard behavior.
        </Note>
      </Section>
      <Section
        title="Ownership"
        description="Edit styles/materials.css to change the shared material. Keep component-specific layout and interaction with the component."
      >
        <p className="max-w-2xl text-body text-secondary">
          Base UI owns interaction for components built on its primitives.
          Product surfaces retain their specialized behavior. Choose a component
          by its task, then use the shared material for its appearance.
        </p>
        <div className="flex flex-wrap gap-4 text-body text-link underline">
          <Link to="/design/elevation">Elevation</Link>
          <Link to="/design/glass">Glass</Link>
        </div>
      </Section>
    </>
  );
}
