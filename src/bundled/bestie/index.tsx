import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { BestieIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type {} from "../builderlab/service";
import { ChannelPreview } from "../inbox/ChannelPreview";
import { ConversationChannel } from "../../features/conversation/Conversation";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ChannelSummary } from "../../features/relay/contracts";
import { bestieInstructions } from "./prompt";
import {
  createRemoteBestie,
  type ModelChoice,
  type RemoteBestie,
} from "./setup";
import type { RemoteAgentModel } from "../builderlab/agents/client";
import { useRelayConnection } from "../../features/relay/react";
import { useSavedAgentState } from "../../features/solo/default-agent";
import type { RelayData } from "../../features/relay/service";
import { PinnedBestie } from "./PinnedBestie";
import { bestieRoute } from "./routes";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "agents",
  "conversation",
  "panels",
];
export const apply: PluginModule["apply"] = (ctx) => {
  let bestie: RemoteBestie | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const source = {
    snapshot: () => bestie,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  // Keep the page available while Builderlab is off or unconfigured. Cordis
  // owns the consumer's lifetime as the hosted type appears or disappears.
  ctx.inject(["builderlab"], (child) => {
    const current = createRemoteBestie(child.builderlab, ctx.agents, ctx.relay);
    bestie = current;
    notify();
    child.effect(() => () => {
      current.dispose();
      bestie = undefined;
      notify();
    });
  });
  ctx.effect(() => () => listeners.clear());
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: (params) => !!bestieRoute(params) },
    component: ({ navigation: pageNavigation }) => {
      const current = useSyncExternalStore(
        source.subscribe,
        source.snapshot,
        source.snapshot,
      );
      return (
        <BestieDestination
          bestie={current}
          relay={ctx.relay}
          navigation={ctx.navigation}
          extensions={ctx.conversation}
          host={ctx}
          pageNavigation={pageNavigation}
        />
      );
    },
  });
};

function BestieStatus({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Bestie"
                icon={<BestieIcon size="1rem" />}
              />
            }
          />
          <Intro>{children}</Intro>
        </div>
      </FullPageSurface>
    </div>
  );
}

