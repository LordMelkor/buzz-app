import { SidebarNavigation } from "../../../../src/shared/design-system/ui/SidebarNavigation";
import { ExamplePreview } from "./ExamplePreview";
import { SectionHeading } from "./primitives";
import { useId, useState, type ReactNode } from "react";
import { Accordion } from "../../../../src/shared/design-system/ui/Accordion";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import { NavigationItem } from "../../../../src/shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../../../src/shared/design-system/ui/NavigationSection";
import { Header } from "../../../../src/shared/design-system/ui/Header";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import {
  Radio,
  RadioGroup,
} from "../../../../src/shared/design-system/ui/RadioGroup";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";

/** Viewer-only compositions of the shared dialog; no product behavior or new variants. */
function Example({
  label,
  code,
  description,
  title,
  artwork,
  intro,
  action = "Save",
  informational = false,
  height,
  bodyLayout,
  chromeSpacing,
  size,
  children,
}: {
  label: string;
  code: string;
  description: string;
  title: string;
  artwork?: ReactNode;
  intro?: string;
  action?: string;
  informational?: boolean;
  height?: "content" | "stable" | "stable-tall";
  chromeSpacing?: "default" | "padded";
  bodyLayout?: "flow" | "flex";
  size?: "compact" | "default" | "wide" | "expanded";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section
      className="component-specimen-group"
      aria-labelledby={`${id}-label`}
    >
      <SectionHeading
        id={`${id}-label`}
        title={label}
        description={description}
      />
      <ExamplePreview
        label={label}
        code={`const [open, setOpen] = useState(false);
const id = useId();

<Button onClick={() => setOpen(true)}>Open dialog</Button>
<Dialog
  open={open}
  onOpenChange={setOpen}
  title=${JSON.stringify(title)}${artwork ? '\n  artwork={<Avatar size="large" alt="" fallback="A" />}' : ""}${size ? `\n  size="${size}"` : ""}${height ? `\n  height="${height}"` : ""}${bodyLayout ? `\n  bodyLayout="${bodyLayout}"` : ""}${chromeSpacing ? `\n  chromeSpacing="${chromeSpacing}"` : ""}${intro ? `\n  description=${JSON.stringify(intro)}` : ""}
  actions={${
    informational
      ? '<Button variant="prominent" onClick={() => setOpen(false)}>Done</Button>'
      : `<>\n    <Button onClick={() => setOpen(false)}>Cancel</Button>\n    <Button variant="prominent" type="submit" form={id}>${action}</Button>\n  </>`
  }}
>
${informational ? "" : `  <form id={id} className="space-y-section-gap" onSubmit={(event) => {\n    event.preventDefault();\n    setOpen(false);\n  }}>\n`}${code
  .split("\n")
  .map((line) => `${informational ? "  " : "    "}${line}`)
  .join("\n")}${informational ? "" : "\n  </form>"}
</Dialog>`}
      >
        <div className="flex w-full justify-center">
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
        </div>
      </ExamplePreview>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        artwork={artwork}
        {...(size ? { size } : {})}
        {...(height ? { height } : {})}
        {...(bodyLayout ? { bodyLayout } : {})}
        {...(chromeSpacing ? { chromeSpacing } : {})}
        {...(intro ? { description: intro } : {})}
        actions={
          informational ? (
            <Button variant="prominent" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="prominent" type="submit" form={`${id}-form`}>
                {action}
              </Button>
            </>
          )
        }
      >
        {informational ? (
          children
        ) : (
          <form
            id={`${id}-form`}
            className="space-y-section-gap"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
          >
            {children}
          </form>
        )}
      </Dialog>
    </section>
  );
}

