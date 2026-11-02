import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";

const EXAMPLE = "Help me plan my week and prioritize tasks.";

export function AgentInstructions({
  value,
  disabled,
  onChange,
  description,
  creation = false,
}: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  description?: string | undefined;
  creation?: boolean;
}) {
  return (
    <Field label="Instructions" description={description} optional={creation}>
      <Textarea
        appearance="outlined"
        rows={creation ? 4 : 8}
        value={value}
        disabled={disabled}
        placeholder={EXAMPLE}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
