import { ExamplePreview } from "./ExamplePreview";
import { Section } from "./primitives";
import { NavigationItem } from "../../../../src/shared/design-system/ui/NavigationItem";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { ChoiceRow } from "../../../../src/shared/design-system/ui/ChoiceRow";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import {
  ArchiveIcon,
  BellIcon,
  CheckIcon,
  DotsThreeIcon,
  GearIcon,
  HashIcon,
  RobotIcon,
} from "../../../../src/shared/design-system/icons/index";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuLinkItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuIcon,
  MenuTrailing,
  MenuNote,
} from "../../../../src/shared/design-system/ui/Menu";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from "../../../../src/shared/design-system/ui/Popover";
import avatarUrl from "../assets/avatar.png";

function Example({
  title,
  description,
  code,
  children,
}: {
  title: string;
  description: string;
  code: string;
  children: ReactNode;
}) {
  return (
    <Section title={title} description={description}>
      <ExamplePreview label={title} code={code} className="justify-center">
        {children}
      </ExamplePreview>
    </Section>
  );
}

function Related() {
  return (
    <p className="text-body text-secondary">
      <Link to="/design/components/$slug" params={{ slug: "menu" }}>
        Menu
      </Link>{" "}
      for actions and choices.{" "}
      <Link to="/design/components/$slug" params={{ slug: "popover" }}>
        Popover
      </Link>{" "}
      for supporting content and short forms.{" "}
      <Link to="/design/components/$slug" params={{ slug: "choice-row" }}>
        ChoiceRow
      </Link>{" "}
      for row content. Use Select or Combobox for a form value.
    </p>
  );
}

function ActionMenu() {
  const [sort, setSort] = useState("recent");
  const [notifications, setNotifications] = useState(true);
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label="More actions"
            icon={<DotsThreeIcon size={16} aria-hidden="true" />}
          />
        }
      />
      <MenuPopup>
        <MenuItem>
          <MenuIcon>
            <CheckIcon size={16} />
          </MenuIcon>
          Mark all as read
        </MenuItem>
        <MenuCheckboxItem
          checked={notifications}
          onCheckedChange={setNotifications}
          closeOnClick={false}
        >
          <MenuIcon>
            <BellIcon size={16} />
          </MenuIcon>
          Notifications
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuSubmenu>
          <MenuSubmenuTrigger>Sort</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuRadioGroup value={sort} onValueChange={setSort}>
              <MenuRadioItem value="recent">Recent</MenuRadioItem>
              <MenuRadioItem value="alpha">A–Z</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem disabled>
              Disabled action<MenuTrailing>⌘D</MenuTrailing>
            </MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </MenuRoot>
  );
}

function AgentChoices() {
  const [agent, setAgent] = useState("studio");
  return (
    <MenuRoot>
      <MenuTrigger render={<Button>Choose an agent</Button>} />
      <MenuPopup aria-label="Choose an agent">
        <MenuGroup>
          <MenuGroupLabel>Agents</MenuGroupLabel>
          <MenuRadioGroup value={agent} onValueChange={setAgent}>
            <MenuRadioItem value="none" closeOnClick>
              <ChoiceRow
                leading={<RobotIcon size={24} />}
                label="No agent selected"
              />
            </MenuRadioItem>
            <MenuRadioItem value="studio" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Studio"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Studio assistant"
                description="Already in this session"
              />
            </MenuRadioItem>
            <MenuRadioItem value="research" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Research"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Research and accessibility assistant"
                description="Adds to session and channel"
              />
            </MenuRadioItem>
            <MenuRadioItem value="offline" disabled>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Archive"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Archive assistant"
                description="Unavailable on this connection"
              />
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuNote>
          Adding an agent gives it access to this session’s history.
        </MenuNote>
      </MenuPopup>
    </MenuRoot>
  );
}