function ScrollToEdgeExample() {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="component-specimen-group"
      aria-label="Footerless scrolling list"
    >
      <SectionHeading
        title="Footerless scrolling list"
        description="A bounded list with no footer; content scrolls to the bottom inset."
      />
      <ExamplePreview
        label="Footerless scrolling list"
        code={
          'const [open, setOpen] = useState(false);\n\n<Button onClick={() => setOpen(true)}>Open footerless scrolling list</Button>\n<Dialog\n  open={open}\n  onOpenChange={setOpen}\n  title="Scrolling list"\n  height="stable"\n  bodyLayout="flex"\n  footerGap="none"\n>\n  <div className="buzz-thin-scrollbar min-h-0 overflow-auto pb-6">\n    {Array.from(\n      { length: 24 },\n      (_, index) => "List item " + (index + 1),\n    ).map((label) => (\n      <p className="py-3 text-body" key={label}>\n        {label}\n      </p>\n    ))}\n  </div>\n</Dialog>'
        }
      >
        <div className="flex w-full justify-center">
          <Button onClick={() => setOpen(true)}>
            Open footerless scrolling list
          </Button>
        </div>
      </ExamplePreview>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Scrolling list"
        height="stable"
        bodyLayout="flex"
        footerGap="none"
      >
        <div className="buzz-thin-scrollbar min-h-0 overflow-auto pb-6">
          {Array.from(
            { length: 24 },
            (_, index) => `List item ${index + 1}`,
          ).map((label) => (
            <p className="py-3 text-body" key={label}>
              {label}
            </p>
          ))}
        </div>
      </Dialog>
    </section>
  );
}

function NavigationExample() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("General");
  return (
    <section
      className="component-specimen-group"
      aria-label="Integrated navigation"
    >
      <SectionHeading
        title="Integrated navigation"
        description="One expanded modal surface with a compact header, flush sidebar and independently scrolling content. Host-contained sectioned modals center within a 72rem × 48rem frame with a 1rem gutter. Narrow navigation stacks above the content."
      />
      <ExamplePreview
        label="Integrated navigation"
        code={
          'const [open, setOpen] = useState(false);\nconst [section, setSection] = useState("General");\n\n<Button onClick={() => setOpen(true)}>Open navigated modal</Button>\n<Dialog\n  open={open}\n  onOpenChange={setOpen}\n  title="Preferences"\n  navigation={{\n    label: "Preference sections",\n    content: (\n      <SidebarNavigation wrapSections>\n        <NavigationSection label="Preferences">\n          {["General", "Notifications"].map((label) => (\n            <NavigationItem\n              key={label}\n              label={label}\n              selected={section === label}\n              onClick={() => setSection(label)}\n            />\n          ))}\n        </NavigationSection>\n      </SidebarNavigation>\n    ),\n  }}\n>\n  <Header title={section} />\n  <p className="text-body text-secondary">\n    Existing controls keep their own save behavior. Closing returns to the\n    work underneath.\n  </p>\n</Dialog>'
        }
      >
        <div className="flex w-full justify-center">
          <Button onClick={() => setOpen(true)}>Open navigated modal</Button>
        </div>
      </ExamplePreview>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Preferences"
        navigation={{
          label: "Preference sections",
          content: (
            <SidebarNavigation wrapSections>
              <NavigationSection label="Preferences">
                {["General", "Notifications"].map((label) => (
                  <NavigationItem
                    key={label}
                    label={label}
                    selected={section === label}
                    onClick={() => setSection(label)}
                  />
                ))}
              </NavigationSection>
            </SidebarNavigation>
          ),
        }}
      >
        <Header title={section} />
        <p className="text-body text-secondary">
          Existing controls keep their own save behavior. Closing returns to the
          work underneath.
        </p>
      </Dialog>
    </section>
  );
}

