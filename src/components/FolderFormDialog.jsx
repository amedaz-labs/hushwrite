import { useState } from "react";
import { FolderPlus, KeyRound, Pencil } from "lucide-react";
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

// One dialog for the three folder forms that differ only in which fields they
// show: creating a folder (name + new passphrase), renaming it (name), and
// rotating its passphrase (new passphrase). Callers mount it with a `key` per
// invocation so each open starts from clean state.
const COPY = {
  create: {
    icon: FolderPlus,
    title: "New folder",
    description:
      "One passphrase unlocks every note you put in this folder. The name is stored unencrypted so you can find it while it's locked.",
    submit: "Create folder",
  },
  rename: {
    icon: Pencil,
    title: "Rename folder",
    description: "Only the label changes — notes stay encrypted as they are.",
    submit: "Rename",
  },
  passphrase: {
    icon: KeyRound,
    title: "Change folder passphrase",
    description:
      "Every note in this folder is re-encrypted under the new passphrase. There is no recovery if you forget it.",
    submit: "Update passphrase",
  },
};

const FolderFormDialog = ({
  open,
  mode = "create",
  initialName = "",
  folderName = "",
  onSubmit,
  onOpenChange,
}) => {
  const [name, setName] = useState(initialName);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const copy = COPY[mode] || COPY.create;
  const Icon = copy.icon;
  const wantsName = mode === "create" || mode === "rename";
  const wantsPassphrase = mode === "create" || mode === "passphrase";

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (wantsName && !name.trim()) return setError("Give the folder a name.");
    if (wantsPassphrase) {
      if (!passphrase) return setError("Choose a passphrase.");
      if (passphrase !== confirm) return setError("Passphrases don't match.");
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name: name.trim(), passphrase });
      onOpenChange(false);
    } catch (err) {
      setError(err.message || "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <DialogHeader>
              <DialogTitle>
                {copy.title}
                {folderName && mode !== "create" ? ` — ${folderName}` : ""}
              </DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
          </div>

          {wantsName && (
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              placeholder="Folder name"
              disabled={busy}
              className="bg-background"
            />
          )}

          {wantsPassphrase && (
            <>
              <Input
                autoFocus={!wantsName}
                type="password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setError("");
                }}
                placeholder={mode === "create" ? "Passphrase" : "New passphrase"}
                disabled={busy}
                className="bg-background"
              />
              <Input
                type="password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError("");
                }}
                placeholder="Confirm passphrase"
                disabled={busy}
                className="bg-background"
              />
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Working…" : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default FolderFormDialog;
