import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReactElement, ReactNode } from "react";
import type { OpenTarget } from "../navigation/targets";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";

export type SidebarSectionRow = Readonly<{
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string;
  count?: number;
  status?: string;
}>;

export type SidebarSectionAction = Readonly<{
  id: string;
  label: string;
  icon: ReactElement;
  onSelect: () => void | Promise<void>;
}>;

export type SidebarSectionContribution = Readonly<{
  version: 1;
  id: string;
  title: string;
  icon: ReactNode;
  rows: Readonly<{
    snapshot: () => readonly SidebarSectionRow[];
    subscribe: (listener: () => void) => () => void;
  }>;
  select: (row: SidebarSectionRow) => OpenTarget;
  actions?: readonly SidebarSectionAction[];
}>;

export type RegisteredSidebarSection = Contribution<SidebarSectionContribution>;
export type SidebarSections = Readonly<{
  version: 1;
  snapshot: () => readonly RegisteredSidebarSection[];
  subscribe: (listener: () => void) => () => void;
  register: (section: SidebarSectionContribution) => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("sidebarSections")` for old-host compatibility. */
    sidebarSections?: SidebarSections;
  }
}

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;

export class SidebarSectionsService extends Service implements SidebarSections {
  private readonly contributions;
  readonly version = 1 as const;

  constructor(ctx: Context) {
    super(ctx, "sidebarSections");
    this.contributions = createContributions<SidebarSectionContribution>(ctx);
  }

  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);

  register(section: SidebarSectionContribution) {
    if (section?.version !== 1) {
      console.warn("Ignoring unsupported sidebar section contribution version");
      return;
    }
    if (
      typeof section.id !== "string" ||
      !idPattern.test(section.id) ||
      typeof section.title !== "string" ||
      !section.title.trim() ||
      section.icon == null ||
      !section.rows ||
      typeof section.rows.snapshot !== "function" ||
      typeof section.rows.subscribe !== "function" ||
      typeof section.select !== "function" ||
      (section.actions !== undefined &&
        (!Array.isArray(section.actions) ||
          section.actions.some(
            (action) =>
              !action ||
              typeof action.id !== "string" ||
              !idPattern.test(action.id) ||
              typeof action.label !== "string" ||
              !action.label.trim() ||
              action.icon == null ||
              typeof action.onSelect !== "function",
          )))
    )
      throw new Error(
        "A sidebar section needs an id, title, rows, and select action",
      );
    this.contributions.register(this.ctx, section);
  }
}