export function MenuSpecimen() {
  const [lastAction, setLastAction] = useState("No action selected");
  const [dialog, setDialog] = useState(false);
  const [workspace, setWorkspace] = useState("1");
  return (
    <div className="component-specimen-stack">
      <Example
        title="Highlight selection"
        description="Single-choice views use a persistent highlight, while checkbox choices keep checks."
        code={
          '<MenuRadioItem value="1" selection="highlight">All</MenuRadioItem>'
        }
      >
        <MenuRoot>
          <MenuTrigger render={<Button>Choose view</Button>} />
          <MenuPopup>
            <MenuGroup>
              <MenuGroupLabel emphasis="quiet">Show</MenuGroupLabel>
              <MenuRadioGroup value={workspace} onValueChange={setWorkspace}>
                <MenuRadioItem value="1" selection="highlight">
                  All
                </MenuRadioItem>
                <MenuRadioItem value="2" selection="highlight">
                  Threads
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </MenuRoot>
      </Example>
      <Related />
      <Example
        title="Actions"
        description="Grouped actions, links, unavailable items, and a destructive action. These examples only update local preview state."
        code={`<MenuRoot>
  <MenuTrigger render={<Button>Open menu</Button>} />
  <MenuPopup>
    <MenuGroup>
      <MenuGroupLabel>Workspace</MenuGroupLabel>
      <MenuItem onClick={() => setLastAction("Copied workspace link")}>
        <ChoiceRow
          label="Copy link"
          description="Share this workspace with your team"
        />
      </MenuItem>
      <MenuLinkItem href="#/design/components/popover">
        About popovers
      </MenuLinkItem>
      <MenuItem disabled>Transfer ownership</MenuItem>
    </MenuGroup>
    <MenuSeparator />
    <MenuItem
      tone="danger"
      onClick={() => setLastAction("Archive selected (preview only)")}
    >
      <MenuIcon><ArchiveIcon size={16} /></MenuIcon>
      Archive workspace
    </MenuItem>
  </MenuPopup>
</MenuRoot>`}
      >
        <MenuRoot>
          <MenuTrigger render={<Button>Open menu</Button>} />
          <MenuPopup>
            <MenuGroup>
              <MenuGroupLabel>Workspace</MenuGroupLabel>
              <MenuItem onClick={() => setLastAction("Copied workspace link")}>
                <ChoiceRow
                  label="Copy link"
                  description="Share this workspace with your team"
                />
              </MenuItem>
              <MenuLinkItem href="#/design/components/popover">
                About popovers
              </MenuLinkItem>
              <MenuItem disabled>Transfer ownership</MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem
              tone="danger"
              onClick={() => setLastAction("Archive selected (preview only)")}
            >
              <MenuIcon>
                <ArchiveIcon size={16} />
              </MenuIcon>
              Archive workspace
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </Example>
      <p role="status" className="text-body-sm text-tertiary">
        {lastAction}
      </p>
      <Example
        title="Choices and nested menus"
        description="A check marks a persistent choice. Highlight follows navigation; a submenu keeps its parent highlighted while open. Disabled rows mute their trailing text and indicators with the label."
        code={`function ActionMenu() {
  const [sort, setSort] = useState("recent");
  const [notifications, setNotifications] = useState(true);
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label="More actions"
            icon={<DotsThreeIcon size={16} aria-hidden="true" />}
          />
        }
      />
      <MenuPopup>
        <MenuItem>
          <MenuIcon>
            <CheckIcon size={16} />
          </MenuIcon>
          Mark all as read
        </MenuItem>
        <MenuCheckboxItem
          checked={notifications}
          onCheckedChange={setNotifications}
          closeOnClick={false}
        >
          <MenuIcon>
            <BellIcon size={16} />
          </MenuIcon>
          Notifications
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuSubmenu>
          <MenuSubmenuTrigger>Sort</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuRadioGroup value={sort} onValueChange={setSort}>
              <MenuRadioItem value="recent">Recent</MenuRadioItem>
              <MenuRadioItem value="alpha">A–Z</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem disabled>
              Disabled action<MenuTrailing>⌘D</MenuTrailing>
            </MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </MenuRoot>
  );
}`}
      >
        <ActionMenu />
      </Example>
      <Example
        title="Rich choices"
        description="Avatars, wrapping labels, and supporting context share one row. The selection mark stays at the trailing edge."
        code={`function AgentChoices() {
  const [agent, setAgent] = useState("studio");
  return (
    <MenuRoot>
      <MenuTrigger render={<Button>Choose an agent</Button>} />
      <MenuPopup aria-label="Choose an agent">
        <MenuGroup>
          <MenuGroupLabel>Agents</MenuGroupLabel>
          <MenuRadioGroup value={agent} onValueChange={setAgent}>
            <MenuRadioItem value="none" closeOnClick>
              <ChoiceRow
                leading={<RobotIcon size={24} />}
                label="No agent selected"
              />
            </MenuRadioItem>
            <MenuRadioItem value="studio" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Studio"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Studio assistant"
                description="Already in this session"
              />
            </MenuRadioItem>
            <MenuRadioItem value="research" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Research"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Research and accessibility assistant"
                description="Adds to session and channel"
              />
            </MenuRadioItem>
            <MenuRadioItem value="offline" disabled>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Archive"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Archive assistant"
                description="Unavailable on this connection"
              />
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuNote>
          Adding an agent gives it access to this session’s history.
        </MenuNote>
      </MenuPopup>
    </MenuRoot>
  );
}`}
      >
        <AgentChoices />
      </Example>
      <Example
        title="Long lists"
        description="The menu scrolls within the available space. Arrow keys and typeahead move through the list without scrolling the page."
        code={`<MenuRoot>
  <MenuTrigger render={<Button>Choose workspace</Button>} />
  <MenuPopup aria-label="Workspaces">
    <MenuRadioGroup value={workspace} onValueChange={setWorkspace}>
      {Array.from({ length: 24 }, (_, i) => String(i + 1)).map(
        (workspaceId) => (
          <MenuRadioItem
            key={workspaceId}
            value={workspaceId}
            closeOnClick
          >
            <ChoiceRow
              leading={<HashIcon size={16} />}
              label={\`Workspace \${workspaceId}\`}
            />
          </MenuRadioItem>
        ),
      )}
    </MenuRadioGroup>
  </MenuPopup>
</MenuRoot>`}
      >
        <MenuRoot>
          <MenuTrigger render={<Button>Choose workspace</Button>} />
          <MenuPopup aria-label="Workspaces">
            <MenuRadioGroup value={workspace} onValueChange={setWorkspace}>
              {Array.from({ length: 24 }, (_, i) => String(i + 1)).map(
                (workspaceId) => (
                  <MenuRadioItem
                    key={workspaceId}
                    value={workspaceId}
                    closeOnClick
                  >
                    <ChoiceRow
                      leading={<HashIcon size={16} />}
                      label={`Workspace ${workspaceId}`}
                    />
                  </MenuRadioItem>
                ),
              )}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuRoot>
      </Example>
      <Example
        title="Context menu"
        description="Right-click, or focus the trigger and use Shift+F10. Context actions appear immediately, without entrance movement or blur, and retain a short fade on dismissal."
        code={`<ContextMenuRoot>
  <ContextMenuTrigger render={<Button>Context actions</Button>} />
  <MenuPopup>
    <MenuItem onClick={() => setLastAction("Copied context link")}>
      Copy link
    </MenuItem>
    <MenuItem disabled>Unavailable action</MenuItem>
  </MenuPopup>
</ContextMenuRoot>`}
      >
        <ContextMenuRoot>
          <ContextMenuTrigger render={<Button>Context actions</Button>} />
          <MenuPopup>
            <MenuItem onClick={() => setLastAction("Copied context link")}>
              Copy link
            </MenuItem>
            <MenuItem disabled>Unavailable action</MenuItem>
          </MenuPopup>
        </ContextMenuRoot>
      </Example>
      <Example
        title="Inside a dialog"
        description="The menu layers over the dialog. Escape closes the menu first and returns focus to its trigger."
        code={`<Button onClick={() => setDialog(true)}>Open menu dialog</Button>
<Dialog open={dialog} onOpenChange={setDialog} title="Menu composition">
  <ActionMenu />
</Dialog>

function ActionMenu() {
  const [sort, setSort] = useState("recent");
  const [notifications, setNotifications] = useState(true);
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <IconButton
            aria-label="More actions"
            icon={<DotsThreeIcon size={16} aria-hidden="true" />}
          />
        }
      />
      <MenuPopup>
        <MenuItem>
          <MenuIcon>
            <CheckIcon size={16} />
          </MenuIcon>
          Mark all as read
        </MenuItem>
        <MenuCheckboxItem
          checked={notifications}
          onCheckedChange={setNotifications}
          closeOnClick={false}
        >
          <MenuIcon>
            <BellIcon size={16} />
          </MenuIcon>
          Notifications
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuSubmenu>
          <MenuSubmenuTrigger>Sort</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuRadioGroup value={sort} onValueChange={setSort}>
              <MenuRadioItem value="recent">Recent</MenuRadioItem>
              <MenuRadioItem value="alpha">A–Z</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem disabled>
              Disabled action<MenuTrailing>⌘D</MenuTrailing>
            </MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </MenuRoot>
  );
}`}
      >
        <Button onClick={() => setDialog(true)}>Open menu dialog</Button>
        <Dialog open={dialog} onOpenChange={setDialog} title="Menu composition">
          <ActionMenu />
        </Dialog>
      </Example>
      <p className="text-body text-secondary">
        Implementation: MenuRoot → MenuTrigger + MenuPopup. Put group labels
        inside MenuGroup. Use MenuRadioItem for one choice, MenuCheckboxItem for
        independent choices, and tone="danger" for destructive actions. Keep
        forms in a Popover instead of a Menu.
      </p>
    </div>
  );
}

