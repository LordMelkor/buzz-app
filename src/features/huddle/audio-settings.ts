export type AudioDevice = { id: string; label: string };
export type AudioSettingsState = {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  input: string;
  output: string;
  outputSupported: boolean;
  loading: boolean;
  busy: boolean;
  error?: string | undefined;
};

/** Device state belongs to the live audio session, shared by both Huddle views. */
export function createAudioSettings(
  input: (id: string) => Promise<void>,
  output: ((id: string) => Promise<void>) | undefined,
) {
  const media = navigator.mediaDevices;
  let closed = false;
  let revision = 0;
  let state: AudioSettingsState = {
    inputs: [],
    outputs: [],
    input: "",
    output: "",
    outputSupported: !!output,
    loading: true,
    busy: false,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AudioSettingsState>) => {
    if (closed) return;
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const refresh = async () => {
    const version = ++revision;
    update({ loading: true, error: undefined });
    try {
      const devices = await media.enumerateDevices();
      if (closed || revision !== version) return;
      const choices = (kind: MediaDeviceKind, name: string) =>
        devices
          .filter(
            (device) =>
              device.kind === kind &&
              device.deviceId &&
              device.deviceId !== "default",
          )
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label || `${name} ${index + 1}`,
          }));
      update({
        inputs: choices("audioinput", "Microphone"),
        outputs: choices("audiooutput", "Speaker"),
        loading: false,
      });
    } catch {
      if (revision === version)
        update({
          loading: false,
          error: "Couldn’t list audio devices. Try again.",
        });
    }
  };
  media.addEventListener("devicechange", refresh);
  void refresh();
  return {
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh,
    async select(kind: "input" | "output", id: string) {
      if (closed || state.busy) return;
      const change = kind === "input" ? input : output;
      const choices = kind === "input" ? state.inputs : state.outputs;
      if (!change || (id && !choices.some((device) => device.id === id))) {
        update({
          error:
            "That audio device is no longer available. Choose another device.",
        });
        return;
      }
      update({ busy: true, error: undefined });
      try {
        await change(id);
        update({ [kind]: id });
      } catch {
        update({
          error: `Couldn’t switch ${kind === "input" ? "microphone" : "speakers"}. Your previous device is still selected.`,
        });
      } finally {
        update({ busy: false });
      }
    },
    close() {
      closed = true;
      media.removeEventListener("devicechange", refresh);
      listeners.clear();
    },
  };
}
export type HuddleAudioSettings = ReturnType<typeof createAudioSettings>;
