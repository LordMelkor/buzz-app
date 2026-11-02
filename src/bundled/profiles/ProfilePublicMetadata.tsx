import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { writeClipboardText } from "../../shared/clipboard";

export function ProfilePublicMetadata({
  nip05,
}: {
  nip05: string | undefined;
}) {
  return nip05 ? (
    <ProfileCopyField key={`nip05:${nip05}`} label="NIP-05" value={nip05} />
  ) : null;
}

function ProfileCopyField({
  label,
  value,
  display = value,
}: {
  label: string;
  value: string;
  display?: string;
}) {
  const notify = useToastNotification();
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <SettingsGroup>
      <PreferenceRow
        title={label}
        subtitle={<span className="break-all">{display}</span>}
        trailing={
          <Button
            size="compact"
            variant="ghost"
            aria-label={`Copy ${label}: ${display}`}
            title={`Copy ${label}`}
            onClick={() => {
              const current = ++generation.current;
              setCopied(false);
              void Promise.resolve()
                .then(() => writeClipboardText(value))
                .then(
                  () => {
                    if (current !== generation.current) return;
                    setCopied(true);
                    notify(`Copied ${label.toLowerCase()}`, "success");
                  },
                  () => {
                    if (current === generation.current)
                      notify(`Couldn't copy ${label.toLowerCase()}.`, "error");
                  },
                );
            }}
          >
            {copied ? (
              <CheckIcon size={16} aria-hidden="true" />
            ) : (
              <CopyIcon size={16} aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      />
    </SettingsGroup>
  );
}
