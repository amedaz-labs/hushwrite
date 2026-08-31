import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import MilkdownEditor from "./MilkdownEditor.jsx";
import Preview from "./Preview.jsx";
import NoteActionsMenu from "./NoteActionsMenu.jsx";
import { useNoteExports } from "@/hooks/useNoteExports";
import PassphraseModal from "./PassPhraseModal.jsx";
import DeleteModal from "./DeleteModal.jsx";
import AIActionsMenu from "./AIActionsMenu.jsx";
import AISettingsDialog from "./AISettingsDialog.jsx";
import NoteInfoDialog from "./NoteInfoDialog.jsx";
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderPlus,
  Info,
  KeyRound,
  Lock,
  LockOpen,
  MoreHorizontal,
  PenLine,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getNote,
  deleteNote as dbDeleteNote,
  deleteImage,
  getAllNotes,
} from "../js/db";
import { deriveKey, decryptContent } from "../js/crypto";

import { useModalQueue } from "@/hooks/useModalQueue";
import { useNoteSession } from "@/hooks/useNoteSession";
import { useFolders } from "@/lib/folders";

const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

// A locked note older than 30 days can be deleted without a passphrase; younger
// ones force a verify to prevent casual wipes. Module scope, like the sidebar's
// copy (NoteList.jsx) — `handleDelete` reads it above the const's old in-body
// declaration, which only worked because that handler never runs during render.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const Dot = ({ className }) => (
  <span
    aria-hidden="true"
    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", className)}
  />
);

const PILL =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium";

// The FAB is gone: autosave already runs at 1500 ms, so a permanent floating
// "Save" button was shouting about a problem that mostly doesn't exist. This is
// a quiet status that only becomes a button when the document is actually dirty.
const SaveStatus = ({ status, needsTitle, shortcut, onSave }) => {
  // `persistNote` refuses to write without a title, so a body-only note can
  // never save. Say that instead of leaving the user with a status that never
  // moves (or, worse, one that still reads "Saved").
  if (needsTitle) {
    return (
      <span
        className={cn(PILL, "cursor-default text-warn")}
        title="A note needs a title before it can be encrypted and saved."
      >
        <Dot className="bg-warn" />
        Add a title to save
      </span>
    );
  }

  switch (status) {
    case "saving":
      return (
        <span className={cn(PILL, "text-outline")}>
          <Dot className="animate-pulse bg-vault-primary" />
          Saving…
        </span>
      );
    case "saved":
      return (
        <span className={cn(PILL, "text-outline")}>
          <Dot className="bg-ok" />
          Saved
        </span>
      );
    case "dirty":
      return (
        <button
          onClick={onSave}
          title={`Save now (${shortcut})`}
          className={cn(PILL, "bg-warn/15 text-warn transition-colors hover:bg-warn/25")}
        >
          <Dot className="animate-pulse bg-warn" />
          Unsaved · {shortcut}
        </button>
      );
    default:
      // "idle" and "locked" both render nothing.
      return null;
  }
};

const formatMetaDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 60 * 24) {
    const h = Math.floor(diffMin / 60);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

const QuickAction = ({ icon, title, subtitle, onClick }) => {
  const Glyph = icon;
  return (
    <button
    onClick={onClick}
    className="flex items-center gap-3 rounded-xl border border-transparent bg-surface-container-low px-3 py-2.5 text-left transition-colors hover:border-outline-variant/70 hover:bg-surface-container active:scale-[0.99]"
  >
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-on-surface-variant">
      <Glyph className="h-4 w-4" strokeWidth={1.7} />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] font-semibold tracking-tight text-on-surface">
        {title}
      </span>
      <span className="mt-px block text-[11.5px] text-outline">{subtitle}</span>
    </span>
    </button>
  );
};

const isQuietError = (err) =>
  err?.message === "cancelled" || err?.message === "superseded";

// Walk the markdown source line-by-line and assign every line a "block
// index" — top-level chunks separated by blank lines, with fenced code
// treated as a single block. Milkdown renders one DOM child per such
// block, so the index lets us map a textarea line to a Milkdown node and
// vice-versa without parsing the doc.
const buildLineBlockMap = (markdown) => {
  const lines = (markdown || "").split("\n");
  const lineToBlock = new Array(lines.length || 1).fill(0);
  const blockStartLine = [0];
  let block = -1;
  let prevEmpty = true;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isFenceMarker = trimmed.startsWith("```");
    if (isFenceMarker && !inFence) {
      block++;
      blockStartLine[block] = i;
      inFence = true;
      prevEmpty = false;
    } else if (isFenceMarker && inFence) {
      inFence = false;
      prevEmpty = false;
    } else if (inFence) {
      // stay in current block
    } else if (!trimmed) {
      prevEmpty = true;
    } else if (prevEmpty) {
      block++;
      blockStartLine[block] = i;
      prevEmpty = false;
    }
    lineToBlock[i] = Math.max(0, block);
  }
  return { lineToBlock, blockStartLine };
};

