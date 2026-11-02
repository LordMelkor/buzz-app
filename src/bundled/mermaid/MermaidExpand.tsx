import { useRef, useState } from "react";
import { ArrowsOutIcon, CopyIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { MermaidDiagram } from "./MermaidDiagram";
import { writeClipboardText } from "../../shared/clipboard";

/** Opens a complex diagram at full size, with its source a click away. */
export function MermaidExpand({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const notify = useToastNotification();
  const expand = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        hint="familiar"
        ref={expand}
        aria-label="Expand diagram"
        title="Expand diagram"
        icon={<ArrowsOutIcon />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Mermaid diagram"
        size="expanded"
        closeLabel="Close diagram"
        finalFocus={expand}
        leadingActions={
          <Button
            disabled={copying}
            onClick={() => {
              setCopying(true);
              void Promise.resolve()
                .then(() => writeClipboardText(code))
                .then(
                  () => notify("Copied code to clipboard", "success"),
                  () => notify("Failed to copy code", "error"),
                )
                .finally(() => setCopying(false));
            }}
          >
            <CopyIcon size={16} aria-hidden="true" />
            Copy code
          </Button>
        }
      >
        <MermaidDiagram code={code} expanded />
      </Dialog>
    </>
  );
}
