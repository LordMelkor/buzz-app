import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";

export type FieldProps = Omit<
  ComponentProps<typeof BaseField.Root>,
  "className"
> & {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  nativeLabel?: boolean;
  /** Explicit target for controls whose Base UI root lives outside this Field. */
  controlId?: string;
  labelVisibility?: "visible" | "hidden";
  /** Marks a field that can be left empty when its form has a required field. */
  optional?: boolean;
};

/** Base UI connects the label, description, error and contained control. */
export function Field({
  label,
  description,
  error,
  children,
  invalid,
  labelVisibility = "visible",
  optional = false,
  nativeLabel = true,
  controlId,
  ...props
}: FieldProps) {
  return (
    <BaseField.Root
      {...props}
      invalid={invalid || Boolean(error)}
      data-buzz-ui=""
      className="buzz-field"
    >
      <BaseField.Label
        nativeLabel={nativeLabel}
        {...(controlId ? { htmlFor: controlId } : {})}
        render={nativeLabel ? undefined : <span />}
        className={
          labelVisibility === "hidden" ? "sr-only" : "buzz-field-label"
        }
      >
        {label}
        {optional && (
          <>
            {" "}
            <span className="buzz-field-optional">Optional</span>
          </>
        )}
      </BaseField.Label>
      {children}
      {description && !error && (
        <BaseField.Description className="buzz-field-description">
          {description}
        </BaseField.Description>
      )}
      {error && (
        <div className="buzz-field-error-track">
          <BaseField.Error match role="alert" className="buzz-field-error">
            {error}
          </BaseField.Error>
        </div>
      )}
    </BaseField.Root>
  );
}
