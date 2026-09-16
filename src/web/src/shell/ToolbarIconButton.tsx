import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

export function ToolbarIconButton({
  active = false,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}): ReactElement {
  const classes = ["toolbar-icon-button", active ? "active" : "", className].filter(Boolean).join(" ");
  return <button type="button" className={classes} {...props}>{children}</button>;
}
