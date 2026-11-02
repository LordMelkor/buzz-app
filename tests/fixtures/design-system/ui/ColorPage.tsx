import {
  BACKDROP_CHOICES,
  BACKDROP_TREATMENTS,
  EXCEPTIONS,
  PALETTE,
  RAMPS,
  ROLE_GROUPS,
  type BackdropTreatment,
  type Role,
} from "../../../../src/shared/design-system/tokens/registry";

import { BrandColors } from "./BrandColors";

import { Note, PageHeader, Section, Swatch } from "./primitives";

/**
 * A role, sitting directly on the page.
 *
 * No card and no divider: the swatch is its own separator, and a colour judged
 * on a grey card is not being judged on the surface it will actually be used on.
 * The hairline stays on the swatch itself — `bg-panel` is white on a white page,
 * so without it the most-used role in the system renders as nothing. That is a
 * genuine boundary rather than decoration.
 */
function BackdropTreatmentRow({ treatment }: { treatment: BackdropTreatment }) {
  const paired = BACKDROP_TREATMENTS.find(
    (candidate) => candidate.id === treatment.pairedWith,
  );

  return (
    <div className="flex items-start gap-4 py-2.5">
      <div
        className="mt-0.5 h-9 w-16 shrink-0 rounded-md border border-primary"
        style={{ background: `var(${treatment.variable})` }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-body text-primary">{treatment.name}</code>
          <span className="text-body-sm text-tertiary">
            {treatment.mode} only
          </span>
        </div>
        <p className="text-body-sm text-secondary">{treatment.description}</p>
        <p className="text-body-sm text-tertiary">
          Pairs with {paired?.name ?? treatment.pairedWith} in {paired?.mode}
        </p>
      </div>
    </div>
  );
}

function RoleRow({ role }: { role: Role }) {
  return (
    <div className="flex items-start gap-4 py-2.5">
      <div
        className="mt-0.5 h-9 w-16 shrink-0 rounded-md border border-primary"
        style={{ background: `var(${role.variable})` }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-body text-primary">{role.token}</code>
          <span className="text-body-sm text-tertiary">{role.pointsAt}</span>
          {role.status !== "core" ? (
            <span className="rounded-full bg-purple-3 px-2 py-0.5 text-body-sm text-purple-12">
              {role.status}
              {role.owner ? ` · ${role.owner}` : ""}
            </span>
          ) : null}
        </div>
        <p className="text-body-sm text-secondary">{role.use}</p>
        {role.exception ? (
          <p className="text-body-sm text-tertiary">
            Exception: {role.exception}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ColorPage() {
  return (
    <>
      <PageHeader
        title="Color"
        intro="Choose colors by their purpose: surface, text, border, or action. Shared roles connect those purposes to the palette in light and dark mode. The examples below come from the token registry."
      />

      <Section
        title="Layer 0 — the palette"
        description="Each base hue and Appearance family has twelve steps, authored for light and dark modes. Define raw color values here, then use semantic roles in components. Choose the appropriate step in a shared mapping instead of changing opacity locally."
      >
        <div className="flex flex-col gap-6">
          {PALETTE.map((hue) => (
            <div key={hue.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-label text-primary">{hue.id}</h3>
                <span className="text-body-sm text-tertiary">
                  {hue.usedBy ? `drawn from by ${hue.usedBy}` : "unassigned"}
                </span>
              </div>
              {/* Each step carries what it is for, not just its number. The
                  registry has always held this text and no page rendered it,
                  which is how it drifted: it still described the generic scale
                  the values came from — step 4 as "component hover" — long after
                  this product had made step 4 its one border weight. Unrendered
                  documentation cannot be checked by looking. */}
              <div className="color-palette-ramp">
                {hue.steps.map((step) => (
                  <div
                    key={step.variable}
                    className="flex min-w-0 flex-1 flex-col gap-1"
                  >
                    <div
                      className="h-10 rounded-md border border-primary"
                      style={{ background: `var(${step.variable})` }}
                    />
                    <span className="text-center text-body-sm text-tertiary">
                      {step.step}
                    </span>
                    <span className="text-center text-body-sm text-tertiary">
                      {step.job}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <BrandColors />

      <Section
        title="Legacy glass-study backgrounds"
        description="Historical gradient samples remain for the glass study, not as product themes. The app uses a solid shell with a dot texture derived from its background color."
      >
        <div className="flex flex-col gap-6">
          {(["light", "dark"] as const).map((mode) => (
            <div key={mode} className="flex flex-col gap-2">
              <h3 className="text-label text-primary">{mode} mode</h3>
              <div className="flex flex-col">
                {BACKDROP_TREATMENTS.filter(
                  (treatment) => treatment.mode === mode,
                ).map((treatment) => (
                  <BackdropTreatmentRow
                    key={treatment.id}
                    treatment={treatment}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Legacy glass-study pairs"
        description="These sample pairs are not appearance choices. Product surfaces use the solid bg-app role."
      >
        <div className="flex flex-col">
          {BACKDROP_CHOICES.map((choice) => {
            const light = BACKDROP_TREATMENTS.find(
              (treatment) => treatment.id === choice.lightTreatment,
            );
            const dark = BACKDROP_TREATMENTS.find(
              (treatment) => treatment.id === choice.darkTreatment,
            );
            return (
              <div
                key={choice.variable}
                className="flex items-start gap-4 py-2.5"
              >
                <div
                  className="mt-0.5 h-9 w-16 shrink-0 rounded-md border border-primary"
                  style={{ background: `var(${choice.variable})` }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <code className="text-body text-primary">{choice.token}</code>
                  <p className="text-body-sm text-secondary">{choice.use}</p>
                  <p className="text-body-sm text-tertiary">
                    {light?.name} light / {dark?.name} dark
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Layer 0 — translucency"
        description="The glass ramp increases the opacity of each mode’s surface color. Shared materials combine these fills with blur and a rim. Use a complete glass material in a component, not a raw ramp step."
      >
        <div className="flex flex-col gap-8">
          {RAMPS.map((ramp) => (
            <div key={ramp.id} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-label text-primary">{ramp.name}</h3>
                <p className="max-w-2xl text-body text-secondary">
                  {ramp.description}
                </p>
              </div>
              <div
                className={`color-semantic-ramp ${ramp.translucent ? "rounded-xl bg-app p-4" : ""}`}
              >
                {ramp.steps.map((step) => (
                  <Swatch
                    key={step.variable}
                    variable={step.variable}
                    label={`${ramp.id} ${step.step}`}
                    sublabel={step.job}
                    translucent={ramp.translucent}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Layer 2 — the roles"
        description="Choose a role by its purpose: surface, text, border or control. Shared roles keep callers consistent when values change, even when a role uses the same palette step in both themes."
      >
        <div className="flex flex-col gap-8">
          {ROLE_GROUPS.map((group) => (
            <div key={group.id} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <h3 className="text-label text-primary">{group.name}</h3>
                <p className="max-w-2xl text-body text-secondary">
                  {group.description}
                </p>
              </div>
              <div className="mt-1 flex flex-col">
                {group.roles.map((role) => (
                  <RoleRow key={role.token} role={role} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Deliberate exceptions"
        description="These shared treatments need values outside the color ramps. Each exception records its purpose so it can be reviewed when the system changes."
      >
        {/* No swatch here to do the separating, so these entries keep a little
            structure — the token name leads and the spacing groups it with its
            reason. Still no card: this is prose, not data. */}
        <div className="flex flex-col gap-5">
          {EXCEPTIONS.map((exception) => (
            <div key={exception.name} className="flex flex-col gap-1">
              <code className="text-mono text-purple-12">{exception.name}</code>
              <p className="max-w-2xl text-body text-secondary">
                {exception.why}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Note>
        The original design exploration covered light mode. Dark values were
        authored for Buzz. Use the appearance control in the navigation header
        to compare both modes, and report combinations that are hard to read.
      </Note>
    </>
  );
}
