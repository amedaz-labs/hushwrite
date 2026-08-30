import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const Icon = ({ name, className, fill }) => (
  <span
    className={cn("material-symbols-outlined", className)}
    style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}
  >
    {name}
  </span>
);

const Stat = ({ label, value }) => (
  <div className="flex flex-col gap-0.5 rounded-lg border border-outline-variant/20 bg-surface-container-low px-4 py-3">
    <span className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/70">
      {label}
    </span>
    <span className="text-xl font-semibold tabular-nums text-on-surface">
      {value.toLocaleString()}
    </span>
  </div>
);

const NoteInfoDialog = ({
  open,
  onOpenChange,
  markdown,
  title,
  folderName,
  isUnlocked,
  onChangePassphrase,
  canMove = false,
  folders = [],
  currentFolderId = null,
  isFolderUnlocked = () => false,
  onMoveNote,
}) => {
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null);
  const [movePassphrase, setMovePassphrase] = useState("");
  const [moveConfirm, setMoveConfirm] = useState("");
  const [moving, setMoving] = useState(false);
  const inFolder = !!currentFolderId;

  const stats = useMemo(() => {
    const text = markdown || "";
    const characters = text.length;
    const trimmed = text.replace(/[#*`>_\-[\]()!]/g, " ").trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return { characters, words };
  }, [markdown]);

  const reset = () => {
    setNewPassphrase("");
    setConfirmPassphrase("");
    setWorking(false);
    setMoveTarget(null);
    setMovePassphrase("");
    setMoveConfirm("");
    setMoving(false);
  };

  const submitChange = async (e) => {
    e?.preventDefault?.();
    if (!newPassphrase || newPassphrase !== confirmPassphrase) {
      toast.error("Passphrases don't match.");
      return;
    }
    if (newPassphrase.length < 4) {
      toast.error("Passphrase is too short.");
      return;
    }
    setWorking(true);
    try {
      await onChangePassphrase(newPassphrase);
      toast.success("Passphrase updated");
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err.message || "Could not change passphrase");
      setWorking(false);
    }
  };

  // Destinations: every folder the note isn't already in, plus "on its own"
  // when it currently lives in a folder. Moving to a folder reuses that
  // folder's key (so it must be unlocked); moving out needs a fresh passphrase.
  const destinations = [
    ...(inFolder ? [{ id: null, label: "On its own", available: true }] : []),
    ...folders
      .filter((f) => f.id !== currentFolderId)
      .map((f) => ({
        id: f.id,
        label: f.name,
        available: isFolderUnlocked(f.id),
      })),
  ];
  const needsNewPassphrase = moveTarget !== null && moveTarget.id === null;

  const submitMove = async (e) => {
    e?.preventDefault?.();
    if (!moveTarget) return;
    if (needsNewPassphrase) {
      if (!movePassphrase || movePassphrase !== moveConfirm) {
        toast.error("Passphrases don't match.");
        return;
      }
    }
    setMoving(true);
    try {
      await onMoveNote(moveTarget.id, needsNewPassphrase ? movePassphrase : undefined);
      toast.success(
        moveTarget.id
          ? `Moved to ${moveTarget.label}`
          : "Moved out — this note now has its own passphrase",
      );
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err.message || "Could not move the note");
      setMoving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="info" className="shrink-0 text-base" fill />
            <span className="min-w-0 truncate">
              {title?.trim() || "Note details"}
            </span>
          </DialogTitle>
          <DialogDescription>
            Stats and security options for this note.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <Stat label="Words" value={stats.words} />
          <Stat label="Characters" value={stats.characters} />
        </div>

        {canMove && destinations.length > 0 && (
          <div className="mt-2 rounded-lg border border-outline-variant/20 bg-surface-container-low p-4">
            <div className="mb-3 flex items-center gap-2">
              <Icon name="drive_file_move" className="text-base text-vault-primary" />
              <h4 className="text-sm font-semibold text-on-surface">
                {inFolder ? `In folder: ${folderName}` : "Not in a folder"}
              </h4>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {destinations.map((d) => (
                <button
                  key={d.id || "root"}
                  type="button"
                  disabled={!d.available || moving}
                  onClick={() => setMoveTarget(d)}
                  title={d.available ? undefined : "Unlock this folder first"}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    moveTarget?.id === d.id
                      ? "bg-vault-primary text-on-primary-fixed"
                      : "bg-surface-container text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {moveTarget && (
              <form onSubmit={submitMove} className="mt-3 flex flex-col gap-2">
                {needsNewPassphrase && (
                  <>
                    <p className="text-[11px] leading-snug text-on-surface-variant/80">
                      Outside a folder a note carries its own passphrase.
                    </p>
                    <input
                      type="password"
                      value={movePassphrase}
                      onChange={(e) => setMovePassphrase(e.target.value)}
                      placeholder="Passphrase for this note"
                      className="w-full rounded-md border border-outline-variant/30 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
                    />
                    <input
                      type="password"
                      value={moveConfirm}
                      onChange={(e) => setMoveConfirm(e.target.value)}
                      placeholder="Confirm passphrase"
                      className="w-full rounded-md border border-outline-variant/30 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
                    />
                  </>
                )}
                <button
                  type="submit"
                  disabled={moving}
                  className="flex items-center justify-center gap-2 rounded-md bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon
                    name={moving ? "progress_activity" : "drive_file_move"}
                    className={cn("text-sm", moving && "animate-spin")}
                  />
                  {moving ? "Re-encrypting…" : `Move to ${moveTarget.label}`}
                </button>
              </form>
            )}
          </div>
        )}

        <div className="mt-2 rounded-lg border border-outline-variant/20 bg-surface-container-low p-4">
          <div className="mb-3 flex items-center gap-2">
            <Icon name="key" className="text-base text-vault-primary" />
            <h4 className="text-sm font-semibold text-on-surface">
              Change passphrase
            </h4>
          </div>
          {inFolder ? (
            <p className="text-xs text-on-surface-variant">
              This note is unlocked by the <strong>{folderName}</strong> folder.
              Change that folder's passphrase from the sidebar to re-key every
              note inside it.
            </p>
          ) : !isUnlocked ? (
            <p className="text-xs text-on-surface-variant">
              Unlock this note first to change its passphrase.
            </p>
          ) : (
            <form onSubmit={submitChange} className="flex flex-col gap-2">
              <input
                type="password"
                value={newPassphrase}
                onChange={(e) => setNewPassphrase(e.target.value)}
                placeholder="New passphrase"
                className="w-full rounded-md border border-outline-variant/30 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
              />
              <input
                type="password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder="Confirm new passphrase"
                className="w-full rounded-md border border-outline-variant/30 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
              />
              <button
                type="submit"
                disabled={working || !newPassphrase || !confirmPassphrase}
                className="mt-1 flex items-center justify-center gap-2 rounded-md bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name={working ? "progress_activity" : "lock_reset"} className={cn("text-sm", working && "animate-spin")} />
                {working ? "Updating…" : "Update passphrase"}
              </button>
              <p className="mt-1 text-[11px] leading-snug text-on-surface-variant/80">
                The note will be re-encrypted under the new passphrase. Make
                sure to remember it — there is no recovery.
              </p>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default NoteInfoDialog;
