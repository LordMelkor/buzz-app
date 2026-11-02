import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";

/** Keep recovery focus until discovery settles, without stealing it back. */
export function ModelDiscoveryRecovery({
  children,
  error,
  loading,
  retry,
  disabled = false,
}: {
  children: ReactNode;
  error?: string | undefined;
  loading: boolean;
  retry(): void;
  disabled?: boolean;
}) {
  const field = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    if (loading || error || !focused) return;
    if (document.activeElement === button.current) {
      field.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    }
    setFocused(false);
  }, [focused, loading, error]);
  return (
    <>
      <div ref={field}>{children}</div>
      {error && <span role="alert">{error}</span>}
      {(error || focused) && (
        <Button
          ref={button}
          loading={loading}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onClick={retry}
        >
          Try again
        </Button>
      )}
    </>
  );
}