function BestieDestination({
  relay,
  ...props
}: {
  bestie?: RemoteBestie | undefined;
  relay: RelayData;
  navigation: Navigation;
  extensions: ConversationExtensions;
  host: ConversationHostServices;
  pageNavigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const saved = useSavedAgentState(connection.session, connection.scope ?? "");
  const established =
    connection.status === "ready" &&
    !!connection.viewer &&
    !!connection.scope?.endsWith(`:${connection.viewer}`);
  if (!established && !saved.agent)
    return (
      <BestieStatus>
        <p className="m-0 text-body-sm text-muted" role="status">
          {connection.status === "connecting"
            ? "Connecting to your Bestie…"
            : (connection.error ??
              "Choose a community to continue with your Bestie.")}
        </p>
        {connection.status === "error" && (
          <Button onClick={relay.retry}>Retry connection</Button>
        )}
      </BestieStatus>
    );
  if (!saved.read || saved.error)
    return (
      <BestieStatus>
        <p
          className="m-0 text-body-sm text-muted"
          role={saved.error ? "alert" : "status"}
        >
          {saved.error ?? "Loading your Bestie…"}
        </p>
        {saved.error && <Button onClick={saved.retry}>Try again</Button>}
      </BestieStatus>
    );
  return saved.agent ? (
    <PinnedBestie
      relay={relay}
      host={props.host}
      extensions={props.extensions}
      navigator={props.navigation}
      navigation={props.pageNavigation}
    />
  ) : (
    <BestiePage {...props} />
  );
}

export function BestiePage({
  bestie,
  navigation,
  extensions,
  host,
}: {
  bestie?: RemoteBestie | undefined;
  navigation: Navigation;
  extensions: ConversationExtensions;
  host: ConversationHostServices;
}) {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Bestie"
                icon={<BestieIcon size="1rem" />}
              />
            }
          />
          {bestie ? (
            <Setup bestie={bestie} extensions={extensions} host={host} />
          ) : (
            <Intro>
              <p className="m-0 text-body-sm text-muted" role="status">
                Bestie runs on Builderlab. Turn on the Builderlab plugin in the
                Buzz desktop app to set it up.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  void navigation.open({
                    version: 1,
                    kind: "settings",
                    section: "plugins",
                  })
                }
              >
                Plugin settings
              </Button>
            </Intro>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

/** Keyboard focus is free to move when nothing holds it, as when the control
 * that had it unmounts, or when it sits inside the setup surface. Focus the
 * owner moved elsewhere is theirs and stays put. */
const focusIsFree = () =>
  typeof document !== "undefined" &&
  (!document.activeElement ||
    document.activeElement === document.body ||
    !!document.activeElement.closest("[data-bestie-intro]"));

function Intro({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6" data-bestie-intro="">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
        <img src="/bestie.png" alt="" className="size-20 object-contain" />
        <h2 className="text-heading">Meet your Bestie</h2>
        {children}
      </div>
    </div>
  );
}

function Setup({
  bestie,
  extensions,
  host,
}: {
  bestie: RemoteBestie;
  extensions: ConversationExtensions;
  host: ConversationHostServices;
}) {
  const state = useSyncExternalStore(
    bestie.subscribe,
    bestie.snapshot,
    bestie.snapshot,
  );
  const { record, connection } = state;
  const [home, setHome] =
    useState<Pick<ChannelSummary, "id" | "name" | "channelType">>();
  const [homeError, setHomeError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  // A setup action the owner started hands focus to the conversation it
  // opens, unless they moved focus elsewhere while it ran.
  const handoff = useRef(false);
  const act = (action: () => unknown) => {
    handoff.current = true;
    void action();
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const complete =
    !!record?.complete &&
    !!record.agent &&
    ["ready", "idle", "error", "busy"].includes(state.status);
  // Show the conversation here only after its roster is still just you and Bestie.
  const checkHome = useCallback(async () => {
    const controller = lifetime.current;
    const agent = record?.agent;
    if (
      !record?.complete ||
      !agent ||
      !connection ||
      !controller ||
      controller.signal.aborted
    )
      return;
    const active = () =>
      !controller.signal.aborted &&
      bestie.snapshot().connection === connection &&
      bestie.snapshot().record === record;
    try {
      const details = await connection.session.channelDetails.load(
        record.channelId,
        controller.signal,
      );
      if (!active()) return;
      const channel = await connection.session.channelWrites.refreshMembership(
        record.channelId,
      );
      if (!active()) return;
      if (
        details.visibility !== "private" ||
        channel.channelType !== "solo" ||
        channel.archived ||
        !channel.members?.includes(record.owner) ||
        !channel.members.includes(agent) ||
        channel.members.some(
          (member) => member !== record.owner && member !== agent,
        )
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      setHomeError("");
      setHome(
        connection.session.channels
          .list()
          .channels.find((row) => row.id === record.channelId) ?? {
          id: record.channelId,
          name: "Bestie",
          channelType: "solo",
        },
      );
    } catch (error) {
      if (!active()) return;
      setHome(undefined);
      setHomeError(
        error instanceof Error
          ? error.message
          : "Could not open Bestie's channel. Try again.",
      );
    }
  }, [bestie, connection, record]);
  useEffect(() => {
    if (complete) void checkHome();
  }, [checkHome, complete]);
  const open = complete && connection && home?.id === record.channelId;
  // Read while the finished action may still hold focus, before it unmounts.
  const focusConversation = !!open && handoff.current && focusIsFree();
  useEffect(() => {
    if (open) handoff.current = false;
  }, [open]);
  // Moving between setup steps unmounts the control that had focus. The setup
  // button stays mounted through busy and error, so it keeps focus from there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each setup step change is the trigger.
  useEffect(() => {
    if (!handoff.current || !focusIsFree()) return;
    document
      .querySelector<HTMLElement>("[data-bestie-intro] [data-bestie-focus]")
      ?.focus();
  }, [state.status]);
  if (open)
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 px-6 py-3">
          <p
            className="m-0 text-body-sm text-muted"
            role={state.status === "error" ? "alert" : "status"}
          >
            {state.status === "error" || state.status === "busy"
              ? state.message
              : state.instructionsChanged
                ? "Bestie's instructions have changed since setup."
                : "If Bestie doesn't reply, ask your Builderlab workspace admin to allow this community to use inference."}
          </p>
          {(state.instructionsChanged || state.status === "busy") && (
            <Button
              size="sm"
              variant="outline"
              loading={state.status === "busy"}
              onClick={() => void bestie.setup()}
            >
              {state.status === "error"
                ? "Retry updating Bestie's instructions"
                : "Update Bestie's instructions"}
            </Button>
          )}
          <details className="w-full text-body-sm text-muted">
            <summary className="cursor-pointer">Bestie's instructions</summary>
            <pre className="m-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
              {bestieInstructions(record.owner, record.channelId)}
            </pre>
          </details>
        </div>
        <ConversationChannel
          session={connection.session}
          scope={connection.session.scope}
          extensions={extensions}
          host={host}
          channel={home}
          active
        >
          <ChannelPreview
            channelName="Bestie"
            label="Bestie conversation"
            autoFocus={focusConversation}
          />
        </ConversationChannel>
      </>
    );
  return (
    <Intro>
      <p
        className="m-0 text-body-sm text-muted"
        role={state.status === "error" ? "alert" : "status"}
      >
        {state.message}
      </p>
      {complete ? (
        <>
          {homeError && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {homeError}
            </p>
          )}
          <Button variant="prominent" onClick={() => act(checkHome)}>
            Open Bestie conversation
          </Button>
        </>
      ) : state.status === "unavailable" ? null : (
        <>
          <p className="m-0 text-body-sm text-muted">
            Setup signs you in to Builderlab, asks which model Bestie runs on,
            creates or reuses your hosted agent named Bestie, replaces its
            instructions, creates a private channel and invites it. If you
            already customized Bestie's instructions, save a copy before
            continuing.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {state.status === "choose-model" ? (
              <ModelChooser
                models={state.models ?? []}
                onChoose={(model) => act(() => bestie.chooseModel(model))}
              />
            ) : state.status === "choose-agent" ? (
              state.candidates?.map((agent) => (
                <Button
                  key={agent.pubkey}
                  variant="outline"
                  onClick={() => act(() => bestie.setup(agent.pubkey))}
                >
                  Use {agent.name} · {agent.pubkey.slice(0, 12)}
                </Button>
              ))
            ) : (
              <>
                <Button
                  variant="prominent"
                  data-bestie-focus=""
                  loading={state.status === "busy"}
                  onClick={() => act(() => bestie.setup())}
                >
                  {state.status === "error"
                    ? "Retry Bestie setup"
                    : "Set up Bestie"}
                </Button>
                {state.status === "error" && state.canCreateNew && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      act(() => bestie.setup(undefined, { createNew: true }))
                    }
                  >
                    Create a new Bestie
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Intro>
  );
}

/** Builderlab runs an agent only on a model and reasoning effort its owner
 * chose from the catalog; nothing is preselected. */
function ModelChooser({
  models,
  onChoose,
}: {
  models: readonly RemoteAgentModel[];
  onChoose: (model: ModelChoice) => void;
}) {
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const model = models.find((choice) => choice.id === modelId);
  const supported =
    !!model?.supportedReasoningEfforts.includes(reasoningEffort);
  const chooser = useRef<HTMLDivElement>(null);
  // The previous step's button unmounted, so the first field takes focus.
  useEffect(() => {
    if (focusIsFree())
      chooser.current?.querySelector<HTMLElement>("[role=combobox]")?.focus();
  }, []);
  return (
    <div ref={chooser} className="grid w-full gap-4 text-left">
      <Select
        label="Model"
        variant="field"
        name="bestie-model"
        required
        value={model ? modelId : ""}
        placeholder="Choose a model"
        groups={[
          {
            label: "Models",
            options: models.map((choice) => ({
              value: choice.id,
              label: choice.displayName,
            })),
          },
        ]}
        onValueChange={(value) => {
          setModelId(value);
          setReasoningEffort("");
        }}
      />
      <Select
        label="Reasoning effort"
        variant="field"
        name="bestie-effort"
        required
        value={supported ? reasoningEffort : ""}
        placeholder="Choose reasoning effort"
        disabled={!model}
        groups={[
          {
            label: "Supported reasoning efforts",
            options: (model?.supportedReasoningEfforts ?? []).map((value) => ({
              value,
              label: value,
            })),
          },
        ]}
        onValueChange={setReasoningEffort}
      />
      <div className="flex justify-center">
        <Button
          variant="prominent"
          disabled={!model || !supported}
          onClick={() => onChoose({ modelId, reasoningEffort })}
        >
          Continue setup
        </Button>
      </div>
    </div>
  );
}
