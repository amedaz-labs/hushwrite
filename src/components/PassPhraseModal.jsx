import { useState, useEffect, useRef } from "react";
import { Lock, KeyRound, Info } from "lucide-react";
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

const PassphraseModal = ({
  mode,
  folderName,
  noteCount = 0,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onConfirm(value);
  };

  const isEncrypt = mode === "encrypt";
  const Icon = isEncrypt ? Lock : KeyRound;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <DialogHeader>
            <DialogTitle>
              {isEncrypt
                ? "Encrypt note"
                : folderName
                  ? `Unlock “${folderName}”`
                  : "Decrypt note"}
            </DialogTitle>
            <DialogDescription>
              {isEncrypt
                ? "Choose a passphrase to encrypt and save this note. A new passphrase will overwrite the previous one."
                : folderName
                  ? noteCount > 0
                    ? `One passphrase opens all ${noteCount} note${noteCount === 1 ? "" : "s"} in this folder.`
                    : "One passphrase opens every note in this folder."
                  : "Enter the passphrase used when this note was saved."}
            </DialogDescription>
          </DialogHeader>
        </div>

        {isEncrypt && (
          <p className="flex gap-2 rounded-lg bg-warn/10 p-2.5 text-[11.5px] leading-snug text-warn">
            <Info className="mt-px h-4 w-4 shrink-0" strokeWidth={1.7} />
            <span>
              There is no reset. Lose this and the note is unrecoverable —
              that's the point, but write it down somewhere real.
            </span>
          </p>
        )}

        <Input
          ref={inputRef}
          type="password"
          placeholder="Passphrase…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          className="bg-background"
        />

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!value.trim()}>
            {isEncrypt ? "Encrypt & Save" : "Unlock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PassphraseModal;
