import { useEffect, useRef, useState } from "react";
import { FileDown } from "lucide-react";
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

// Strip characters that are illegal in filenames while keeping the name
// human-readable (spaces and case preserved, unlike the storage slug).
const cleanFileName = (name) =>
  (name || "").replace(/[\\/:*?"<>|\n\r\t]/g, "").trim();

// Prompt for the PDF filename before downloading. Note titles can be long, so
// this lets the user pick a short, sensible name. Defaults to the note title.
const PdfExportDialog = ({ defaultName = "", onConfirm, onCancel }) => {
  const [name, setName] = useState(() => cleanFileName(defaultName).slice(0, 80));
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);

  const finalName = cleanFileName(name) || "note";
  const canSubmit = name.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm(finalName);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15">
            <FileDown className="h-5 w-5 text-primary" />
          </div>
          <DialogHeader className="min-w-0">
            <DialogTitle>Export as PDF</DialogTitle>
            <DialogDescription>
              Name the PDF file before downloading.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Input
            ref={inputRef}
            type="text"
            placeholder="File name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            className="bg-background"
          />
          <p className="truncate text-xs text-muted-foreground">
            Saves as <span className="font-medium">{finalName}.pdf</span>
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PdfExportDialog;
