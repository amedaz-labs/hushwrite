import { forwardRef, useState } from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuItemText,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";

// A hover-reveal affordance is unreachable on touch, so on a coarse pointer the
// row's `⋯` is permanently visible instead. Read once — the pointer type does
// not change under you mid-session in any way worth re-rendering for.
const COARSE_POINTER =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none)").matches;

// The `⋯` affordance itself. A real <button>, ALWAYS mounted — it is only
// hidden with opacity, never conditionally rendered. Unmounting it on
// mouseleave/blur used to steal focus from keyboard users mid-tab and could
// tear down anything the menu owned while it was still in use.
export const RowMenuTrigger = forwardRef(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      // 22px of ink, 32px of target. The extra 5px on every side is a
      // pseudo-element rather than a negative margin so WCAG 2.2 SC 2.5.8 is
      // met without pulling the row's spacing in around it.
      "relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-outline transition-colors after:absolute after:-inset-[5px] after:content-[''] hover:bg-surface-container-highest hover:text-on-surface data-[state=open]:bg-surface-container-highest data-[state=open]:text-on-surface",
      className,
    )}
    {...props}
  >
    <MoreHorizontal className="h-[15px] w-[15px]" strokeWidth={1.9} />
  </button>
));
RowMenuTrigger.displayName = "RowMenuTrigger";

// Generic declarative overflow menu for a tree row.
export const RowMenu = ({ label, items, onOpenChange, align = "end" }) => (
  <Menu onOpenChange={onOpenChange}>
    <MenuTrigger asChild>
      <RowMenuTrigger aria-label={label} />
    </MenuTrigger>
    <MenuContent align={align}>
      {items.map((item, i) =>
        item.separator ? (
          <MenuSeparator key={`sep-${i}`} />
        ) : (
          <MenuItem
            key={item.label}
            disabled={item.disabled}
            destructive={item.destructive}
            onSelect={item.onSelect}
          >
            {item.icon && (
              <item.icon
                className="mt-px h-4 w-4 shrink-0"
                strokeWidth={1.7}
              />
            )}
            <MenuItemText label={item.label} hint={item.hint} />
          </MenuItem>
        ),
      )}
    </MenuContent>
  </Menu>
);

/**
 * One row anatomy for the whole sidebar tree:
 *   [twisty | lead icon] name · lock glyph · meta · ⋯
 *
 * Folders and root notes are siblings in the user's model, so they are drawn
 * the same way; a leaf just gets an invisible twisty so its icon still lines up.
 *
 * NO ARIA TREE, deliberately. This was `role="treeitem"` inside a `role="tree"`,
 * which promised arrow-key navigation that nothing here implements, and whose
 * `role="group"` sat as a *sibling* of its folder's row with no `aria-owns` — so
 * every note was announced at level 1 and the folder's `aria-expanded` pointed
 * at nothing. Two real sibling `<button>`s inside a plain `<div>` are honest
 * about what this widget is, get Enter/Space and tab order natively, and put
 * `aria-expanded` exactly where it belongs. A correct simple structure beats an
 * incorrect rich one; a real APG tree would need roving tabindex and arrow keys,
 * not just the role names.
 *
 * The row button uses the stretched-link pattern (`before:absolute
 * before:inset-0`) so the whole row stays clickable while the `⋯` remains a
 * sibling rather than a nested button.
 */
