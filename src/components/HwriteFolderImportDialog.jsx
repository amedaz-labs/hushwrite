import { useState } from "react";
import { FolderInput, Lock, Unlock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Import a .hwrite folder bundle. Always lands as a brand-new folder — merging
// into an existing one would mean re-keying someone else's notes, which is a
// separate, riskier operation.
//
// For an encrypted bundle the file's passphrase becomes the new folder's
// passphrase, so the user types it once and the folder behaves exactly like the
// one they exported. A plaintext bundle has no passphrase to inherit, so they
// choose one here.
const HwriteFolderImportDialog = ({
  parsed,
  fileSize,
  existingNames = [],
  onConfirm,
  onCancel,
}) => {
  const suggestName = () => {
    const base = (parsed.title || "Folder").trim() || "Folder";
    if (!existingNames.includes(base)) return base;
    let n = 2;
    while (existingNames.includes(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  };

  const [name, setName] = useState(suggestName);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const noteCount = Number.isFinite(parsed.note_count) ? parsed.note_count : null;
  // An encrypted bundle only needs the file's passphrase (it carries over);
  // a plaintext one needs a fresh passphrase, confirmed.
  const needsConfirm = !parsed.encrypted;

  const fmtSize = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!name.trim()) return setError("Give the folder a name.");
    if (!passphrase) {
      return setError(
        parsed.encrypted
          ? "Enter the passphrase this file was exported with."
          : "Choose a passphrase for the new folder.",
      );
    }
    if (needsConfirm && passphrase !== confirmPassphrase) {
      return setError("Passphrases don't match.");
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm({ name: name.trim(), passphrase });
    } catch (err) {
      setError(err.message || "Could not import this folder.");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
              <FolderInput className="h-5 w-5 text-primary" />
            </div>
            <DialogHeader>
              <DialogTitle>Import folder</DialogTitle>
              <DialogDescription>
                This creates a new folder — nothing already on this device is
                touched.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Folder
                </div>
                <div className="truncate text-base font-semibold">
                  {parsed.title || "Folder"}
                </div>
              </div>
              <span
                className={
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                  (parsed.encrypted
                    ? "bg-primary/15 text-primary"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400")
                }
              >
                {parsed.encrypted ? (
                  <>
                    <Lock className="h-3 w-3" /> Encrypted
                  </>
                ) : (
                  <>
                    <Unlock className="h-3 w-3" /> Plaintext
                  </>
                )}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
              <div>
                <div className="uppercase tracking-wider">Notes</div>
                <div className="text-foreground">{noteCount ?? "—"}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider">Size</div>
                <div className="text-foreground">{fmtSize(fileSize)}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Name on this device
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              disabled={busy}
              className="bg-background"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              {parsed.encrypted ? "File passphrase" : "New folder passphrase"}
            </label>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError("");
              }}
              disabled={busy}
              placeholder={
                parsed.encrypted
                  ? "Passphrase used when this folder was exported"
                  : "Choose a passphrase"
              }
              className="bg-background"
            />
            {needsConfirm && (
              <Input
                type="password"
                value={confirmPassphrase}
                onChange={(e) => {
                  setConfirmPassphrase(e.target.value);
                  setError("");
                }}
                disabled={busy}
                placeholder="Confirm passphrase"
                className="bg-background"
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              {parsed.encrypted
                ? "The imported folder keeps this passphrase. You can change it afterwards from the folder menu."
                : "This file isn't encrypted — the folder you create here will be."}
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Importing…" : "Import folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default HwriteFolderImportDialog;
