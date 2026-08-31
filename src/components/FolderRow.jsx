import { useState } from "react";
import {
  Download,
  Eye,
  EyeOff,
  Folder,
  KeyRound,
  Lock,
  LockOpen,
  PenLine,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import TreeRow from "./TreeRow";

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
  const [showPass, setShowPass] = useState(false);
  const promptOpen = expanded && !unlocked;

  // Expanding or collapsing the row throws away whatever was typed, so a
  // half-entered passphrase never lingers in memory behind a closed row. The
  // reveal goes back to hidden with it — an unlock form left in plain-text mode
  // is exactly the state a shoulder-surfer wants to inherit.
  const handleToggle = () => {
    setPassphrase("");
    setError("");
    setShowPass(false);
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
      // Drop reveal too: the row stays mounted after unlocking, so a later
      // lock would re-open this form still in plain-text mode.
      setShowPass(false);
    } catch (err) {
      setError(err.message || "Wrong folder passphrase.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <TreeRow
        twisty={expanded ? "expanded" : "collapsed"}
        icon={Folder}
        name={folder.name}
        selected={isActive}
        dimmed={!unlocked}
        title={`${folder.name} · ${count} note${count === 1 ? "" : "s"} · ${unlocked ? "unlocked" : "locked"}`}
        onActivate={handleToggle}
        // One lock affordance, not two: the folder glyph stays constant and
        // this single dot carries the locked/unlocked state.
        lock={
          <span
            aria-hidden="true"
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center",
              unlocked ? "text-ok" : "text-outline",
            )}
          >
            {unlocked ? (
              <LockOpen className="h-[15px] w-[15px]" strokeWidth={1.7} />
            ) : (
              <Lock className="h-[15px] w-[15px]" strokeWidth={1.7} />
            )}
          </span>
        }
        // An empty folder rendered a bare "0" next to its name.
        meta={count ? String(count) : null}
        menu={{
          label: `Actions for folder ${folder.name}`,
          items: [
            { label: "Rename", icon: PenLine, onSelect: onRename },
            {
              label: "Lock folder",
              icon: Lock,
              disabled: !unlocked,
              onSelect: onLock,
            },
            {
              label: "Change passphrase…",
              icon: KeyRound,
              disabled: !unlocked,
              onSelect: onChangePassphrase,
            },
            { separator: true },
            {
              label: "Export folder (.hwrite)",
              icon: Download,
              hint: "Every note in one portable file",
              disabled: !unlocked || count === 0,
              onSelect: onExport,
            },
            { separator: true },
            {
              label: "Delete folder",
              icon: Trash2,
              disabled: !unlocked,
              destructive: true,
              onSelect: onDelete,
            },
          ],
        }}
      />

      {promptOpen && (
        <form
          onSubmit={submit}
          className="flex flex-col gap-2 px-1 pb-3 pl-9 pt-1"
        >
          <p className="text-[11px] text-on-surface-variant">
            One passphrase opens all {count} note{count === 1 ? "" : "s"} in
            here.
          </p>
          {/* Reveal toggle: this is the highest-stakes field in the app and the
              one most often typed on a phone keyboard, where a silent typo just
              reads as "wrong passphrase". */}
          <div className="relative">
            <input
              type={showPass ? "text" : "password"}
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError("");
              }}
              placeholder="Folder passphrase"
              className={cn(
                "w-full rounded-lg border bg-surface-container py-2 pl-3 pr-10 text-base text-on-surface placeholder-outline focus:outline-none sm:text-sm",
                error
                  ? "border-error/60 focus:border-error"
                  : "border-outline/85 focus:border-vault-primary/60",
              )}
            />
            <button
              type="button"
              onClick={() => setShowPass((v) => !v)}
              aria-label={showPass ? "Hide passphrase" : "Show passphrase"}
              className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-outline transition-colors hover:text-on-surface"
            >
              {showPass ? (
                <EyeOff className="h-4 w-4" strokeWidth={1.7} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.7} />
              )}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[11px] text-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !passphrase}
            className="flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-vault-primary px-3 py-2 text-xs font-medium text-on-primary-fixed transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LockOpen className="h-4 w-4" strokeWidth={1.9} />
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      )}

      {expanded && unlocked && children}
    </div>
  );
};

export default FolderRow;
