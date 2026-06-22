import { useState } from "react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { FileDown, FileText, FileLock2 } from "lucide-react";
import { serializeNote, downloadHwrite } from "../js/hwrite";
import { exportNotePdf } from "../js/notePdf";
import HwriteExportDialog from "./HwriteExportDialog";
import PdfExportDialog from "./PdfExportDialog";

const cleanFileName = (name) =>
  (name || "note").replace(/[\\/:*?"<>|\n\r\t]/g, "").trim() || "note";

const ExportNote = ({ note }) => {
  const [hwriteOpen, setHwriteOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportAsHwrite = async ({ encrypted, passphrase }) => {
    setHwriteOpen(false);
    try {
      const blob = await serializeNote(
        { title: note.title, markdown: note.content },
        { encrypted, passphrase },
      );
      const filename = downloadHwrite(blob, note.title);
      toast.success(
        encrypted ? `Exported encrypted ${filename}` : `Exported ${filename}`,
      );
    } catch (err) {
      toast.error(err.message || "Export failed");
    }
  };

  const exportAsMD = () => {
    const blob = new Blob([note.content || ""], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTitle = (note.title || "note")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    a.href = url;
    a.download = `${safeTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAsPDF = async (fileName) => {
    setPdfOpen(false);
    setExporting(true);
    const toastId = toast.loading("Generating PDF…");
    try {
      await exportNotePdf({
        title: note.title || "Untitled",
        markdown: note.content || "",
        fileName: cleanFileName(fileName || note.title),
      });
      toast.success("PDF downloaded!", { id: toastId });
    } catch (err) {
      console.error("[pdf export] failed:", err);
      toast.error("PDF export failed", { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={exportAsMD}
        disabled={!note.content?.trim()}
        title="Export as a plain Markdown (.md) file. Warning: this file is NOT encrypted — it leaves HushWrite's encryption protection."
      >
        <FileText className="mr-1.5 h-4 w-4" />
        .MD
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setPdfOpen(true)}
        disabled={!note.content?.trim() || exporting}
        title="Export as a PDF document. Warning: this file is NOT encrypted — it leaves HushWrite's encryption protection."
      >
        <FileDown className="mr-1.5 h-4 w-4" />
        PDF
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setHwriteOpen(true)}
        disabled={!note.content?.trim()}
        title="Export as a .hwrite file — HushWrite's portable format. Stays encrypted with the passphrase you choose, so it remains protected outside the app."
      >
        <FileLock2 className="mr-1.5 h-4 w-4" />
        .hwrite
      </Button>
      {hwriteOpen && (
        <HwriteExportDialog
          onConfirm={exportAsHwrite}
          onCancel={() => setHwriteOpen(false)}
        />
      )}
      {pdfOpen && (
        <PdfExportDialog
          defaultName={note.title || ""}
          onConfirm={exportAsPDF}
          onCancel={() => setPdfOpen(false)}
        />
      )}
    </>
  );
};

export default ExportNote;
