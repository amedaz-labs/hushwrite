import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

// Lightweight overflow menu — the app has no dropdown primitive and a folder
// row only needs four items, so a positioned list with outside-click dismissal
// is cheaper than pulling in another Radix package.
const RowMenu = ({ items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative">
      <span
        role="button"
        tabIndex={0}
        aria-label="Folder actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }
        }}
        className="flex h-7 w-7 items-center justify-center rounded text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface"
      >
        <Icon name="more_horiz" className="text-base" />
      </span>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-48 overflow-hidden rounded-lg border border-outline-variant/20 bg-surface-container py-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
              // Stop only — the row's own keydown handler preventDefaults,
              // which would cancel this button's activation click.
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                item.destructive
                  ? "text-error hover:bg-error-container/30"
                  : "text-on-surface hover:bg-surface-container-high",
              )}
            >
              <Icon name={item.icon} className="text-sm" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
};

const FolderRow = ({
  folder,
  unlocked,
  expanded,
  count,
  isActive,
  onToggle,
  onUnlock,
  onLock,
  onRename,
  onChangePassphrase,
  onExport,
  onDelete,
  children,
}) => {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const promptOpen = expanded && !unlocked;

  // Expanding or collapsing the row throws away whatever was typed, so a
  // half-entered passphrase never lingers in memory behind a closed row.
  const handleToggle = () => {
    setPassphrase("");
    setError("");
    onToggle();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    setError("");
    try {
      await onUnlock(passphrase);
      setPassphrase("");
    } catch (err) {
      setError(err.message || "Wrong folder passphrase.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors",
          isActive
            ? "bg-surface-container-high"
            : "hover:bg-surface-container",
        )}
      >
        <Icon
          name={expanded ? "expand_more" : "chevron_right"}
          className="shrink-0 text-base text-outline"
        />
        <Icon
          name={unlocked ? "folder_open" : "folder"}
          className={cn(
            "shrink-0 text-lg",
            unlocked ? "text-vault-primary" : "text-outline",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            unlocked ? "text-on-surface" : "text-on-surface-variant",
          )}
        >
          {folder.name}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-outline">
          {count}
        </span>
        <Icon
          name={unlocked ? "lock_open" : "lock"}
          className={cn(
            "shrink-0 text-sm",
            unlocked ? "text-vault-primary" : "text-outline/70",
          )}
        />
        <RowMenu
          items={[
            {
              label: "Lock folder",
              icon: "lock",
              disabled: !unlocked,
              onSelect: onLock,
            },
            { label: "Rename", icon: "edit", onSelect: onRename },
            {
              label: "Change passphrase",
              icon: "key",
              disabled: !unlocked,
              onSelect: onChangePassphrase,
            },
            {
              label: "Export folder",
              icon: "download",
              disabled: !unlocked || count === 0,
              onSelect: onExport,
            },
            {
              label: "Delete folder",
              icon: "delete",
              disabled: !unlocked,
              destructive: true,
              onSelect: onDelete,
            },
          ]}
        />
      </div>

      {promptOpen && (
        <form onSubmit={submit} className="flex flex-col gap-2 px-3 pb-3 pl-9">
          <p className="text-[11px] text-on-surface-variant">
            One passphrase opens all {count} note{count === 1 ? "" : "s"} in
            here.
          </p>
          <input
            type="password"
            autoFocus
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setError("");
            }}
            placeholder="Folder passphrase"
            className={cn(
              "w-full rounded-lg border bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:outline-none sm:text-sm",
              error
                ? "border-error/60 focus:border-error"
                : "border-outline-variant/30 focus:border-vault-primary/60",
            )}
          />
          {error && <p className="text-[11px] text-error">{error}</p>}
          <button
            type="submit"
            disabled={busy || !passphrase}
            className="flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-vault-primary px-3 py-2 text-xs font-medium text-on-primary-fixed transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="lock_open" className="text-sm" />
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      )}

      {expanded && unlocked && children}
    </div>
  );
};

export default FolderRow;
