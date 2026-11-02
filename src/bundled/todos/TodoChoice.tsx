import type { ReactElement } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";

/** The two row choices share compact triggers, with full labels in the menu. */
export function TodoChoice({
  id,
  label,
  title,
  text,
  icon,
  variant = "ghost",
  menuTitle,
  value,
  disabled,
  options,
  onValueChange,
}: {
  id: string;
  label: string;
  title: string;
  text?: ReactElement | string | undefined;
  icon: ReactElement;
  variant?: "ghost" | "avatar";
  menuTitle: string;
  value: string;
  disabled: boolean;
  options: {
    value: string;
    label: string;
    icon: ReactElement;
    disabled?: boolean;
  }[];
  onValueChange(value: string): void;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          text ? (
            <Button
              id={id}
              size="sm"
              variant="ghost"
              aria-label={label}
              aria-description={title}
              title={title}
              disabled={disabled}
            >
              {icon}
              {text}
            </Button>
          ) : (
            <IconButton
              id={id}
              size="sm"
              variant={variant}
              aria-label={label}
              aria-description={title}
              title={title}
              icon={icon}
              disabled={disabled}
            />
          )
        }
      />
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{menuTitle}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={onValueChange}>
            {options.map((option) => (
              <MenuRadioItem
                closeOnClick
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                <ChoiceRow leading={option.icon} label={option.label} />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </MenuRoot>
  );
}