export function PopoverSpecimen() {
  const [action, setAction] = useState("");
  const [name, setName] = useState("Design studio");
  const [draft, setDraft] = useState(name);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <div className="component-specimen-stack">
      <Example
        title="Supporting details"
        description="A small anchored surface for information that would interrupt the main layout."
        code={`<PopoverRoot>
  <PopoverTrigger render={<Button>Open popover</Button>} />
  <PopoverPopup>
    <PopoverTitle>Workspace access</PopoverTitle>
    <PopoverDescription>
      Only people invited to this workspace can read its conversations.
    </PopoverDescription>
  </PopoverPopup>
</PopoverRoot>`}
      >
        <PopoverRoot>
          <PopoverTrigger render={<Button>Open popover</Button>} />
          <PopoverPopup>
            <PopoverTitle>Workspace access</PopoverTitle>
            <PopoverDescription>
              Only people invited to this workspace can read its conversations.
            </PopoverDescription>
          </PopoverPopup>
        </PopoverRoot>
      </Example>
      <Example
        title="Small action surfaces"
        description="Open either example and hover or use the keyboard. Compare both themes with the page theme control. Settings and New session only update this preview."
        code={`<div className="flex flex-wrap gap-4">
  <PopoverRoot>
    <PopoverTrigger render={<Button>Account actions</Button>} />
    <PopoverPopup
      size="compact"
      padding="list"
      aria-label="Your account"
    >
      <nav aria-label="Your account">
        <p className="m-0 truncate px-3 py-2 text-label-sm">
          Alex Morgan
        </p>
        <PopoverClose
          render={
            <NavigationItem
              label="Settings"
              icon={<GearIcon size={17} aria-hidden="true" />}
              onClick={() => setAction("Settings selected.")}
            />
          }
        />
      </nav>
    </PopoverPopup>
  </PopoverRoot>
  <MenuRoot>
    <MenuTrigger render={<Button>Channel actions</Button>} />
    <MenuPopup size="compact" aria-label="Channel actions">
      <MenuItem onClick={() => setAction("New session selected.")}>
        New session
      </MenuItem>
    </MenuPopup>
  </MenuRoot>
</div>`}
      >
        <div className="flex flex-wrap gap-4">
          <PopoverRoot>
            <PopoverTrigger render={<Button>Account actions</Button>} />
            <PopoverPopup
              size="compact"
              padding="list"
              aria-label="Your account"
            >
              <nav aria-label="Your account">
                <p className="m-0 truncate px-3 py-2 text-label-sm">
                  Alex Morgan
                </p>
                <PopoverClose
                  render={
                    <NavigationItem
                      label="Settings"
                      icon={<GearIcon size={17} aria-hidden="true" />}
                      onClick={() => setAction("Settings selected.")}
                    />
                  }
                />
              </nav>
            </PopoverPopup>
          </PopoverRoot>
          <MenuRoot>
            <MenuTrigger render={<Button>Channel actions</Button>} />
            <MenuPopup size="compact" aria-label="Channel actions">
              <MenuItem onClick={() => setAction("New session selected.")}>
                New session
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        </div>
      </Example>
      {action && (
        <p role="status" className="text-body-sm text-tertiary">
          {action}
        </p>
      )}
      <Example
        title="A quick edit"
        description="A short form stays near its trigger. Save updates this preview; Cancel and Escape leave the saved value unchanged."
        code={`<PopoverRoot
  open={open}
  onOpenChange={(next) => {
    setOpen(next);
    if (next) setDraft(name);
  }}
>
  <PopoverTrigger render={<Button>Edit workspace name</Button>} />
  <PopoverPopup>
    <PopoverTitle>Edit workspace</PopoverTitle>
    <PopoverDescription>
      Choose a name your team will recognize.
    </PopoverDescription>
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) {
          setName(draft.trim());
          setOpen(false);
        }
      }}
    >
      <Field label="Workspace name">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          required
        />
      </Field>
      <div className="flex justify-end gap-2">
        <PopoverClose render={<Button>Cancel</Button>} />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  </PopoverPopup>
</PopoverRoot>`}
      >
        <PopoverRoot
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) setDraft(name);
          }}
        >
          <PopoverTrigger render={<Button>Edit workspace name</Button>} />
          <PopoverPopup>
            <PopoverTitle>Edit workspace</PopoverTitle>
            <PopoverDescription>
              Choose a name your team will recognize.
            </PopoverDescription>
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) {
                  setName(draft.trim());
                  setOpen(false);
                }
              }}
            >
              <Field label="Workspace name">
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  required
                />
              </Field>
              <div className="flex justify-end gap-2">
                <PopoverClose render={<Button>Cancel</Button>} />
                <Button type="submit" variant="primary">
                  Save
                </Button>
              </div>
            </form>
          </PopoverPopup>
        </PopoverRoot>
      </Example>
      <p role="status" className="text-body-sm text-tertiary">
        Workspace: {name}
      </p>
      <Example
        title="Activity preview"
        description="Hover or click for a richer list. Moving into the popup keeps it open; each row remains a single action."
        code={`<PopoverRoot>
  <PopoverTrigger
    openOnHover="preview"
    render={<Button>Recent activity</Button>}
  />
  <PopoverPopup aria-label="Recent activity" padding="list" size="wide">
    <PopoverClose
      render={
        <NavigationItem
          label={
            <ChoiceRow
              label="Alex Morgan"
              description="Shared new workspace designs"
              trailing="2m"
            />
          }
          icon={
            <Avatar
              alt=""
              fallback="Alex"
              src={avatarUrl}
              size="small"
            />
          }
        />
      }
    />
    <PopoverClose
      render={
        <NavigationItem
          label={
            <ChoiceRow
              label="Studio assistant"
              description="Reviewed the latest prototype"
              trailing="5m"
            />
          }
          icon={
            <Avatar
              alt=""
              fallback="Studio"
              size="small"
              shape="squircle"
            />
          }
        />
      }
    />
  </PopoverPopup>
</PopoverRoot>`}
      >
        <PopoverRoot>
          <PopoverTrigger
            openOnHover="preview"
            render={<Button>Recent activity</Button>}
          />
          <PopoverPopup aria-label="Recent activity" padding="list" size="wide">
            <PopoverClose
              render={
                <NavigationItem
                  label={
                    <ChoiceRow
                      label="Alex Morgan"
                      description="Shared new workspace designs"
                      trailing="2m"
                    />
                  }
                  icon={
                    <Avatar
                      alt=""
                      fallback="Alex"
                      src={avatarUrl}
                      size="small"
                    />
                  }
                />
              }
            />
            <PopoverClose
              render={
                <NavigationItem
                  label={
                    <ChoiceRow
                      label="Studio assistant"
                      description="Reviewed the latest prototype"
                      trailing="5m"
                    />
                  }
                  icon={
                    <Avatar
                      alt=""
                      fallback="Studio"
                      size="small"
                      shape="squircle"
                    />
                  }
                />
              }
            />
          </PopoverPopup>
        </PopoverRoot>
      </Example>
      <Example
        title="Placement"
        description="Placement follows the trigger and adjusts at viewport edges. Try these near the edge of a narrow window."
        code={`<div className="flex flex-wrap justify-center gap-2">
  {(["top", "right", "bottom", "left"] as const).map((side) => (
    <PopoverRoot key={side}>
      <PopoverTrigger render={<Button>{side}</Button>} />
      <PopoverPopup side={side}>
        <PopoverTitle>Anchored {side}</PopoverTitle>
        <PopoverDescription>
          The popup stays within the available viewport.
        </PopoverDescription>
      </PopoverPopup>
    </PopoverRoot>
  ))}
</div>`}
      >
        <div className="flex flex-wrap justify-center gap-2">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <PopoverRoot key={side}>
              <PopoverTrigger render={<Button>{side}</Button>} />
              <PopoverPopup side={side}>
                <PopoverTitle>Anchored {side}</PopoverTitle>
                <PopoverDescription>
                  The popup stays within the available viewport.
                </PopoverDescription>
              </PopoverPopup>
            </PopoverRoot>
          ))}
        </div>
      </Example>
      <Example
        title="Inside a dialog"
        description="Form controls inside the popover stay interactive. Closing the popup restores focus without closing the dialog."
        code={`<Button onClick={() => setDialog(true)}>Open popover dialog</Button>
<Dialog
  title="Workspace details"
  open={dialog}
  onOpenChange={setDialog}
>
  <PopoverRoot>
    <PopoverTrigger render={<Button>View access details</Button>} />
    <PopoverPopup>
      <PopoverTitle>Invite only</PopoverTitle>
      <PopoverDescription>
        Workspace owners manage invitations.
      </PopoverDescription>
      <div className="mt-4">
        <PopoverClose render={<Button>Done</Button>} />
      </div>
    </PopoverPopup>
  </PopoverRoot>
</Dialog>`}
      >
        <Button onClick={() => setDialog(true)}>Open popover dialog</Button>
        <Dialog
          title="Workspace details"
          open={dialog}
          onOpenChange={setDialog}
        >
          <PopoverRoot>
            <PopoverTrigger render={<Button>View access details</Button>} />
            <PopoverPopup>
              <PopoverTitle>Invite only</PopoverTitle>
              <PopoverDescription>
                Workspace owners manage invitations.
              </PopoverDescription>
              <div className="mt-4">
                <PopoverClose render={<Button>Done</Button>} />
              </div>
            </PopoverPopup>
          </PopoverRoot>
        </Dialog>
      </Example>
      <p className="text-body text-secondary">
        Implementation: PopoverRoot → PopoverTrigger + PopoverPopup. Label the
        popup with PopoverTitle or aria-label. Use PopoverDescription for
        supporting copy and PopoverClose for a close action. Default content
        padding is 16px; padding="list" gives rows their own spacing, and
        padding="none" lets embedded pickers own their internal spacing. Use
        size="wide" for richer content. Feature code owns saving, loading, and
        errors.
      </p>
      <Related />
      <Section title="Choose the surface by its content">
        <p className="text-body text-secondary">
          Small action menus use 8px outer corners and a 4px inset. Row corners
          subtract the inset and 1px border, giving 3px. Their quieter hover
          fill uses Buzz’s subtle-hover color, with immediate pointer and
          keyboard feedback. The account menu and a short channel action list
          use this treatment.
        </p>
        <p className="text-body text-secondary">
          Content popovers, larger action or choice menus, forms, activity
          previews, and emoji/mention pickers use 16px container corners and
          their existing spacing. A narrow viewport does not turn a content
          popover into a small action menu. Both treatments share the same
          surface, border, shadow, and opening motion.
        </p>
        <p className="text-body text-secondary">
          Opt in with size="compact" on MenuPopup. For an account-style
          PopoverPopup, use size="compact" with padding="list". Default and wide
          surfaces retain the larger corners. Use Menu for arrow-key action
          lists; Popover retains normal Tab navigation for interactive content.
        </p>
      </Section>
    </div>
  );
}

