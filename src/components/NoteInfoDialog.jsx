import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { FolderInput, Info, KeyRound, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const Stat = ({ label, value }) => (
  <div className="flex flex-col gap-0.5 rounded-lg border border-outline-variant/45 bg-surface-container-low px-4 py-3">
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
  // Which card the caller actually asked for: "Move to folder…" and "Change
  // passphrase…" both open this dialog, and landing on an info header with a
  // word-count grid — with the card you chose two scrolls down — makes the menu
  // read as three labels pointing at one destination.
  focusSection = null, // "move" | "passphrase" | null
}) => {
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null);
  const [movePassphrase, setMovePassphrase] = useState("");
  const [moveConfirm, setMoveConfirm] = useState("");
  const [moving, setMoving] = useState(false);
  const inFolder = !!currentFolderId;

  // `markdown` is null when the caller can't decrypt this note (the sidebar
  // opening info for a locked note). Counting characters in "" would report a
  // confident 0 words for a note that may be pages long.
  const hasContent = typeof markdown === "string";

  const stats = useMemo(() => {
    const text = markdown || "";
    const characters = text.length;
    const trimmed = text.replace(/[#*`>_\-[\]()!]/g, " ").trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return { characters, words };
  }, [markdown]);

  const moveCardRef = useRef(null);
  const passphraseCardRef = useRef(null);

  // Scroll the requested card into view and put focus on its first control.
  // Deferred a frame because Radix moves focus to the dialog itself on open;
  // running synchronously would just get overwritten.
  useEffect(() => {
    if (!open || !focusSection) return;
    const card =
      focusSection === "move" ? moveCardRef.current : passphraseCardRef.current;
    if (!card) return;
    const frame = requestAnimationFrame(() => {
      card.scrollIntoView({ block: "nearest" });
      card
        .querySelector("input, button:not([disabled]), select, textarea")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusSection]);

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
            <Info className="h-4 w-4 shrink-0" strokeWidth={1.7} />
            <span className="min-w-0 truncate">
              {title?.trim() || "Note details"}
            </span>
          </DialogTitle>
          <DialogDescription>
            Stats and security options for this note.
          </DialogDescription>
        </DialogHeader>

        {hasContent ? (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Words" value={stats.words} />
            <Stat label="Characters" value={stats.characters} />
          </div>
        ) : (
          <p className="rounded-lg border border-outline-variant/45 bg-surface-container-low px-4 py-3 text-xs text-on-surface-variant">
            Word and character counts need the note's text — open it and unlock
            it to see them.
          </p>
        )}

        {canMove && destinations.length > 0 && (
          <div
            ref={moveCardRef}
            className="mt-2 rounded-lg border border-outline-variant/45 bg-surface-container-low p-4"
          >
            <div className="mb-3 flex items-center gap-2">
              <FolderInput className="h-4 w-4 text-vault-primary" strokeWidth={1.7} />
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
                      className="w-full rounded-md border border-outline/85 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
                    />
                    <input
                      type="password"
                      value={moveConfirm}
                      onChange={(e) => setMoveConfirm(e.target.value)}
                      placeholder="Confirm passphrase"
                      className="w-full rounded-md border border-outline/85 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
                    />
                  </>
                )}
                <button
                  type="submit"
                  disabled={moving}
                  className="flex items-center justify-center gap-2 rounded-md bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {moving ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.7} />
                  ) : (
                    <FolderInput className="h-4 w-4" strokeWidth={1.7} />
                  )}
                  {moving ? "Re-encrypting…" : `Move to ${moveTarget.label}`}
                </button>
              </form>
            )}
          </div>
        )}

        <div
          ref={passphraseCardRef}
          className="mt-2 rounded-lg border border-outline-variant/45 bg-surface-container-low p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-vault-primary" strokeWidth={1.7} />
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
                className="w-full rounded-md border border-outline/85 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
              />
              <input
                type="password"
                value={confirmPassphrase}
                onChange={(e) => setConfirmPassphrase(e.target.value)}
                placeholder="Confirm new passphrase"
                className="w-full rounded-md border border-outline/85 bg-surface-container px-3 py-2 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm"
              />
              <button
                type="submit"
                disabled={working || !newPassphrase || !confirmPassphrase}
                className="mt-1 flex items-center justify-center gap-2 rounded-md bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {working ? (<Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.7} />) : (<KeyRound className="h-4 w-4" strokeWidth={1.7} />)}
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
