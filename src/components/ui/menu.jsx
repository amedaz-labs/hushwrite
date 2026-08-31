import * as React from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

// Shared overflow-menu primitive. Radix portals its content, which is the only
// clean fix for a menu opened on the last row of the sidebar's
// `overflow-y-auto` scroller — a hand-rolled absolutely-positioned list gets
// clipped there.
const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;
const MenuGroup = MenuPrimitive.Group;

const MenuContent = React.forwardRef(
  ({ className, sideOffset = 6, align = "end", ...props }, ref) => (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-[70] min-w-[13rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-outline-variant/70 bg-surface-container-low p-1.5 shadow-2xl",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  ),
);
MenuContent.displayName = MenuPrimitive.Content.displayName;

const MenuItem = React.forwardRef(
  ({ className, destructive = false, inset = false, ...props }, ref) => (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(
        "flex w-full cursor-pointer select-none items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] outline-none transition-colors",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        destructive
          ? "text-error data-[highlighted]:bg-error/10"
          : "text-on-surface-variant data-[highlighted]:bg-surface-container-high data-[highlighted]:text-on-surface",
        inset && "pl-9",
        className,
      )}
      {...props}
    />
  ),
);
MenuItem.displayName = MenuPrimitive.Item.displayName;

const MenuSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <MenuPrimitive.Separator
    ref={ref}
    className={cn("mx-1 my-1.5 h-px bg-outline-variant/50", className)}
    {...props}
  />
));
MenuSeparator.displayName = MenuPrimitive.Separator.displayName;

const MenuLabel = React.forwardRef(({ className, ...props }, ref) => (
  <MenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-outline",
      className,
    )}
    {...props}
  />
));
MenuLabel.displayName = MenuPrimitive.Label.displayName;

// The label + optional explanatory sub-line used inside a MenuItem. Export
// warnings that used to hide in a `title` attribute are readable here.
const MenuItemText = ({ label, hint }) => (
  <span className="min-w-0 flex-1">
    <span className="block truncate">{label}</span>
    {hint && (
      <span className="mt-0.5 block text-[11px] leading-snug text-outline">
        {hint}
      </span>
    )}
  </span>
);

export {
  Menu,
  MenuTrigger,
  MenuGroup,
  MenuContent,
  MenuItem,
  MenuItemText,
  MenuSeparator,
  MenuLabel,
};
