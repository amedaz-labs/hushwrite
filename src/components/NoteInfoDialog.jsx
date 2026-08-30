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
  vaultMode,
  isUnlocked,
  onChangePassphrase,
  onChangeVaultPassphrase,
}) => {
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [working, setWorking] = useState(false);

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
      if (vaultMode) {
        const count = await onChangeVaultPassphrase(newPassphrase);
        toast.success(
          typeof count === "number"
            ? `Vault passphrase updated · ${count} note${count === 1 ? "" : "s"} re-encrypted`
            : "Vault passphrase updated",
        );
      } else {
        await onChangePassphrase(newPassphrase);
        toast.success("Passphrase updated");
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err.message || "Could not change passphrase");
      setWorking(false);
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

        <div className="mt-2 rounded-lg border border-outline-variant/20 bg-surface-container-low p-4">
          <div className="mb-3 flex items-center gap-2">
            <Icon name="key" className="text-base text-vault-primary" />
            <h4 className="text-sm font-semibold text-on-surface">
              {vaultMode ? "Change vault passphrase" : "Change passphrase"}
            </h4>
          </div>
          {!isUnlocked ? (
            <p className="text-xs text-on-surface-variant">
              {vaultMode
                ? "Unlock the vault first to change its passphrase."
                : "Unlock this note first to change its passphrase."}
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
                {working
                  ? vaultMode
                    ? "Re-encrypting vault…"
                    : "Updating…"
                  : vaultMode
                    ? "Update vault passphrase"
                    : "Update passphrase"}
              </button>
              <p className="mt-1 text-[11px] leading-snug text-on-surface-variant/80">
                {vaultMode
                  ? "Every note in the vault will be re-encrypted under the new passphrase. Make sure to remember it — there is no recovery."
                  : "The note will be re-encrypted under the new passphrase. Make sure to remember it — there is no recovery."}
              </p>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default NoteInfoDialog;
