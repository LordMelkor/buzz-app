import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { statusOf, type DecisionsService } from "../features/decisions/service";
import { OwnedContribution } from "../plugins/OwnedContribution";
import { Field } from "../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";

/** What any provider receives. The host says it once, for every provider. */
const DISCLOSURE =
  "Your decisions provider receives the message text that plugins send it, including from private channels.";

/** Chooses the provider that answers decisions on this device and shows the
 * selected provider's own settings. Providers are plugins. One picked before
 * it is ready shows its settings, but the choice is saved only once it is
 * ready, so a working provider keeps answering until then. The choice is
 * hidden only when one provider is registered and already answering when
 * Settings opens. */
export function DecisionsSettings({
  decisions,
  active,
}: {
  decisions: Pick<
    DecisionsService,
    "backend" | "subscribe" | "setBackend" | "providers"
  >;
  active(): boolean;
}) {
  const backend = useSyncExternalStore(
    decisions.subscribe,
    decisions.backend,
    decisions.backend,
  );
  const providers = useSyncExternalStore(
    decisions.subscribe,
    decisions.providers,
    decisions.providers,
  );
  const [picked, setPicked] = useState<string>();
  const pending = providers.find((provider) => provider.key === picked);
  // Re-read on every change: a provider's status is its own.
  const pendingReady = useSyncExternalStore(
    decisions.subscribe,
    () => pending !== undefined && statusOf(pending) === "ready",
    () => false,
  );
  useEffect(() => {
    if (!pending || !pendingReady) return;
    setPicked(undefined);
    decisions.setBackend(pending.key);
  }, [pending, pendingReady, decisions]);
  const selected = pending && pending.key !== backend ? pending : undefined;
  const shown =
    selected ?? providers.find((provider) => provider.key === backend);
  // With no provider answering, even a lone one must be choosable: decisions
  // never move to a provider the user did not choose. Once offered, the choice
  // stays for this visit, so choosing does not remove the focused control.
  const [offered, setOffered] = useState(false);
  const needsChoice = providers.length > 1 || backend === undefined;
  if (needsChoice && !offered) setOffered(true);
  const choosable = needsChoice || (offered && providers.length > 0);
  // A provider can go away while its controls have focus, for example when
  // a sign-out removes Builderlab. The service notifies before React
  // re-renders, so the old controls are still in the page: note whether
  // focus is in this section, then hand it to the selected provider's radio,
  // or the section itself, if the update dropped it.
  const section = useRef<HTMLElement>(null);
  const hadFocus = useRef(false);
  useEffect(
    () =>
      decisions.subscribe(() => {
        hadFocus.current ||= !!section.current?.contains(
          document.activeElement,
        );
      }),
    [decisions],
  );
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    hadFocus.current = false;
    const element = section.current;
    const focused = document.activeElement;
    if (
      !element ||
      (focused && focused !== document.body && focused.isConnected)
    )
      return;
    const radio = element.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"]',
    );
    (radio ?? element).focus({ preventScroll: true });
  });
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="decisions-settings-title"
    >
      <Header
        id="decisions-settings-title"
        title="Decisions API"
        subtitle={DISCLOSURE}
      />
      {providers.length === 0 ? (
        <p role="status" className="mt-4 text-body-sm text-secondary">
          No decision provider is turned on. Turn one on in Settings &gt;
          Plugins.
        </p>
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex flex-col items-start gap-section-gap"
        >
          {choosable && (
            <div className="w-full max-w-md">
              <InlineHeader title="Decisions API Provider" />
              <Field
                label="Decisions API Provider"
                labelVisibility="hidden"
                nativeLabel={false}
              >
                <RadioGroup
                  aria-label="Decisions API Provider"
                  value={shown?.key ?? ""}
                  onValueChange={(value) => {
                    if (!active()) return;
                    const next = providers.find(
                      (provider) => provider.key === value,
                    );
                    if (!next) return;
                    if (statusOf(next) === "ready" || next.key === backend) {
                      setPicked(undefined);
                      decisions.setBackend(next.key);
                    } else setPicked(next.key);
                  }}
                >
                  {providers.map((provider) => (
                    <Radio
                      key={provider.key}
                      value={provider.key}
                      variant="card"
                      label={provider.label}
                      description={provider.description}
                    />
                  ))}
                </RadioGroup>
              </Field>
            </div>
          )}
          {shown && (
            <div className="flex w-full max-w-md flex-col items-start gap-3">
              <InlineHeader title={shown.label} />
              {shown.Settings && (
                // A provider's settings are plugin code: if they fail, only
                // this part does, and Settings > Plugins can turn it off.
                <OwnedContribution
                  entry={shown}
                  registry={{ snapshot: decisions.providers }}
                  fallback={
                    <p role="alert" className="text-body-sm text-secondary">
                      {shown.label} settings are unavailable. You can turn its
                      plugin off in Settings &gt; Plugins.
                    </p>
                  }
                >
                  {(entry, owned) => {
                    const Settings = entry.Settings;
                    return (
                      Settings && (
                        <Settings active={() => active() && owned()} />
                      )
                    );
                  }}
                </OwnedContribution>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
