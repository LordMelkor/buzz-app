import type { AudioSettingsState } from "../../features/huddle/audio-settings";
import { GearIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Select } from "../../shared/design-system/ui/Select";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";

export function HuddleAudioSettings({
  state,
  compact = false,
  quiet = false,
  refresh,
  select,
}: {
  state: AudioSettingsState | undefined;
  compact?: boolean;
  quiet?: boolean;
  refresh(): void;
  select(kind: "input" | "output", id: string): void;
}) {
  return (
    <PopoverRoot
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            size={compact ? "toolbar" : "large"}
            shape={compact ? "control" : "round"}
            variant={compact || quiet ? "ghost" : "subtle"}
            aria-label="Audio settings"
            title="Audio settings"
            icon={
              <GearIcon
                size={compact ? 16 : 22}
                className={quiet ? "text-secondary" : undefined}
              />
            }
          />
        }
      />
      <PopoverPopup align="start" size="compact">
        <div className="flex flex-col gap-3">
          <PopoverTitle>Audio settings</PopoverTitle>
          {state ? (
            <>
              {(["input", "output"] as const).map((kind) => {
                const devices = kind === "input" ? state.inputs : state.outputs;
                const selected = state[kind];
                const unavailable =
                  selected && !devices.some((device) => device.id === selected);
                return (
                  <Select
                    key={kind}
                    label={kind === "input" ? "Microphone" : "Speakers"}
                    variant="field"
                    value={selected}
                    readOnly={state.busy}
                    disabled={kind === "output" && !state.outputSupported}
                    description={
                      kind === "output" && !state.outputSupported
                        ? "Uses your system’s selected speakers."
                        : undefined
                    }
                    groups={[
                      {
                        label: "",
                        options: [
                          { value: "", label: "System default" },
                          ...devices.map((device) => ({
                            value: device.id,
                            label: device.label,
                          })),
                          ...(unavailable
                            ? [
                                {
                                  value: selected,
                                  label: "Unavailable device",
                                  disabled: true,
                                },
                              ]
                            : []),
                        ],
                      },
                    ]}
                    onValueChange={(id) => select(kind, id)}
                  />
                );
              })}
              {state.busy && (
                <p role="status" className="text-caption text-secondary">
                  Switching device…
                </p>
              )}
              {state.error && (
                <p role="alert" className="text-caption text-secondary">
                  {state.error}
                </p>
              )}
            </>
          ) : (
            <p role="status" className="text-body-sm text-secondary">
              Audio settings aren’t available for this call.
            </p>
          )}
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}
