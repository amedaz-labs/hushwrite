import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import HwriteExportDialog from "@/components/HwriteExportDialog";
import PdfExportDialog from "@/components/PdfExportDialog";
import { exportAsHwrite, exportAsMarkdown, exportAsPdf } from "@/js/exportNote";

/**
 * The export dialogs, owned by whoever owns the MENU'S OWNER — never by the
 * menu itself, and never by a row.
 *
 * A sidebar row mounts and unmounts with hover/selection state; a dialog it
 * owned would vanish mid-typing (taking the passphrase with it) the moment the
 * pointer left the row. So the state lives here and the caller renders
 * `dialogs` somewhere stable.
 *
 * `getContent` is passed per-invocation rather than per-hook, because one
 * owner (the sidebar) drives many different notes through the same dialogs.
 */
export const useNoteExports = () => {
  const [hwriteOpen, setHwriteOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfName, setPdfName] = useState("");
  const [exporting, setExporting] = useState(false);
  // The resolver for the note the open dialog belongs to. A ref, not state:
  // it is read inside the confirm handler, never rendered.
  const getContentRef = useRef(null);

  /**
   * Tear the whole thing down: close both dialogs AND drop the resolver.
   *
   * Both halves matter. A dialog that outlives a lock still has a live confirm
   * handler, so clicking Export would write full plaintext to disk with no
   * passphrase re-entry. And a resolver left in the ref keeps whatever it
   * closes over — for the editor, the decrypted body and title — alive across
   * a lock, a note switch and `lockAll()`.
   *
   * Stable identity so callers can list it in an effect's dep array.
   */
  const close = useCallback(() => {
    getContentRef.current = null;
    setHwriteOpen(false);
    setPdfOpen(false);
  }, []);

  const resolve = async () => {
    const content = await getContentRef.current?.();
    if (!content || !(content.markdown || "").trim()) {
      throw new Error("Nothing to export — this note is empty.");
    }
    return content;
  };

  const exportMarkdown = async (getContent) => {
    getContentRef.current = getContent;
    try {
      exportAsMarkdown(await resolve());
    } catch (err) {
      toast.error(err.message || "Export failed");
    } finally {
      getContentRef.current = null;
    }
  };

  const openPdfDialog = async (getContent) => {
    getContentRef.current = getContent;
    try {
      const { title } = await resolve();
      setPdfName(title || "");
      setPdfOpen(true);
    } catch (err) {
      // Only the failure path clears: on success the dialog's confirm handler
      // is the next reader of this ref.
      getContentRef.current = null;
      toast.error(err.message || "Export failed");
    }
  };

  // Resolves before opening, exactly like the other two. Without it the user
  // types a passphrase twice and only then finds out the note was empty — and
  // the sidebar can't pre-check, because all it holds is ciphertext.
  const openHwriteDialog = async (getContent) => {
    getContentRef.current = getContent;
    try {
      await resolve();
      setHwriteOpen(true);
    } catch (err) {
      getContentRef.current = null;
      toast.error(err.message || "Export failed");
    }
  };

  const handlePdf = async (fileName) => {
    setPdfOpen(false);
    setExporting(true);
    const toastId = toast.loading("Generating PDF…");
    try {
      // `imageKey` comes back from the same resolver as the plaintext, so it
      // is re-derived at confirm time too: a lock between opening the dialog
      // and confirming makes `resolve()` throw before any key is handed on.
      const { title, markdown, imageKey } = await resolve();
      await exportAsPdf({ title, markdown, fileName, imageKey });
      toast.success("PDF downloaded!", { id: toastId });
    } catch (err) {
      console.error("[pdf export] failed:", err);
      toast.error("PDF export failed", { id: toastId });
    } finally {
      getContentRef.current = null;
      setExporting(false);
    }
  };

  const handleHwrite = async ({ encrypted, passphrase }) => {
    setHwriteOpen(false);
    try {
      const { title, markdown, imageKey } = await resolve();
      const filename = await exportAsHwrite({
        title,
        markdown,
        encrypted,
        passphrase,
        imageKey,
      });
      toast.success(
        encrypted ? `Exported encrypted ${filename}` : `Exported ${filename}`,
      );
    } catch (err) {
      toast.error(err.message || "Export failed");
    } finally {
      getContentRef.current = null;
    }
  };

  const dialogs = (
    <>
      {hwriteOpen && (
        <HwriteExportDialog onConfirm={handleHwrite} onCancel={close} />
      )}
      {pdfOpen && (
        <PdfExportDialog
          defaultName={pdfName}
          onConfirm={handlePdf}
          onCancel={close}
        />
      )}
    </>
  );

  return {
    exporting,
    exportMarkdown,
    openPdfDialog,
    openHwriteDialog,
    close,
    dialogs,
  };
};
