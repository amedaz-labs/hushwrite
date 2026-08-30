import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DeleteModal = ({
  onConfirm,
  onCancel,
  requirePassphrase = false,
  canForceDelete = false,
  verify,
}) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!requirePassphrase) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [requirePassphrase]);

  const handleSubmit = async () => {
    if (!requirePassphrase) {
      onConfirm({ kind: "confirm" });
      return;
    }
    if (!value.trim() || verifying) return;
    setError(null);
    setVerifying(true);
    try {
      await verify(value);
      onConfirm({ kind: "passphrase", passphrase: value });
    } catch {
      setError("Wrong passphrase. Try again.");
      setValue("");
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setVerifying(false);
    }
  };

  const handleForceDelete = () => {
    if (!canForceDelete || verifying) return;
    onConfirm({ kind: "force" });
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/15">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              {requirePassphrase
                ? "Enter the note's passphrase to confirm deletion. This action is permanent."
                : "This action is permanent and cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>

        {requirePassphrase && (
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="password"
              placeholder="Passphrase…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              disabled={verifying}
              className={cn(
                "bg-background",
                error && "border-destructive focus-visible:ring-destructive",
              )}
            />
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {canForceDelete && (
              <button
                type="button"
                onClick={handleForceDelete}
                disabled={verifying}
                className="-mx-1 inline-flex min-h-[44px] items-center px-1 text-xs font-medium text-outline underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50 md:min-h-0"
                title="This note is older than 30 days — can be deleted without a passphrase"
              >
                Delete without passphrase
              </button>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={verifying}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={verifying || (requirePassphrase && !value.trim())}
          >
            {verifying ? "Verifying…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteModal;