export function ChoiceRowSpecimen() {
  return (
    <div className="component-specimen-stack">
      <Related />
      <Example
        title="Label and description"
        description="Supporting copy wraps beneath the label. Long content stays readable rather than pushing the trailing detail outside the row."
        code={`<ChoiceRow
  label="Design workspace"
  description="Share feedback, prototypes, and decisions with the whole team."
  trailing="Private"
/>`}
      >
        <ChoiceRow
          label="Design workspace"
          description="Share feedback, prototypes, and decisions with the whole team."
          trailing="Private"
        />
      </Example>
      <Example
        title="Identity and context"
        description="Use the shared small avatar: circles for people and squircles for agents."
        code={`<div className="grid w-full gap-6">
  <ChoiceRow
    leading={
      <Avatar alt="" fallback="Alex" src={avatarUrl} size="small" />
    }
    label="Alex Morgan"
    description="Workspace owner"
  />
  <ChoiceRow
    leading={
      <Avatar alt="" fallback="Studio" size="small" shape="squircle" />
    }
    label="Studio assistant"
    description="Adds to session and channel"
  />
</div>`}
      >
        <div className="grid w-full gap-6">
          <ChoiceRow
            leading={
              <Avatar alt="" fallback="Alex" src={avatarUrl} size="small" />
            }
            label="Alex Morgan"
            description="Workspace owner"
          />
          <ChoiceRow
            leading={
              <Avatar alt="" fallback="Studio" size="small" shape="squircle" />
            }
            label="Studio assistant"
            description="Adds to session and channel"
          />
        </div>
      </Example>
      <Example
        title="Inside a choice menu"
        description="The row only arranges content. Its parent owns selected, highlighted, disabled, and keyboard states."
        code={`function AgentChoices() {
  const [agent, setAgent] = useState("studio");
  return (
    <MenuRoot>
      <MenuTrigger render={<Button>Choose an agent</Button>} />
      <MenuPopup aria-label="Choose an agent">
        <MenuGroup>
          <MenuGroupLabel>Agents</MenuGroupLabel>
          <MenuRadioGroup value={agent} onValueChange={setAgent}>
            <MenuRadioItem value="none" closeOnClick>
              <ChoiceRow
                leading={<RobotIcon size={24} />}
                label="No agent selected"
              />
            </MenuRadioItem>
            <MenuRadioItem value="studio" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Studio"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Studio assistant"
                description="Already in this session"
              />
            </MenuRadioItem>
            <MenuRadioItem value="research" closeOnClick>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Research"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Research and accessibility assistant"
                description="Adds to session and channel"
              />
            </MenuRadioItem>
            <MenuRadioItem value="offline" disabled>
              <ChoiceRow
                leading={
                  <Avatar
                    alt=""
                    fallback="Archive"
                    size="small"
                    shape="squircle"
                  />
                }
                label="Archive assistant"
                description="Unavailable on this connection"
              />
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuNote>
          Adding an agent gives it access to this session’s history.
        </MenuNote>
      </MenuPopup>
    </MenuRoot>
  );
}`}
      >
        <AgentChoices />
      </Example>
      <p className="text-body text-secondary">
        ChoiceRow accepts label, description, leading, and trailing content.
        Keep slots non-interactive so the containing menu item remains one
        action. It does not add its own padding, hover state, tab stop, or click
        handler.
      </p>
    </div>
  );
}
