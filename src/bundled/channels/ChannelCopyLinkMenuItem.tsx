import { LinkIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";

/** The link carries no community; it opens in the recipient's selected one. */
export function ChannelCopyLinkMenuItem({ channelId }: { channelId: string }) {
  const notify = useToastNotification();
  return (
    <MenuItem
      onClick={() =>
        writeClipboardText(
          `buzz://channel/${encodeURIComponent(channelId)}`,
        ).then(
          () => notify("Link copied.", "success"),
          () => notify("Couldn’t copy the link.", "error"),
        )
      }
    >
      <MenuIcon>
        <LinkIcon size={14} />
      </MenuIcon>
      Copy link
    </MenuItem>
  );
}
