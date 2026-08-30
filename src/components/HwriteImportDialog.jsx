import { useState } from "react";
import { FileInput, Lock, Unlock, FileText, Shield } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const HwriteImportDialog = ({
  parsed,
  fileSize,
  hasVault,
  onConfirm,
  onCancel,
}) => {
  const [destination, setDestination] = useState("notes");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Only the encrypted-into-vault path needs the source passphrase up front,
  // so we can decrypt with the file's key and re-encrypt under the vault key.
  // Encrypted-into-notes keeps the original ciphertext; the user enters the
  // file's passphrase the first time they open the note.
  const needsPassphrase = parsed.encrypted && destination === "vault";

  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  };
  const fmtSize = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const blurb = () => {
    if (destination === "notes") {
      return parsed.encrypted
        ? "Stored encrypted in your notes. The file's passphrase is required the first time you open it."
        : "Loaded into the editor as a new draft. Save it with your own passphrase to add it to your notes.";
    }
    return parsed.encrypted
      ? hasVault
        ? "Decrypted with the file's passphrase, then re-encrypted with your vault key."
        : "Decrypted with the file's passphrase, then encrypted with the new vault you create."
      : hasVault
        ? "Encrypted with your vault key and added to your vault."
        : "Encrypted with the new vault you create and added to it.";
  };

  const handleConfirmPreview = async () => {
    if (needsPassphrase && !passphrase) {
      setError("Enter the file's passphrase to import it into your vault.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm({
        destination,
        passphrase: needsPassphrase ? passphrase : undefined,
      });
    } catch (err) {
      setError(err.message || "Failed to import file.");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
            <FileInput className="h-5 w-5 text-primary" />
          </div>
          <DialogHeader>
            <DialogTitle>Import .hwrite file</DialogTitle>
            <DialogDescription>
              Choose where to put it.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Title
                </div>
                <div className="truncate text-base font-semibold">
                  {parsed.title || "Untitled"}
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
                <div className="uppercase tracking-wider">Created</div>
                <div className="text-foreground">{fmtDate(parsed.created)}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider">Modified</div>
                <div className="text-foreground">{fmtDate(parsed.modified)}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider">Size</div>
                <div className="text-foreground">{fmtSize(fileSize)}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider">Format</div>
                <div className="text-foreground">.hwrite v{parsed.hwrite}</div>
              </div>
            </div>
          </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Destination
          </div>
          <div
            role="radiogroup"
            aria-label="Import destination"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {[
              {
                id: "notes",
                label: "Notes",
                desc: "Standard library",
                icon: FileText,
              },
              {
                id: "vault",
                label: "Vault",
                desc: hasVault ? "Vault-encrypted" : "Create a vault",
                icon: Shield,
              },
            ].map((opt) => {
              const active = destination === opt.id;
              const IconCmp = opt.icon;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setDestination(opt.id);
                    setError("");
                  }}
                  disabled={busy}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-all",
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                      : "border-border bg-background hover:bg-muted/50",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <IconCmp className="h-4 w-4" />
                    {opt.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {opt.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {needsPassphrase && (
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                File passphrase
              </label>
              <input
                type="password"
                autoFocus
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setError("");
                }}
                disabled={busy}
                placeholder="Passphrase used when this .hwrite was exported"
                className="rounded-md border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-1 focus:ring-primary sm:text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Needed once to decrypt the file before re-encrypting it with your vault key.
              </p>
            </div>
          )}

          <p className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            {blurb()}
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirmPreview} disabled={busy}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default HwriteImportDialog;