const TreeRow = ({
  twisty = "none", // "none" | "collapsed" | "expanded"
  icon: LeadIcon,
  leadClassName,
  name,
  lock, // node rendered in the lock slot (already coloured by the caller)
  meta,
  // Either `{ label, items }` for the declarative RowMenu, or a render
  // function `({ onOpenChange }) => node` when the caller needs its own menu
  // component. Omit for no overflow menu.
  menu,
  selected = false,
  dimmed = false,
  indented = false,
  title,
  onActivate,
}) => {
  // Tracked only so the `⋯` stays visible while its menu is open — the menu
  // content is portaled out of this subtree, so :hover / :focus-within on the
  // row are both false once it opens.
  const [menuOpen, setMenuOpen] = useState(false);

  // The row's own content. Interactive when the caller gave us something to
  // do; an inert span otherwise, so a non-activatable row (the unsaved draft)
  // is not a dead tab stop.
  const body = (
    <>
      {/* An indented row carries its own `pl-9` below; adding an invisible 16px
          twisty plus its gap on top of that pushed the lead icon out to 48px and
          cost ~15 characters of title in a 288px rail. Without the spacer the
          icon lands at 36px, 8px right of a folder or root row's 28px — which is
          the tree's only nesting cue, so it has to stay positive. */}
      {!indented && (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center text-outline transition-transform duration-150",
            twisty === "none" && "invisible",
            twisty === "expanded" && "rotate-90",
          )}
        >
          <ChevronRight className="h-[15px] w-[15px]" strokeWidth={1.9} />
        </span>
      )}
      {LeadIcon && (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center text-outline",
            leadClassName,
          )}
        >
          <LeadIcon className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13.2px] font-medium tracking-[-0.008em]",
          selected && "font-semibold",
          // A locked row is dimmed, but it still has to answer to hover like
          // every other row — `text-outline` alone beat the row's
          // `hover:text-on-surface`, leaving locked rows visually inert.
          dimmed && !selected && "text-outline group-hover:text-on-surface-variant",
        )}
      >
        {name}
      </span>
    </>
  );

  const bodyClass = "flex min-w-0 flex-1 items-center gap-2 text-left";

  return (
    <div
      className={cn(
        "group relative flex h-8 w-full items-center gap-2 rounded-lg pl-1 pr-1.5 transition-colors",
        indented && "pl-9",
        selected
          ? "bg-surface-container-high text-on-surface"
          : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute -left-1.5 bottom-1.5 top-1.5 w-[3px] rounded-r-[3px] bg-vault-primary"
        />
      )}
      {onActivate ? (
        <button
          type="button"
          title={title}
          aria-current={selected ? "true" : undefined}
          aria-expanded={twisty === "none" ? undefined : twisty === "expanded"}
          onClick={onActivate}
          className={cn(
            bodyClass,
            // Stretched link: the hit area is the whole row, but the element
            // is still a plain sibling of the `⋯` rather than its parent.
            "cursor-pointer rounded-lg outline-none before:absolute before:inset-0 before:rounded-lg focus-visible:before:ring-2 focus-visible:before:ring-vault-primary/60",
            // The row draws its own ring on the stretched `::before`. Without
            // this, the global `button:focus-visible { ring-2 ring-ring }`
            // (index.css) painted a SECOND ring tight around the inner `flex-1`
            // button. `ring-0` and not `shadow-none`: `shadow-none` only resets
            // `--tw-shadow`, leaving `--tw-ring-shadow` in the box-shadow list.
            "focus-visible:ring-0",
          )}
        >
          {body}
        </button>
      ) : (
        <span title={title} className={bodyClass}>
          {body}
        </span>
      )}
      {lock}
      {meta !== undefined && meta !== null && meta !== "" && (
        <span className="shrink-0 text-[11px] tabular-nums text-outline">
          {meta}
        </span>
      )}
      {/* Rows without a menu (the unsaved draft) still have to reserve the
          trigger column, or their `meta` sits 30px right of every other row's. */}
      {!menu && <span aria-hidden="true" className="h-[22px] w-[22px] shrink-0" />}
      {menu && (
        // `relative` so it stacks above the row button's stretched hit area.
        // No stopPropagation here any more: the trigger is a SIBLING of the row
        // button, so nothing to stop — and stopping `pointerdown`/`keydown` was
        // also swallowing the document-level listeners FolderProvider uses to
        // re-arm its 15-minute idle timer (lib/folders.jsx:114-115), which could
        // idle-lock a user who was driving the sidebar entirely through menus.
        <span
          className={cn(
            "relative flex shrink-0 items-center transition-opacity",
            // The selected row keeps its `⋯` visible: it is the row the user is
            // acting on, and hiding its only affordance until hover was the one
            // place the tree disagreed with itself.
            COARSE_POINTER || menuOpen || selected
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {typeof menu === "function" ? (
            menu({ onOpenChange: setMenuOpen })
          ) : (
            <RowMenu
              label={menu.label}
              items={menu.items}
              onOpenChange={setMenuOpen}
            />
          )}
        </span>
      )}
    </div>
  );
};

export default TreeRow;
