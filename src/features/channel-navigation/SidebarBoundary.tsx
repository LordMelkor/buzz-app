import { Component, type ComponentProps, type ReactNode } from "react";
import { SidebarFrame } from "./SidebarFrame";
import { SidebarList } from "./SidebarList";
import { Button } from "../../shared/design-system/ui/Button";

export class SidebarBoundary extends Component<
  Pick<ComponentProps<typeof SidebarFrame>, "header" | "panelId"> & {
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="shell-sidebar-default">
        <SidebarFrame
          label="Sidebar"
          header={this.props.header}
          panelId={this.props.panelId}
        >
          <SidebarList>
            <p role="alert">Conversations couldn’t open.</p>
            <Button onClick={() => this.setState({ failed: false })}>
              Retry sidebar
            </Button>
          </SidebarList>
        </SidebarFrame>
      </div>
    ) : (
      this.props.children
    );
  }
}
