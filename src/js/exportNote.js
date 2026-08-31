// Callable export handlers for a single note. Extracted from the old
// ExportNotes toolbar component so the same three actions can be driven from a
// menu (or anywhere else) without dragging a UI along.
//
// All three take already-decrypted content: nothing here decides whether the
// caller is allowed to see the plaintext. `.md` and PDF leave HushWrite's
// encryption entirely — the callers state that in the menu.
import { serializeNote, downloadHwrite } from "./hwrite";
import { exportNotePdf } from "./notePdf";

const cleanFileName = (name) =>
  (name || "note").replace(/[\\/:*?"<>|\n\r\t]/g, "").trim() || "note";

const slugify = (name) =>
  (name || "note").replace(/[^a-z0-9]/gi, "_").toLowerCase();

// Plain markdown — unencrypted.
export const exportAsMarkdown = ({ title, markdown }) => {
  const blob = new Blob([markdown || ""], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(title)}.md`;
  a.click();
  URL.revokeObjectURL(url);
};

// PDF — unencrypted. Resolves once the file has been handed to the browser.
export const exportAsPdf = async ({ title, markdown, fileName }) => {
  await exportNotePdf({
    title: title || "Untitled",
    markdown: markdown || "",
    fileName: cleanFileName(fileName || title),
  });
};

// .hwrite — stays encrypted under the passphrase the user picks, so it is the
// only one of the three that keeps the note protected outside the app.
export const exportAsHwrite = async ({
  title,
  markdown,
  encrypted,
  passphrase,
}) => {
  const blob = await serializeNote(
    { title, markdown },
    { encrypted, passphrase },
  );
  return downloadHwrite(blob, title);
};