export function DialogSpecimens() {
  return (
    <div className="component-specimen-stack">
      <Example
        label="Illustrated introduction"
        description="Artwork above a centered title and description; shared Close stays at the top right."
        title="Add an agent to another community"
        artwork={<Avatar size="large" alt="" fallback="A" />}
        size="compact"
        informational
        intro="The agent stays in its other communities too."
        code=""
      >
        {null}
      </Example>
      <ScrollToEdgeExample />
      <NavigationExample />
      <Example
        label="Wide catalog"
        description="A bounded wide surface for a sidebar and setup details."
        title="Add harness"
        size="wide"
        height="stable"
        informational
        code={`<div className="grid grid-cols-[12rem_1fr] gap-6">
  <p className="text-label">Harnesses</p>
  <p className="text-body">Choose a harness to see its setup details.</p>
</div>`}
      >
        <div className="grid gap-6 sm:grid-cols-[12rem_1fr]">
          <p className="text-label">Harnesses</p>
          <p className="text-body">
            Choose a harness to see its setup details.
          </p>
        </div>
      </Example>
      <Example
        label="Tall creation surface"
        description="Proposed stable-tall height and padded chrome, as used by agent creation."
        title="Create an item"
        height="stable-tall"
        chromeSpacing="padded"
        code={'<Field label="Name"><Input placeholder="Name" /></Field>'}
      >
        <Field label="Name">
          <Input placeholder="Name" />
        </Field>
      </Example>
      <Example
        label="Simple message"
        size="compact"
        description="A short message and a single action when no input is needed."
        title="A place for your team"
        informational
        intro="Keep project notes, conversations, and shared decisions together in one workspace."
        code=""
      >
        {null}
      </Example>
      <Example
        label="Stable height"
        description="Reserve space when content changes. The body scrolls while the title and actions stay in place."
        title="Browse options"
        height="stable"
        informational
        code={`<Accordion
  items={[
    {
      value: "details",
      title: "More details",
      content: (
        <p className="text-body">
          Expanding content does not resize this dialog.
        </p>
      ),
    },
  ]}
/>`}
      >
        <Accordion
          items={[
            {
              value: "details",
              title: "More details",
              content: (
                <p className="text-body">
                  Expanding content does not resize this dialog.
                </p>
              ),
            },
          ]}
        />
      </Example>
      <Example
        label="Fixed controls and scrolling content"
        description="A fixed search field above a single list that fills the remaining height."
        title="Browse people"
        height="stable"
        bodyLayout="flex"
        informational
        code={`<div className="flex min-h-0 flex-1 flex-col gap-4">
  <div className="shrink-0">
    <Input aria-label="Search people" placeholder="Search people" />
  </div>
  <section className="min-h-0 flex-1 overflow-auto" aria-label="People">
    {Array.from(
      { length: 20 },
      (_, index) => \`Person \${index + 1}\`,
    ).map((name) => (
      <p key={name} className="py-2 text-body-sm">
        {name}
      </p>
    ))}
  </section>
</div>`}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="shrink-0">
            <Input aria-label="Search people" placeholder="Search people" />
          </div>
          <section className="min-h-0 flex-1 overflow-auto" aria-label="People">
            {Array.from(
              { length: 20 },
              (_, index) => `Person ${index + 1}`,
            ).map((name) => (
              <p key={name} className="py-2 text-body-sm">
                {name}
              </p>
            ))}
          </section>
        </div>
      </Example>
      <Example
        label="Single field"
        size="compact"
        description="A focused edit with one field and a clear save action."
        title="Edit workspace"
        intro="Choose a name your team will recognize."
        code={`<Field label="Workspace name">
  <Input defaultValue="Project notes" required />
</Field>`}
      >
        <Field label="Workspace name">
          <Input defaultValue="Project notes" required />
        </Field>
      </Example>
      <Example
        label="Choose an option"
        size="compact"
        description="A short list of mutually exclusive choices, with room to explain each one."
        title="Who can join?"
        intro="Choose how people join this workspace."
        action="Apply"
        code={`<Field label="Workspace access">
  <RadioGroup defaultValue="invite" name="access">
    <Radio
      value="invite"
      label="Invite only"
      description="Only people you invite can join."
    />
    <Radio
      value="request"
      label="Request access"
      description="People can ask an owner to join."
    />
    <Radio
      value="team"
      label="Anyone on the team"
      description="Your whole team can find and join this workspace."
    />
  </RadioGroup>
</Field>`}
      >
        <Field label="Workspace access">
          <RadioGroup defaultValue="invite" name="access">
            <Radio
              value="invite"
              label="Invite only"
              description="Only people you invite can join."
            />
            <Radio
              value="request"
              label="Request access"
              description="People can ask an owner to join."
            />
            <Radio
              value="team"
              label="Anyone on the team"
              description="Your whole team can find and join this workspace."
            />
          </RadioGroup>
        </Field>
      </Example>
      <Example
        label="Short form"
        description="Related fields in one column, with helper text and a primary action."
        title="Create a project"
        intro="Give your team a shared place to get started."
        action="Create project"
        code={`<div className="space-y-4">
  <Field label="Project name">
    <Input placeholder="Website refresh" required />
  </Field>
  <Field
    label="Description"
    description="A sentence or two about what you're working on."
  >
    <Textarea
      rows={3}
      placeholder="What should this project accomplish?"
    />
  </Field>
  <Checkbox
    label="Let teammates discover this project"
    defaultChecked
  />
</div>`}
      >
        <div className="space-y-4">
          <Field label="Project name">
            <Input placeholder="Website refresh" required />
          </Field>
          <Field
            label="Description"
            description="A sentence or two about what you're working on."
          >
            <Textarea
              rows={3}
              placeholder="What should this project accomplish?"
            />
          </Field>
          <Checkbox
            label="Let teammates discover this project"
            defaultChecked
          />
        </div>
      </Example>
      <Example
        label="Grouped settings"
        description="A longer form with named sections and optional details. Content and actions share one scroll area on smaller screens."
        title="Workspace settings"
        intro="Manage the details and defaults for your workspace."
        action="Save changes"
        code={`<fieldset className="min-w-0 space-y-4">
  <legend className="mb-4 text-label">General</legend>
  <Field label="Workspace name">
    <Input defaultValue="Design studio" required />
  </Field>
  <Field label="Description">
    <Textarea
      rows={3}
      defaultValue="A shared space for design reviews, experiments, and team decisions."
    />
  </Field>
</fieldset>
<fieldset className="min-w-0 space-y-4">
  <legend className="mb-4 text-label">Access</legend>
  <Field label="Who can join">
    <RadioGroup defaultValue="invite" name="workspace-access">
      <Radio
        value="invite"
        label="Invite only"
        description="An owner needs to invite each new member."
      />
      <Radio
        value="team"
        label="Anyone on the team"
        description="Teammates can join without an invitation."
      />
    </RadioGroup>
  </Field>
  <Field
    label="Contact email"
    description="Where people can ask for access."
  >
    <Input type="email" placeholder="team@example.com" />
  </Field>
</fieldset>
<fieldset className="min-w-0 space-y-4">
  <legend className="mb-4 text-label">Notifications</legend>
  <Checkbox label="Notify me when someone joins" defaultChecked />
  <Checkbox label="Send a weekly activity summary" />
  <Checkbox
    label="Include project updates in summaries"
    defaultChecked
  />
</fieldset>
<div>
  <h3 className="mb-2 text-label">Advanced</h3>
  <div className="-mx-2">
    <Accordion
      variant="form"
      keepMounted
      items={[
        {
          value: "defaults",
          title: "Project defaults",
          content: (
            <div className="space-y-4">
              <Field label="Default project description">
                <Textarea
                  rows={3}
                  placeholder="A starting point for new projects"
                />
              </Field>
              <Checkbox
                label="Allow members to create projects"
                defaultChecked
              />
            </div>
          ),
        },
      ]}
    />
  </div>
</div>`}
      >
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">General</legend>
          <Field label="Workspace name">
            <Input defaultValue="Design studio" required />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              defaultValue="A shared space for design reviews, experiments, and team decisions."
            />
          </Field>
        </fieldset>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">Access</legend>
          <Field label="Who can join">
            <RadioGroup defaultValue="invite" name="workspace-access">
              <Radio
                value="invite"
                label="Invite only"
                description="An owner needs to invite each new member."
              />
              <Radio
                value="team"
                label="Anyone on the team"
                description="Teammates can join without an invitation."
              />
            </RadioGroup>
          </Field>
          <Field
            label="Contact email"
            description="Where people can ask for access."
          >
            <Input type="email" placeholder="team@example.com" />
          </Field>
        </fieldset>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">Notifications</legend>
          <Checkbox label="Notify me when someone joins" defaultChecked />
          <Checkbox label="Send a weekly activity summary" />
          <Checkbox
            label="Include project updates in summaries"
            defaultChecked
          />
        </fieldset>
        <div>
          <h3 className="mb-2 text-label">Advanced</h3>
          <div className="-mx-2">
            <Accordion
              variant="form"
              keepMounted
              items={[
                {
                  value: "defaults",
                  title: "Project defaults",
                  content: (
                    <div className="space-y-4">
                      <Field label="Default project description">
                        <Textarea
                          rows={3}
                          placeholder="A starting point for new projects"
                        />
                      </Field>
                      <Checkbox
                        label="Allow members to create projects"
                        defaultChecked
                      />
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </Example>
    </div>
  );
}