const stripBrLines = (md) =>
  (md || "").replace(/^\s*<br\s*\/?>\s*$/gim, "");

const findEditorBlockEls = (host) => {
  if (!host) return [];
  const pm = host.querySelector(".ProseMirror");
  if (!pm) return [];
  return Array.from(pm.children).filter((el) => {
    if (el.classList?.contains("ProseMirror-trailingBreak")) return false;
    if (
      el.tagName === "P" &&
      !el.textContent.trim() &&
      el.querySelector(":scope > br")
    ) {
      return false;
    }
    return true;
  });
};

const Markdown = ({
  selectedNote,
  markdown,
  setMarkdown,
  currentId,
  setCurrentId,
  title,
  setTitle,
  notes = [],
  setNotes,
  titleCache = {},
  onLockRef,
  onIsUnlockedRef,
  onSaveBeforeNewRef,
  onNoteDeletedRef,
  activeFolderId = null,
  isComposingNew = false,
  // The empty state's quick actions. "New folder" and "Import" are owned by
  // NoteList, so App holds the two small pieces and hands them to both.
  onNewNote,
  onNewFolder,
  onImport,
}) => {
  const editorContainerRef = useRef(null);
  const editorScrollRef = useRef(null);
  const previewScrollRef = useRef(null);
  const syncingScrollRef = useRef(false);
  const lineMapRef = useRef({ lineToBlock: [0], blockStartLine: [0] });

  useEffect(() => {
    // Build the map from the cleaned markdown so textarea line numbers
    // (which never see <br /> filler) map onto the same blocks the editor
    // shows.
    lineMapRef.current = buildLineBlockMap(stripBrLines(markdown));
  }, [markdown]);

  const PREVIEW_LINE_HEIGHT = 22.75;

  const scrollEditorToLine = (line) => {
    const host = editorContainerRef.current;
    const scroller = editorScrollRef.current;
    if (!host || !scroller) return;
    const blocks = findEditorBlockEls(host);
    if (!blocks.length) return;
    const { lineToBlock } = lineMapRef.current;
    const idx = Math.min(
      blocks.length - 1,
      Math.max(0, lineToBlock[Math.max(0, line - 1)] ?? 0),
    );
    const el = blocks[idx];
    if (!el) return;
    const containerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target =
      scroller.scrollTop + (elRect.top - containerRect.top) - 120;
    syncingScrollRef.current = true;
    scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  const scrollPreviewToBlock = (blockIdx) => {
    const ta = previewScrollRef.current;
    if (!ta) return;
    const { blockStartLine } = lineMapRef.current;
    const line =
      blockStartLine[Math.min(blockStartLine.length - 1, blockIdx)] ?? 0;
    const target = line * PREVIEW_LINE_HEIGHT - 80;
    syncingScrollRef.current = true;
    ta.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  };

  // Move the caret from the title field into the editor body (Enter in the
  // title should drop into the first paragraph, like Notion / Apple Notes).
  const focusEditor = () => {
    const host = editorContainerRef.current;
    const pm = host?.querySelector(".ProseMirror");
    if (!pm) return;
    pm.focus();
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(pm);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const handleEditorClick = (e) => {
    const host = editorContainerRef.current;
    if (!host) return;
    const blocks = findEditorBlockEls(host);
    if (!blocks.length) return;
    let node = e.target;
    while (node && node !== host && !blocks.includes(node)) node = node.parentNode;
    if (!node || node === host) return;
    const idx = blocks.indexOf(node);
    if (idx < 0) return;
    scrollPreviewToBlock(idx);
  };
  const [showPreview, setShowPreview] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiSnapshot, setAiSnapshot] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // Which card of the info dialog the menu item that opened it was actually
  // asking for. Null = plain "Note info".
  const [infoSection, setInfoSection] = useState(null);
  const openInfo = (section = null) => {
    setInfoSection(section);
    setInfoOpen(true);
  };
  const folders = useFolders();
  // Owned here, not inside the menu: a dialog must outlive the menu that
  // opened it.
  const noteExports = useNoteExports();

  const { modal, open: openModal } = useModalQueue();
  const askPassphrase = (mode, extra = {}) =>
    openModal({ type: "passphrase", mode, ...extra });
  const askDeleteConfirm = (opts = {}) =>
    openModal({ type: "delete", ...opts });

  const {
    saveStatus,
    unlockError,
    isUnlocked,
    getSessionKey,
    adoptSessionKey,
    lock,
    unlockCurrent,
    switchToNote,
    saveManual,
    saveBeforeLeaving,
    changePassphrase,
    deleteCurrent,
    deleteFolderNote,
    forceDeleteCurrent,
    finalizeDelete,
  } = useNoteSession({
    markdown,
    title,
    currentId,
    setMarkdown,
    setTitle,
    setCurrentId,
    setNotes,
    askPassphrase,
    folders,
    activeFolderId,
  });

  // The folder that owns the note currently in the editor (null for a root
  // note with its own passphrase). A saved note answers for itself; only an
  // unsaved draft falls back to wherever the sidebar is pointing.
  const openNote = notes.find((n) => n.id === currentId);
  const noteFolderId = openNote ? openNote.folderId || null : activeFolderId;
  const noteFolder = folders.folders.find((f) => f.id === noteFolderId) || null;

  // Expose lock + unlock-state to TopNav via refs passed from App. The global
  // Lock button drops every folder key too, not just this note's session.
  useEffect(() => {
    if (onLockRef)
      onLockRef.current = async () => {
        await lock();
        folders.lockAll();
      };
    if (onIsUnlockedRef) onIsUnlockedRef.current = isUnlocked;
    if (onSaveBeforeNewRef) onSaveBeforeNewRef.current = saveBeforeLeaving;
    // A row-level delete in the sidebar has to run the hook's own teardown —
    // clearing App state alone leaves the session key, salt, folder id and the
    // decrypted `lastSaved` snapshot pointing at a note that no longer exists.
    if (onNoteDeletedRef) onNoteDeletedRef.current = finalizeDelete;
  });

  useEffect(() => {
    if (!currentId) setTitle("");
  }, [currentId, setTitle]);

  useEffect(() => {
    if (!selectedNote) return;
    (async () => {
      try {
        await switchToNote(selectedNote);
        if (!selectedNote.folderId) toast.success("Note unlocked");
      } catch (err) {
        if (!isQuietError(err) && err?.message) {
          /* surfaced inside locked card */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNote]);

  const wordCount = useMemo(() => {
    const text = (markdown || "").replace(/[#*`>_\-[\]()!]/g, " ").trim();
    if (!text) return 0;
    return text.split(/\s+/).length;
  }, [markdown]);

  const onSave = async () => {
    if (!markdown.trim()) return toast.error("Empty note!");
    if (!title.trim()) return toast.error("Please enter a note title!");
    try {
      const result = await saveManual();
      toast.success(result === "encrypted" ? "Encrypted & saved" : "Saved");
    } catch (err) {
      if (!isQuietError(err)) toast.error(err.message);
    }
  };

  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const saveShortcut = isMac ? "⌘S" : "Ctrl+S";

  // ~200 wpm is the usual reading-speed assumption; a note is never "0 min".
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 200));
  // Body but no title: `persistNote` will refuse, and `saveStatus` won't even
  // move to "dirty" (it bails before setting it), so the pill has to be driven
  // off the actual condition rather than off the status.
  const missingTitle = !!markdown.trim() && !title.trim();

  // Cmd/Ctrl+S → save the current note (intercepts the browser's "Save Page"
  // dialog). Copy / cut / paste / undo / redo are handled natively by the
  // textarea and the Milkdown editor — no rebinding needed here.
  useEffect(() => {
    const handler = (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (saveStatus === "locked") return;
        onSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveStatus, markdown, title, currentId, isMac]);

  const handleDelete = async () => {
    if (!currentId) return toast.error("No note selected!");
    try {
      const note = await getNote(currentId);
      if (!note) throw new Error("Note not found");
      const ageMs = note.createdAt
        ? Date.now() - new Date(note.createdAt).getTime()
        : 0;
      const canForceDelete = ageMs >= THIRTY_DAYS_MS;

      if (!isUnlocked()) {
        // Locked: no passphrase on hand; only the 30-day grace path can
        // proceed. The dialog shows a confirm-only state with the escape
        // hatch when eligible.
        await askDeleteConfirm({
          requirePassphrase: false,
          canForceDelete,
        });
        if (!canForceDelete) {
          throw new Error(
            "Unlock the note to delete it, or wait until it's 30 days old.",
          );
        }
        if (note.imageIds?.length) {
          await Promise.all(note.imageIds.map((id) => deleteImage(id)));
        }
        await dbDeleteNote(currentId);
        setMarkdown("");
        setTitle("");
        setCurrentId(null);
        setNotes(await getAllNotes());
      } else if (note.folderId) {
        // The folder key already authorized this note — confirm only.
        await askDeleteConfirm({ requirePassphrase: false });
        await deleteFolderNote();
      } else {
        // Unlocked root note: verify the passphrase inside the dialog so a
        // wrong entry keeps the prompt open with an error, rather than
        // bailing out. The 30-day override is offered inline.
        const result = await askDeleteConfirm({
          requirePassphrase: true,
          canForceDelete,
          verify: async (pw) => {
            const key = await deriveKey(pw, toBytes(note.salt));
            await decryptContent(
              toBytes(note.ciphertext),
              key,
              toBytes(note.iv),
            );
          },
        });
        if (result?.kind === "force") {
          await forceDeleteCurrent();
        } else {
          // Passphrase was already verified inside the modal; deleteCurrent
          // re-verifies defensively but we can safely pass the passphrase.
          await deleteCurrent(result.passphrase);
        }
      }
      toast.success("Note deleted!");
    } catch (err) {
      if (!isQuietError(err)) toast.error(err.message || "Delete failed");
    }
  };

  const isLocked = saveStatus === "locked" && !!currentId && !isUnlocked();

  const noteCreatedAt = openNote?.createdAt
    ? new Date(openNote.createdAt)
    : null;
  const noteAgeMs = noteCreatedAt ? Date.now() - noteCreatedAt.getTime() : 0;
  const canDeleteWithoutUnlock = noteAgeMs >= THIRTY_DAYS_MS;
  const eligibleDeleteDate = noteCreatedAt
    ? new Date(noteCreatedAt.getTime() + THIRTY_DAYS_MS)
    : null;
  const daysUntilEligible = eligibleDeleteDate
    ? Math.max(0, Math.ceil((eligibleDeleteDate - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  // A live view of the editor's plaintext, NOT a snapshot. `getContent` handed
  // to the export menu must re-read at confirm time, the same way the sidebar's
  // `readNoteContent` re-derives from ciphertext — otherwise a dialog opened
  // before a lock still holds the decrypted body when its handler finally runs.
  const liveContentRef = useRef({ title, markdown, locked: false });
  useEffect(() => {
    liveContentRef.current = { title, markdown, locked: isLocked };
  });
  const readEditorContent = () => {
    const live = liveContentRef.current;
    if (live.locked) throw new Error("Unlock the note to export it.");
    return { title: live.title, markdown: live.markdown };
  };

  // A lock must take every export dialog with it. Leaving one mounted over the
  // locked card lets a click write full plaintext to disk with no passphrase
  // re-entry; `close()` also drops the resolver, so nothing retains the note.
  const closeExports = noteExports.close;
  useEffect(() => {
    if (!isLocked) return;
    closeExports();
  }, [isLocked, closeExports]);

  const [inlinePassphrase, setInlinePassphrase] = useState("");
  const [showInlinePass, setShowInlinePass] = useState(false);

  // This component never unmounts, so a typed-but-unsubmitted passphrase would
  // otherwise follow the user to the next note's locked card — still revealed,
  // still autofocused, one Enter away from being submitted against it. Reset
  // during render rather than in an effect: this is a derived reset, and an
  // effect would render the new note's card once with the old passphrase in it.
  const [passphraseFor, setPassphraseFor] = useState(currentId);
  if (passphraseFor !== currentId) {
    setPassphraseFor(currentId);
    setInlinePassphrase("");
    setShowInlinePass(false);
  }
  const [unlockPending, setUnlockPending] = useState(false);
  const [leakOpen, setLeakOpen] = useState(false);

  // How many notes one folder passphrase actually opens — stated on the card
  // rather than left for the user to infer.
  const folderNoteCount = noteFolderId
    ? notes.filter((n) => n.folderId === noteFolderId).length
    : 0;

  // Re-arm the passphrase promise whenever the note is locked AND there's
  // no pending modal AND no in-flight unlock attempt. This covers:
  //   - entering the locked state for the first time
  //   - retrying after a wrong-passphrase error
  // It does NOT fire while a key derivation is in progress.
  useEffect(() => {
    if (!isLocked) return;
    if (modal) return;
    if (unlockPending) return;
    unlockCurrent().catch(() => {
      /* unlockError surfaced inline */
    });
  }, [isLocked, modal, unlockPending, unlockCurrent]);

  // If we leave the locked context (e.g. user clicked "New Note" while a
  // passphrase prompt was pending), cancel the stale decrypt promise so
  // the modal dismisses and doesn't bleed into the next screen.
  useEffect(() => {
    if (!isLocked && modal?.type === "passphrase" && modal.mode === "decrypt") {
      modal.cancel?.();
    }
  }, [isLocked, modal]);

  // Clear the pending flag once the attempt resolves (success → isLocked
  // flips off; failure → unlockError updates). The re-arm effect will then
  // open a fresh prompt only if we're still locked.
  const prevUnlockError = useRef(unlockError);
  useEffect(() => {
    if (!unlockPending) return;
    if (!isLocked || unlockError !== prevUnlockError.current) {
      prevUnlockError.current = unlockError;
      setUnlockPending(false);
    }
  }, [isLocked, unlockError, unlockPending]);

  const handleInlineUnlock = (e) => {
    e?.preventDefault?.();
    if (!inlinePassphrase) return;
    prevUnlockError.current = unlockError;
    setUnlockPending(true);
    modal?.confirm?.(inlinePassphrase);
    setInlinePassphrase("");
    // Back to masked on every submit — a revealed field must not survive into
    // the retry after a wrong passphrase.
    setShowInlinePass(false);
  };

  // Suppress the passphrase modal for decrypt mode while locked —
  // the inline form in the locked card handles it instead.
  const suppressPassphraseModal =
    modal?.type === "passphrase" && modal.mode === "decrypt" && isLocked;

  const hasNoteOpen = !!currentId || isComposingNew;

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-surface">
      {modal?.type === "passphrase" && !suppressPassphraseModal && (
        <PassphraseModal
          mode={modal.mode}
          folderName={modal.folderName}
          noteCount={
            modal.folderId
              ? notes.filter((n) => n.folderId === modal.folderId).length
              : 0
          }
          onConfirm={modal.confirm}
          onCancel={modal.cancel}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteModal
          requirePassphrase={modal.requirePassphrase}
          canForceDelete={modal.canForceDelete}
          verify={modal.verify}
          onConfirm={(value) => modal.confirm(value)}
          onCancel={modal.cancel}
        />
      )}
      <AISettingsDialog
        open={aiSettingsOpen}
        onOpenChange={setAiSettingsOpen}
      />
      <NoteInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        focusSection={infoSection}
        markdown={markdown}
        title={title}
        folderName={noteFolder?.name || null}
        isUnlocked={isUnlocked()}
        onChangePassphrase={changePassphrase}
        canMove={isUnlocked() && !!currentId}
        folders={folders.folders}
        currentFolderId={noteFolderId || null}
        isFolderUnlocked={folders.isFolderUnlocked}
        onMoveNote={async (targetFolderId, newPassphrase) => {
          const result = await folders.moveNoteToFolder(
            currentId,
            targetFolderId,
            { sourceKey: getSessionKey(), newPassphrase },
          );
          // Keep editing without a re-unlock: the note now answers to the
          // destination's key.
          if (result) {
            adoptSessionKey(result.key, result.salt, targetFolderId || null);
          }
          setNotes(await getAllNotes());
        }}
      />
      {/* Gated on `!isLocked` for the same reason export itself is: a dialog
          that outlives the lock is a plaintext leak, not a convenience. */}
      {!isLocked && noteExports.dialogs}

      {!hasNoteOpen ? (
        // The empty state does work: it names the one thing people get wrong —
        // note vs. folder passphrase scope — right where they decide.
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-[400px] text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-container text-outline">
              <PenLine className="h-8 w-8" strokeWidth={1.4} />
            </div>
            <h3 className="mb-1.5 text-[17px] font-semibold tracking-tight text-on-surface">
              Nothing open
            </h3>
            <p className="mb-5 text-[13.5px] leading-relaxed text-outline">
              Pick a note from the left, or start something new.
            </p>
            <div className="flex flex-col gap-1.5 text-left">
              <QuickAction
                icon={Plus}
                title="New note"
                subtitle={
                  noteFolder
                    ? `Goes in "${noteFolder.name}" · shared passphrase`
                    : "Its own passphrase"
                }
                onClick={onNewNote}
              />
              <QuickAction
                icon={FolderPlus}
                title="New folder"
                subtitle="One passphrase for everything inside"
                onClick={onNewFolder}
              />
              <QuickAction
                icon={Upload}
                title="Import .hwrite"
                subtitle="A single note or a whole folder bundle"
                onClick={onImport}
              />
            </div>
            <p className="mt-6 flex items-center justify-center gap-1.5 text-[11.5px] text-outline">
              <ShieldCheck className="h-4 w-4 shrink-0 text-ok" strokeWidth={1.7} />
              Your note text is encrypted on this device before it's stored.
            </p>
          </div>
        </div>
      ) : (
      <>
      {/* Toolbar / status bar */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-outline-variant/55 px-3 md:pl-5 md:pr-3.5">
        {/* Breadcrumb — says which lock you are inside. */}
        <nav className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-outline">
          {noteFolder && (
            <>
              <span className="flex min-w-0 items-center gap-1.5">
                <Folder className="h-[15px] w-[15px] shrink-0" strokeWidth={1.7} />
                <span className="max-w-[9rem] truncate">{noteFolder.name}</span>
              </span>
              <span className="opacity-50">/</span>
            </>
          )}
          <span className="max-w-[8rem] truncate font-medium text-on-surface-variant sm:max-w-[16rem] md:max-w-[18rem]">
            {title?.trim() || "Untitled"}
          </span>
        </nav>

        <span className="flex-1" />

        {!isLocked && (
          <>
            <SaveStatus
              status={saveStatus}
              needsTitle={missingTitle}
              shortcut={saveShortcut}
              onSave={onSave}
            />
            <span className="hidden shrink-0 px-0.5 text-[11.5px] tabular-nums text-outline md:inline">
              {wordCount.toLocaleString()} words · {readingMinutes} min
            </span>
            {/* The divider that used to live here rendered even when
                AIActionsMenu returns null (AI unsupported/disabled), leaving a
                floating separator. It is drawn by AIActionsMenu itself now, so
                the two appear and disappear together. */}
            <AIActionsMenu
              markdown={markdown}
              setMarkdown={setMarkdown}
              title={title}
              setTitle={setTitle}
              folderNote={!!noteFolderId}
              onOpenSettings={() => setAiSettingsOpen(true)}
              onSnapshot={(snapshot) => setAiSnapshot(snapshot)}
              disabled={!!aiSnapshot}
            />
            <button
              onClick={() => setShowPreview((v) => !v)}
              title={showPreview ? "Hide markdown" : "Show markdown"}
              aria-label="Toggle markdown view"
              aria-pressed={showPreview}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                showPreview
                  ? "bg-surface-container-high text-on-surface"
                  : "text-outline hover:bg-surface-container hover:text-on-surface",
              )}
            >
              <Eye className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
            {/* Export used to own the most valuable strip on screen for a
                once-a-week action. It lives in here now, with note info,
                move, change passphrase and delete. */}
            <NoteActionsMenu
              trigger={
                <button
                  aria-label="Note actions"
                  title="More"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container hover:text-on-surface data-[state=open]:bg-surface-container-high data-[state=open]:text-on-surface"
                >
                  <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.9} />
                </button>
              }
              getContent={readEditorContent}
              noteExports={noteExports}
              canExport={!!markdown.trim()}
              exportDisabledReason="Nothing written yet"
              onInfo={currentId ? () => openInfo() : undefined}
              onMove={
                isUnlocked() && currentId ? () => openInfo("move") : undefined
              }
              onChangePassphrase={
                isUnlocked() && currentId && !noteFolderId
                  ? () => openInfo("passphrase")
                  : undefined
              }
              onDelete={currentId ? handleDelete : undefined}
            />
          </>
        )}
      </div>

      {/* Body */}
      {isLocked ? (
        <div className="flex flex-1 items-center justify-center p-4 md:p-8">
          <form
            onSubmit={handleInlineUnlock}
            className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl bg-surface-container-low p-6 text-center md:p-10"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-vault-primary/15 text-vault-primary">
              {noteFolder ? (
                <Folder className="h-8 w-8" strokeWidth={1.4} />
              ) : (
                <Lock className="h-8 w-8" strokeWidth={1.4} />
              )}
            </div>

            {/* Scope, stated rather than inferred: the single thing people
                misread about this model is what a passphrase covers. */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-[11.5px] font-medium text-on-surface-variant">
              {noteFolder ? (
                <>
                  <KeyRound className="h-[15px] w-[15px] shrink-0" strokeWidth={1.7} />
                  Unlocks all {folderNoteCount} note
                  {folderNoteCount === 1 ? "" : "s"} in this folder
                </>
              ) : (
                <>
                  <FileText className="h-[15px] w-[15px] shrink-0" strokeWidth={1.7} />
                  This note has its own passphrase
                </>
              )}
            </span>

            <div className="space-y-1">
              {titleCache[currentId] && !noteFolder && (
                <p className="text-xs font-semibold uppercase tracking-widest text-vault-primary">
                  {titleCache[currentId]}
                </p>
              )}
              {/* Focus stays in the passphrase field on a failed attempt, so
                  without a live region the "Wrong passphrase" swap is silent to
                  a screen-reader user — they get no signal at all that the
                  submit did anything. */}
              <div aria-live="polite" className="space-y-1">
                <h3 className="text-lg font-semibold tracking-tight text-on-surface">
                  {unlockError
                    ? "Wrong passphrase"
                    : noteFolder
                      ? `Unlock “${noteFolder.name}”`
                      : "This note is locked"}
                </h3>
                <p className="text-sm text-on-surface-variant">
                  {unlockError
                    ? noteFolder
                      ? "That passphrase didn't unlock this folder. Try again."
                      : "That passphrase didn't unlock this note. Try again."
                    : noteFolder
                      ? "Stays unlocked for 15 minutes of activity."
                      : "Enter your passphrase to continue where you left off."}
                </p>
              </div>
            </div>
            {/* Reveal toggle. Same reasoning as the folder unlock form: this is
                the highest-stakes field in the app, and on a phone a typo is
                indistinguishable from a forgotten passphrase. */}
            <div className="relative w-full">
              <input
                type={showInlinePass ? "text" : "password"}
                autoFocus
                value={inlinePassphrase}
                onChange={(e) => setInlinePassphrase(e.target.value)}
                placeholder="Passphrase"
                className={cn(
                  "w-full rounded-lg border bg-surface-container py-2.5 pl-4 pr-11 text-base text-on-surface placeholder-outline transition-all focus:outline-none sm:text-sm",
                  unlockError
                    ? "border-error/60 focus:border-error"
                    : "border-outline/85 focus:border-vault-primary/60",
                )}
              />
              <button
                type="button"
                onClick={() => setShowInlinePass((v) => !v)}
                aria-label={
                  showInlinePass ? "Hide passphrase" : "Show passphrase"
                }
                className="absolute right-0.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-outline transition-colors hover:text-on-surface"
              >
                {showInlinePass ? (
                  <EyeOff className="h-4 w-4" strokeWidth={1.7} />
                ) : (
                  <Eye className="h-4 w-4" strokeWidth={1.7} />
                )}
              </button>
            </div>
            <button
              type="submit"
              disabled={!inlinePassphrase}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-5 py-2.5 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LockOpen className="h-4 w-4" strokeWidth={1.9} />
              {noteFolder ? "Unlock folder" : "Unlock note"}
            </button>

            {/* What a locked folder still leaks. This is a security claim, so
                it must match what the store actually holds in the clear and
                claim nothing more:
                  - folder records keep `name` in plaintext (db.js / CLAUDE.md)
                  - note records keep `createdAt` / `updatedAt` in plaintext
                  - note records ALSO keep the real plaintext `title` beside the
                    encrypted pair, on EVERY save including autosave
                    (useNoteSession.js:149 `persistNote`, :418
                    `changePassphrase`), and backup.js:131 `noteToWire` uploads
                    it to the server. Five writers do pass `title: ""`
                    (NoteList.jsx:300, :476, :1073; folders.jsx:279
                    `changeFolderPassphrase`, :388 `moveNoteToFolder`) — but a
                    single autosave afterwards puts the plaintext title back, so
                    they only narrow the window, never close it. One writer is
                    worse than the default: NoteList.jsx:1002 stores an imported
                    encrypted envelope with `title: parsed.title` in the CLEAR
                    and no ciphertext pair at all, so that title is the only
                    copy there is. Titles are therefore READABLE, not
                    protected — do not soften this copy unless every one of
                    those writers changes first.
                  - image blobs in the `images` store are NOT encrypted
                    (hwrite.js saves them raw; IdbImage renders them with no
                    key; backup.js uploads them base64'd)
                Only the note body ciphertext is actually protected. Do not
                widen this list without changing the code first. */}
            {noteFolder && (
              <div className="w-full">
                <button
                  type="button"
                  onClick={() => setLeakOpen((v) => !v)}
                  aria-expanded={leakOpen}
                  className="mx-auto flex items-center gap-1.5 text-[11.5px] text-outline transition-colors hover:text-on-surface-variant"
                >
                  <Info className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                  What's visible while this folder is locked
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-transform",
                      leakOpen && "rotate-180",
                    )}
                    strokeWidth={1.9}
                  />
                </button>
                {leakOpen && (
                  <div className="mt-2.5 space-y-2 rounded-lg bg-surface-container p-3 text-left text-[11.5px] leading-snug text-outline">
                    <p>
                      <b className="text-on-surface-variant">
                        Readable without the passphrase:
                      </b>{" "}
                      the folder name, how many notes it holds, the title of
                      every note, when each was last edited, and any images
                      inside a note.
                    </p>
                    <p>
                      <b className="text-ok">Never readable:</b> the text of
                      your notes.
                    </p>
                  </div>
                )}
              </div>
            )}

            {canDeleteWithoutUnlock ? (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1.5 text-xs font-medium text-outline transition-colors hover:text-error"
                title="This note is older than 30 days — can be deleted without a passphrase"
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.7} />
                Delete without unlocking
              </button>
            ) : eligibleDeleteDate ? (
              <p className="max-w-xs text-center text-[11px] leading-snug text-on-surface-variant/80">
                <Info className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]" strokeWidth={1.7} />
                Forgot your passphrase? You'll be able to delete this note
                without it in{" "}
                <span className="font-semibold text-on-surface-variant">
                  {daysUntilEligible} day{daysUntilEligible === 1 ? "" : "s"}
                </span>{" "}
                (on{" "}
                {eligibleDeleteDate.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                ).
              </p>
            ) : null}
          </form>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden md:flex-row">
          {aiSnapshot && (
            <div className="pointer-events-none absolute inset-x-2 top-2 z-30 flex justify-center md:inset-x-auto md:left-1/2 md:top-4 md:-translate-x-1/2">
              <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-vault-primary/30 bg-surface-container px-3 py-2 shadow-2xl shadow-vault-primary/20 sm:gap-3 sm:rounded-full sm:px-4">
                <div className="flex items-center gap-1.5 text-xs font-semibold tracking-tight text-vault-primary">
                  <Sparkles className="h-4 w-4" strokeWidth={1.7} />
                  AI · {aiSnapshot.label}
                </div>
                <span className="hidden h-4 w-px bg-outline-variant/50 sm:block" />
                <button
                  onClick={() => {
                    setMarkdown(aiSnapshot.markdown);
                    setTitle(aiSnapshot.title);
                    setAiSnapshot(null);
                  }}
                  className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-outline transition-all hover:bg-error/10 hover:text-error active:scale-95"
                >
                  <X className="h-4 w-4" strokeWidth={1.9} />
                  Discard
                </button>
                <button
                  onClick={() => setAiSnapshot(null)}
                  className="flex items-center gap-1 rounded-full bg-vault-primary px-3 py-1 text-xs font-semibold text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95"
                >
                  <Check className="h-4 w-4" strokeWidth={1.9} />
                  Accept
                </button>
              </div>
            </div>
          )}
          <div
            ref={editorScrollRef}
            onScroll={(e) => {
              if (syncingScrollRef.current) {
                syncingScrollRef.current = false;
                return;
              }
              const src = e.currentTarget;
              const dst = previewScrollRef.current;
              if (!dst) return;
              const denom = src.scrollHeight - src.clientHeight;
              const ratio = denom > 0 ? src.scrollTop / denom : 0;
              syncingScrollRef.current = true;
              dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
            }}
            className={cn(
              // Milkdown's block drag/plus handle needs ~80px of left gutter
              // (index.css:245-250 pairs `padding-left:80px; margin-left:-80px`
              // on the editor), so the left padding can't shrink below 80px
              // from md up without the handle being clipped by this scroller.
              // The RIGHT side has no such constraint, and 160px of symmetric
              // padding at exactly the width where space is scarcest left the
              // measure at 320px. Keep the gutter, spend the other 48px on
              // text, and go symmetric again at lg where it's affordable.
              // The app is h-[100dvh]; in standalone PWA mode on a notched
              // iPhone the bottom of this scroller sits under the home
              // indicator without the inset.
              "flex min-w-0 flex-col overflow-y-auto px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-8 md:py-12 md:pb-[max(3rem,env(safe-area-inset-bottom))]",
              showPreview
                ? "hidden flex-1 border-outline-variant/55 md:flex md:border-r md:pl-20 md:pr-12"
                : "w-full md:pl-20 md:pr-8 lg:px-20",
              aiSnapshot && "pt-20",
            )}
          >
            {/* One measured column. The measure only applies when the preview
                is closed — beside a 42%-wide preview it would squeeze. */}
            <div
              className={cn(
                "mx-auto w-full",
                !showPreview && "max-w-[42rem]",
              )}
            >
              <input
                type="text"
                placeholder="Untitled"
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value.slice(0, 100))}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    focusEditor();
                  }
                }}
                // A transparent 1px rule, always present, tinted on focus: the
                // title used to be the only control in the app with no focus
                // indicator at all, and reserving the border avoids a reflow.
                className="mb-1.5 w-full border-b border-transparent bg-transparent text-[28px] font-bold leading-tight tracking-[-0.028em] text-on-surface placeholder-outline/60 outline-none focus:border-vault-primary/50 focus:ring-0 md:text-[31px]"
              />
              {/* Meta rule welds the title to the body and says which lock the
                  note is under. */}
              <div className="mb-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-outline-variant/40 pb-4 text-[12px] text-outline md:mb-7">
                {noteFolder ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-semibold text-ok">
                    <LockOpen className="h-3 w-3 shrink-0" strokeWidth={2} />
                    {noteFolder.name}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                    <KeyRound className="h-3 w-3 shrink-0" strokeWidth={2} />
                    Own passphrase
                  </span>
                )}
                {openNote?.updatedAt && (
                  <span>Edited {formatMetaDate(openNote.updatedAt)}</span>
                )}
                {openNote?.updatedAt && openNote?.createdAt && (
                  <span className="opacity-45">·</span>
                )}
                {openNote?.createdAt && (
                  <span>Created {formatMetaDate(openNote.createdAt)}</span>
                )}
                {!openNote && <span>Not saved yet</span>}
              </div>
              <div
                ref={editorContainerRef}
                onClick={handleEditorClick}
                className="milkdown-host"
              >
                <MilkdownEditor
                  markdown={markdown}
                  onChange={(val) => setMarkdown(val || "")}
                />
              </div>
            </div>
          </div>
          {showPreview && (
            <div className="flex w-full min-w-0 flex-col overflow-y-auto bg-surface-container-low p-4 md:w-[42%] md:p-6">
              <Preview
                markdown={markdown}
                onChange={setMarkdown}
                scrollRef={(node) => {
                  previewScrollRef.current = node;
                }}
                onCursorLineChange={scrollEditorToLine}
                onScrollSync={(src) => {
                  if (syncingScrollRef.current) {
                    syncingScrollRef.current = false;
                    return;
                  }
                  const dst = editorScrollRef.current;
                  if (!dst) return;
                  const denom = src.scrollHeight - src.clientHeight;
                  const ratio = denom > 0 ? src.scrollTop / denom : 0;
                  syncingScrollRef.current = true;
                  dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
                }}
              />
            </div>
          )}
        </div>
      )}

      </>
      )}
    </section>
  );
};

export default Markdown;
