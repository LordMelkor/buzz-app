import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "../icons/index";
import { useId, type ComponentProps, type ReactNode } from "react";

export function Checkbox({
  label,
  id,
  indeterminate,
  size = "md",
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox.Root>, "className" | "children"> & {
  label: ReactNode;
  size?: "sm" | "md";
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="buzz-choice" data-size={size} htmlFor={controlId}>
      <BaseCheckbox.Root
        {...props}
        id={controlId}
        indeterminate={indeterminate}
        data-buzz-ui=""
        className="buzz-checkbox"
        data-size={size}
      >
        <BaseCheckbox.Indicator>
          {indeterminate ? (
            <MinusIcon size={size === "sm" ? 12 : 14} aria-hidden="true" />
          ) : (
            <CheckIcon size={size === "sm" ? 12 : 14} aria-hidden="true" />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="buzz-choice-label">{label}</span>
    </label>
  );
}
