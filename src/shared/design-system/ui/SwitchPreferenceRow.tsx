import { useId, type ComponentProps, type ReactNode } from "react";
import { PreferenceRow } from "./PreferenceRow";
import { Switch } from "./Switch";

export function SwitchPreferenceRow({
  variant = "default",
  icon,
  label,
  description,
  id,
  "aria-label": ariaLabel,
  ...props
}: {
  variant?: "default" | "search";
  icon?: ReactNode;
  label: string;
  description?: string;
  "aria-label"?: string;
} & Omit<ComponentProps<typeof Switch>, "label" | "aria-label">) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <PreferenceRow
      variant={variant}
      icon={icon}
      title={label}
      subtitle={description}
      controlId={controlId}
      accessibleTitle={ariaLabel}
      disabled={props.disabled}
      trailing={(labelProps) => (
        <Switch
          {...props}
          {...labelProps}
          id={controlId}
          aria-label={ariaLabel ?? label}
        />
      )}
    />
  );
}
