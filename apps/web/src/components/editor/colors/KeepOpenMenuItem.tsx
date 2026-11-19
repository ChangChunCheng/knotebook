import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useComponentsContext } from "@blocknote/react";

interface KeepOpenMenuItemProps {
  className?: string;
  children?: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  onClick: (event: MouseEvent) => void;
  "data-test"?: string;
  "data-kb-color-return"?: string;
}

/**
 * Menu item that doesn't close the menu. BlockNote's `Menu.Item` type has no `closeMenuOnClick` and onClick takes no event, but the
 * mantine implementation (`@blocknote/mantine` `menu/Menu.tsx`) forwards extra props and onClick unchanged, so both work at runtime; the cast lives here.
 */
export function KeepOpenMenuItem(props: KeepOpenMenuItemProps) {
  const Components = useComponentsContext()!;
  const { onClick, ...rest } = props;
  const extra = { ...rest, closeMenuOnClick: false, onClick } as unknown as ComponentProps<typeof Components.Generic.Menu.Item>;
  return <Components.Generic.Menu.Item {...extra} />;
}
