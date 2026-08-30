import { useEffect, useRef, useState } from "react";
import { FileLock2, Eye, EyeOff } from "lucide-react";
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

// Confirm modal for exporting a note as .hwrite. Lets the user pick between an
// encrypted file (with its own passphrase, independent of the app passphrase)
// and a plaintext file. Encrypted is the default.
const HwriteExportDialog = ({ onConfirm, onCancel }) => {
  const [encrypted, setEncrypted] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const firstInputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => firstInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [encrypted]);

  const tooShort = encrypted && passphrase.length > 0 && passphrase.length < 8;
  const mismatch =
    encrypted &&
    confirmPassphrase.length > 0 &&
    passphrase !== confirmPassphrase;
  const canSubmit = encrypted
    ? passphrase.length >= 8 && passphrase === confirmPassphrase
    : true;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm({ encrypted, passphrase: encrypted ? passphrase : undefined });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
            <FileLock2 className="h-5 w-5 text-primary" />
          </div>
          <DialogHeader>
            <DialogTitle>Export as .hwrite</DialogTitle>
            <DialogDescription>
              {encrypted
                ? "The file will be encrypted. Anyone with the passphrase can open it on any Hushwrite install."
                : "The file will contain your note in plaintext. Anyone who opens the file can read it."}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Encrypt toggle */}
        <label className="flex cursor-pointer select-none items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
          <div>
            <div className="text-sm font-medium">Encrypt with passphrase</div>
            <div className="text-xs text-muted-foreground">
              Recommended. Uses AES-256-GCM with PBKDF2.
            </div>
          </div>
          <input
            type="checkbox"
            checked={encrypted}
            onChange={(e) => setEncrypted(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
        </label>

        {encrypted && (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Input
                ref={firstInputRef}
                type={showPass ? "text" : "password"}
                placeholder="Passphrase (min 8 characters)"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="bg-background pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? "Hide passphrase" : "Show passphrase"}
                className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                {showPass ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <Input
              type={showPass ? "text" : "password"}
              placeholder="Confirm passphrase"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              className="bg-background"
            />
            {tooShort && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Passphrase must be at least 8 characters.
              </p>
            )}
            {mismatch && (
              <p className="text-xs text-destructive">
                Passphrases don&apos;t match.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default HwriteExportDialog;
