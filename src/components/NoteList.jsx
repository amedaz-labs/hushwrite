import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { v4 as uuid4 } from "uuid";
import {
  parseHwrite,
  decryptHwrite,
  hwriteEnvelopeToBytes,
  rehydrateInlineImages,
  isFolderBundle,
  parseFolderPayload,
  serializeFolder,
  downloadHwrite,
} from "../js/hwrite";
import HwriteImportDialog from "./HwriteImportDialog";
import HwriteFolderImportDialog from "./HwriteFolderImportDialog";
import HwriteExportDialog from "./HwriteExportDialog";
import FolderRow from "./FolderRow";
import FolderFormDialog from "./FolderFormDialog";
import TreeRow, { RowMenuTrigger } from "./TreeRow";
import NoteActionsMenu from "./NoteActionsMenu";
import NoteInfoDialog from "./NoteInfoDialog";
import DeleteModal from "./DeleteModal";
import { useNoteExports } from "@/hooks/useNoteExports";
import {
  ChevronDown,
  FileText,
  FolderPlus,
  Lock,
  LockOpen,
  PenLine,
  Plus,
  Upload,
} from "lucide-react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuItemText,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
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
import { useFolders } from "@/lib/folders";
import { decryptContent, deriveKey, encryptContent } from "../js/crypto";
import {
  saveNote,
  getAllNotes,
  getNote,
  deleteImage,
  deleteNote as dbDeleteNote,
} from "../js/db";

// A locked note older than 30 days can be dropped without a passphrase — the
// same escape hatch the editor's locked card offers. Module scope, and read
// only from an event handler: a clock read during render is unstable.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const isForceDeletable = (note) =>
  !!note.createdAt &&
  Date.now() - new Date(note.createdAt).getTime() >= THIRTY_DAYS_MS;

const toBytes = (v) =>
  v instanceof Uint8Array ? v : v ? new Uint8Array(v) : null;

const formatTimestamp = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (diff < 1000 * 60 * 60 * 48) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

// The lock slot every row shares: colour plus one glyph, never doubled.
const LockDot = ({ unlocked }) => (
  <span
    aria-hidden="true"
    className={cn(
      "flex h-4 w-4 shrink-0 items-center justify-center",
      unlocked ? "text-ok" : "text-outline",
    )}
  >
    {unlocked ? (
      <LockOpen className="h-[15px] w-[15px]" strokeWidth={1.7} />
    ) : (
      <Lock className="h-[15px] w-[15px]" strokeWidth={1.7} />
    )}
  </span>
);

// A real heading, not a styled div: these are the only structural landmarks in
// a rail that can run to hundreds of rows, and a screen-reader user navigating
// by heading has nothing else to jump between.
const GroupLabel = ({ children, count }) => (
  <h2 className="flex items-center justify-between px-2 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-[0.09em] text-outline">
    <span>{children}</span>
    <span className="font-semibold tracking-normal opacity-75 tabular-nums">
      {count}
    </span>
  </h2>
);

const NoteList = ({
  open = false,
  notes,
  currentId,
  currentTitle,
  titleCache = {},
  onSelectNote,
  onImportNote,
  onNotesChanged,
  // Called after a row-level delete so App can clear the editor if the note it
  // was pointed at just went away.
  onNoteDeleted,
  onNewNote,
  activeFolderId = null,
  onActiveFolderChange,
  isComposingNew = false,
  isNoteUnlocked = false,
  // Lifted to App so the editor's empty state can trigger the same two
  // entry points this sidebar owns.
  folderDialog = null, // { mode, folderId } | null
  onFolderDialogChange,
  importRequest = 0, // nonce — each bump opens the file picker
}) => {
  const fileInputRef = useRef(null);
  const [importState, setImportState] = useState(null);
  const [folderImportState, setFolderImportState] = useState(null);
  const [exportFolder, setExportFolder] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [folderTitles, setFolderTitles] = useState({});
  const setDialog = (next) => onFolderDialogChange?.(next);
  const dialog = folderDialog;
  const [deleteFolderTarget, setDeleteFolderTarget] = useState(null);
  // Row-level note actions. Every row carries a `⋯`; without these the only
  // way to delete or inspect a note was to open it and wait for it to unlock.
  const [deleteNoteTarget, setDeleteNoteTarget] = useState(null);
  const [infoTarget, setInfoTarget] = useState(null);
  // An import whose destination folder isn't unlocked yet. Flushed by the
  // effect below the moment that folder's key becomes available.
  const [pendingImport, setPendingImport] = useState(null);
  const claimedImportRef = useRef(null);
  // The export dialogs live here, not on a row: a row unmounts its menu when
  // the pointer leaves it, which would take a half-typed passphrase with it.
  const noteExports = useNoteExports();

  const folders = useFolders();
  const {
    folders: folderList,
    unlockedIds,
    lockEpoch,
    isFolderUnlocked,
    getFolderKey,
  } = folders;

  const activeFolder = folderList.find((f) => f.id === activeFolderId) || null;
  // States passphrase scope at creation time — the one thing people misread
  // about the model. Do not drop it.
  const destinationHint = activeFolder
    ? `New notes go in "${activeFolder.name}" · shared passphrase`
    : "New notes carry their own passphrase";

  const byFolder = useMemo(() => {
    const ts = (n) => new Date(n.updatedAt || n.createdAt || 0).getTime();
    const map = new Map();
    for (const note of notes) {
      const key = note.folderId || null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(note);
    }
    for (const list of map.values()) list.sort((a, b) => ts(b) - ts(a));
    return map;
  }, [notes]);

  const rootNotes = byFolder.get(null) || [];

  // The hidden file input lives here (it is the import mechanism), but the
  // editor's empty state offers "Import" too. A nonce bump opens the picker.
  // No state is set, so this stays a pure DOM side effect.
  useEffect(() => {
    if (!importRequest) return;
    fileInputRef.current?.click();
  }, [importRequest]);

  // A locked folder can't take new notes — drop the "new notes go here"
  // pointer as soon as its key goes away.
  useEffect(() => {
    if (activeFolderId && !isFolderUnlocked(activeFolderId)) {
      onActiveFolderChange?.(null);
    }
  }, [activeFolderId, isFolderUnlocked, onActiveFolderChange]);

  // Forget decrypted titles for any folder that locked.
  useEffect(() => {
    setFolderTitles((prev) => {
      const next = {};
      let changed = false;
      for (const [id, t] of Object.entries(prev)) {
        const note = notes.find((n) => n.id === id);
        if (note && (!note.folderId || unlockedIds.includes(note.folderId))) {
          next[id] = t;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [unlockedIds, notes]);

  // Decrypt the titles of every note in every unlocked folder so the tree
  // shows real labels instead of "Encrypted note".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pending = notes.filter(
        (n) =>
          n.folderId &&
          unlockedIds.includes(n.folderId) &&
          n.titleCiphertext &&
          n.titleIv &&
          // `undefined`, not falsy: an empty decrypted title is still done, and
          // a truthiness test would re-decrypt it on every pass forever.
          folderTitles[n.id] === undefined,
      );
      if (pending.length === 0) return;
      const next = {};
      for (const n of pending) {
        const entry = getFolderKey(n.folderId);
        if (!entry) continue;
        try {
          next[n.id] = await decryptContent(
            toBytes(n.titleCiphertext),
            entry.key,
            toBytes(n.titleIv),
          );
        } catch {
          /* skip notes that fail (tampered, or saved under an older key) */
        }
      }
      if (!cancelled && Object.keys(next).length) {
        setFolderTitles((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notes, unlockedIds, getFolderKey, folderTitles]);

  // Flush a deferred import once its destination folder is unlocked.
  useEffect(() => {
    if (!pendingImport) return;
    const entry = getFolderKey(pendingImport.folderId);
    if (!entry) return;
    const pending = pendingImport;
    // Claim it before the first await: a re-run (another folder unlocking
    // mid-flight) must not save a second copy. A ref, because the state clear
    // below only lands after the save has already started. The claim is the
    // opaque token, never the object — the ref outlives the work, and the
    // object carries decrypted markdown that must not survive a lock.
    if (claimedImportRef.current === pending.token) return;
    claimedImportRef.current = pending.token;
    (async () => {
      try {
        const now = new Date().toISOString();
        const { ciphertext, iv } = await encryptContent(
          pending.markdown,
          entry.key,
        );
        const { ciphertext: titleCiphertext, iv: titleIv } =
          await encryptContent(pending.title, entry.key);
        // A lock during the encryption window nulls the claim and tells the
        // user the import was discarded. Honour that instead of writing a note
        // they were told they'd have to re-import.
        if (claimedImportRef.current !== pending.token) return;
        await saveNote({
          id: uuid4(),
          ciphertext,
          iv,
          salt: entry.salt,
          title: "",
          titleCiphertext,
          titleIv,
          imageIds: pending.imageIds || [],
          folderId: pending.folderId,
          createdAt: pending.createdAt || now,
          updatedAt: now,
        });
        claimedImportRef.current = null;
        setPendingImport(null);
        onNotesChanged?.(await getAllNotes());
        toast.success(`"${pending.title}" added`);
      } catch (err) {
        claimedImportRef.current = null;
        setPendingImport(null);
        toast.error(err.message || "Could not import");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImport, unlockedIds]);

  // A deferred import holds decrypted markdown. Locking means no plaintext in
  // memory — including this. The clear is synchronous on purpose: deferring it
  // would leave the markdown alive past the lock.
  useEffect(() => {
    if (!lockEpoch || !pendingImport) return;
    claimedImportRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingImport(null);
    toast("Locked — the pending import was discarded", { icon: "🔒" });
    // Only the lock should trigger this — a pendingImport arriving later is
    // not something the previous lock has any say over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockEpoch]);

  // Same rule for the export dialogs and the row info dialog: a half-finished
  // export outlives its folder key otherwise, and the info dialog is literally
  // holding the note's decrypted markdown.
  const closeExports = noteExports.close;
  useEffect(() => {
    if (!lockEpoch) return;
    closeExports();
    // Synchronous for the same reason the pending-import clear above is: the
    // info dialog is holding decrypted markdown, and it must not survive into
    // one more render than the key did.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInfoTarget(null);
  }, [lockEpoch, closeExports]);

  const toggleFolder = (folder) => {
    setExpanded((prev) =>
      prev.includes(folder.id)
        ? prev.filter((id) => id !== folder.id)
        : [...prev, folder.id],
    );
    if (expanded.includes(folder.id)) {
      if (activeFolderId === folder.id) onActiveFolderChange?.(null);
    } else if (isFolderUnlocked(folder.id)) {
      onActiveFolderChange?.(folder.id);
    }
  };

  const handleUnlockFolder = async (folder, passphrase) => {
    await folders.unlockFolder(folder.id, passphrase);
    setExpanded((prev) =>
      prev.includes(folder.id) ? prev : [...prev, folder.id],
    );
    onActiveFolderChange?.(folder.id);
  };

  const confirmDeleteFolder = async () => {
    const folder = deleteFolderTarget;
    setDeleteFolderTarget(null);
    try {
      await folders.removeFolder(folder.id);
      if (activeFolderId === folder.id) onActiveFolderChange?.(null);
      onNotesChanged?.(await getAllNotes());
      toast.success(`Deleted "${folder.name}"`);
    } catch (err) {
      toast.error(err.message || "Could not delete folder");
    }
  };

  const handleHwriteFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = await parseHwrite(text);
      // A folder bundle takes a different route: it becomes a whole folder,
      // not a note that needs a destination.
      if (isFolderBundle(parsed)) {
        setFolderImportState({ parsed, fileSize: file.size });
      } else {
        setImportState({ parsed, fileSize: file.size });
      }
    } catch (err) {
      toast.error(err.message || "Could not read .hwrite file");
    }
  };

  // Decrypt every note in the folder with the key already in memory, then seal
  // the whole set into one portable file.
  const handleExportFolder = async ({ encrypted, passphrase }) => {
    const folder = exportFolder;
    setExportFolder(null);
    const entry = getFolderKey(folder.id);
    if (!entry) return toast.error("Unlock the folder first.");

    const toastId = toast.loading("Preparing export…");
    try {
      const contained = byFolder.get(folder.id) || [];
      const decrypted = [];
      for (const note of contained) {
        const markdown = await decryptContent(
          toBytes(note.ciphertext),
          entry.key,
          toBytes(note.iv),
        );
        let title = note.title || "Untitled";
        if (note.titleCiphertext && note.titleIv) {
          title = await decryptContent(
            toBytes(note.titleCiphertext),
            entry.key,
            toBytes(note.titleIv),
          );
        }
        decrypted.push({
          title,
          markdown,
          createdAt: note.createdAt,
          modifiedAt: note.updatedAt,
        });
      }

      const blob = await serializeFolder(
        { name: folder.name, notes: decrypted },
        { encrypted, passphrase },
      );
      const filename = downloadHwrite(blob, folder.name);
      toast.success(
        `${decrypted.length} note${decrypted.length === 1 ? "" : "s"} → ${filename}`,
        { id: toastId },
      );
    } catch (err) {
      toast.error(err.message || "Export failed", { id: toastId });
    }
  };

  const handleImportFolder = async ({ name, passphrase }) => {
    const { parsed } = folderImportState;

    let raw;
    try {
      raw = await decryptHwrite(parsed, parsed.encrypted ? passphrase : undefined);
    } catch {
      throw new Error("Wrong passphrase, or the file is corrupted.");
    }
    const incoming = parseFolderPayload(raw);
    if (incoming.length === 0) {
      throw new Error("That folder file has no notes in it.");
    }

    const { folder, key, salt } = await folders.createFolder(name, passphrase);
    const now = new Date().toISOString();
    for (const note of incoming) {
      const { markdown, imageIds } = await rehydrateInlineImages(note.markdown);
      const { ciphertext, iv } = await encryptContent(markdown, key);
      const { ciphertext: titleCiphertext, iv: titleIv } = await encryptContent(
        note.title,
        key,
      );
      await saveNote({
        id: uuid4(),
        ciphertext,
        iv,
        salt,
        title: "",
        titleCiphertext,
        titleIv,
        imageIds,
        folderId: folder.id,
        createdAt: note.createdAt || now,
        updatedAt: note.modifiedAt || now,
      });
    }

    setFolderImportState(null);
    setExpanded((prev) => [...prev, folder.id]);
    onActiveFolderChange?.(folder.id);
    onNotesChanged?.(await getAllNotes());
    toast.success(
      `Imported "${folder.name}" · ${incoming.length} note${incoming.length === 1 ? "" : "s"}`,
    );
  };

  const onFilePick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    handleHwriteFile(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".hwrite")) {
      toast.error("Only .hwrite files can be imported.");
      return;
    }
    handleHwriteFile(file);
  };

  // Resolve the best-known plaintext title for a note. For the active note we
  // prefer the live editor title, but fall back to the session cache when it's
  // empty (the editor title is blanked while we wait for a passphrase — the
  // sidebar label should stay stable across that transition).
  const resolveTitle = (note) => {
    if (note.id === currentId && currentTitle && currentTitle.trim()) {
      return currentTitle;
    }
    return titleCache[note.id] || folderTitles[note.id] || note.title || null;
  };

  // Plaintext for a note the sidebar can already open — i.e. one whose folder
  // key is in memory. Root notes are deliberately not covered: their key only
  // ever exists inside the editor session, so their export lives there.
  const readNoteContent = async (note) => {
    const entry = note.folderId ? getFolderKey(note.folderId) : null;
    if (!entry) throw new Error("Unlock the folder to export this note.");
    const markdown = await decryptContent(
      toBytes(note.ciphertext),
      entry.key,
      toBytes(note.iv),
    );
    let title = note.title || "Untitled";
    if (note.titleCiphertext && note.titleIv) {
      title = await decryptContent(
        toBytes(note.titleCiphertext),
        entry.key,
        toBytes(note.titleIv),
      );
    }
    return { title, markdown };
  };

  // Info for one row. When the sidebar can decrypt the note it shows real
  // stats; when it can't, `markdown: null` tells the dialog to say so rather
  // than report a confident zero.
  // `section` is which card the menu item asked for ("move"), so "Move to
  // folder…" lands on the move card rather than on a word-count grid.
  const openNoteInfo = async (note, section = null) => {
    let content = null;
    if (note.folderId && isFolderUnlocked(note.folderId)) {
      try {
        content = await readNoteContent(note);
      } catch {
        /* fall through to the locked presentation */
      }
    }
    setInfoTarget({
      note,
      section,
      title: content?.title || resolveTitle(note) || "Encrypted note",
      markdown: content ? content.markdown : null,
    });
  };

  const removeNote = async (note) => {
    // FIRST, before anything is destroyed. The editor may be holding this exact
    // record open; this tears its session down and — critically — cancels the
    // pending autosave synchronously. Run after `dbDeleteNote`, a debounce timer
    // already at its deadline could fire in between and `put` the note straight
    // back with a fresh `createdAt` and no image blobs.
    await onNoteDeleted?.(note.id);
    // Re-read rather than trusting the `notes` prop, exactly as every editor
    // delete path does: between a save and the `setNotes` that follows it, the
    // prop's `imageIds` is one save behind, and GC'ing from the stale list
    // orphans the blobs a newer save added — unencrypted, and readable.
    const fresh = (await getNote(note.id)) ?? note;
    if (fresh.imageIds?.length) {
      await Promise.all(fresh.imageIds.map((id) => deleteImage(id)));
    }
    await dbDeleteNote(note.id);
    onNotesChanged?.(await getAllNotes());
    toast.success("Note deleted!");
  };

  // Mirrors the editor's three delete paths: a note in an unlocked folder is
  // already authorized by the folder key (confirm only); anything else has to
  // prove the passphrase, with the 30-day escape hatch offered inline.
  //
  // The age is resolved when the row is clicked, not during render — a clock
  // read while rendering is unstable across re-renders.
  const requestDeleteNote = (note) =>
    setDeleteNoteTarget({ note, canForceDelete: isForceDeletable(note) });
  const deleteAuthorizedByFolder =
    !!deleteNoteTarget?.note.folderId &&
    isFolderUnlocked(deleteNoteTarget.note.folderId);

  const renderNote = (note, indented) => {
    const isActive = note.id === currentId;
    const title = resolveTitle(note);
    // A folder note rides on its folder's key. A root note is only "unlocked"
    // when it is *the* open note — nothing else can have decrypted it.
    const unlocked = note.folderId
      ? isFolderUnlocked(note.folderId)
      : isActive && isNoteUnlocked;
    const displayTitle =
      title && title.trim()
        ? title
        : isActive
          ? "Untitled note"
          : "Encrypted note";
    const encrypted = !title && !isActive;
    const canExport = !!note.folderId && isFolderUnlocked(note.folderId);

    return (
      <TreeRow
        key={note.id}
        indented={indented}
        icon={FileText}
        name={displayTitle}
        selected={isActive}
        dimmed={encrypted}
        title={displayTitle}
        // A note inside a folder is unlocked iff its folder is, and the folder
        // row two pixels above already says so. Repeating the glyph on every
        // child turns a 12-note folder into 13 identical padlocks.
        lock={indented ? null : <LockDot unlocked={unlocked} />}
        meta={formatTimestamp(note.updatedAt || note.createdAt)}
        // EVERY row gets a `⋯`. Delete and info work whether or not the
        // sidebar can read the note; only export needs plaintext, and it says
        // why it's unavailable instead of vanishing. (Dropping the trigger on
        // some rows also left the tree with a ragged right edge.)
        menu={({ onOpenChange }) => (
          <NoteActionsMenu
            onOpenChange={onOpenChange}
            trigger={
              <RowMenuTrigger aria-label={`Actions for ${displayTitle}`} />
            }
            // Closes over CIPHERTEXT and re-derives at confirm time, so a lock
            // between opening the dialog and confirming makes this throw.
            getContent={() => readNoteContent(note)}
            noteExports={noteExports}
            canExport={canExport}
            exportDisabledReason={
              note.folderId
                ? "Unlock the folder to export it"
                : "Unlock the note to export it"
            }
            onInfo={() => openNoteInfo(note)}
            // Moving re-keys the note. Doing that to the note the editor is
            // currently holding open would strand its session key, so the
            // sidebar only offers it for notes it isn't editing.
            onMove={
              canExport && !isActive
                ? () => openNoteInfo(note, "move")
                : undefined
            }
            onDelete={() => requestDeleteNote(note)}
          />
        )}
        onActivate={() => {
          onActiveFolderChange?.(note.folderId || null);
          onSelectNote(note);
        }}
      />
    );
  };

  const dialogFolder = dialog
    ? folderList.find((f) => f.id === dialog.folderId)
    : null;

  const deleteFolderCount = deleteFolderTarget
    ? (byFolder.get(deleteFolderTarget.id) || []).length
    : 0;

  const submitDialog = async ({ name, passphrase }) => {
    if (dialog.mode === "create") {
      const { folder } = await folders.createFolder(name, passphrase);
      setExpanded((prev) => [...prev, folder.id]);
      onActiveFolderChange?.(folder.id);
      toast.success(`Folder "${folder.name}" created`);
      return;
    }
    if (dialog.mode === "rename") {
      await folders.renameFolder(dialog.folderId, name);
      toast.success("Folder renamed");
      return;
    }
    const count = await folders.changeFolderPassphrase(
      dialog.folderId,
      passphrase,
    );
    onNotesChanged?.(await getAllNotes());
    toast.success(
      count
        ? `Passphrase updated · ${count} note${count === 1 ? "" : "s"} re-encrypted`
        : "Passphrase updated",
    );
  };

  return (
    // A landmark, not a bare <section>: this is the app's navigation, and it is
    // the one region a keyboard user needs to be able to skip past — 50 notes is
    // ~106 tab stops before the editor.
    <nav
      aria-label="Notes and folders"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragActive(false);
      }}
      onDrop={onDrop}
      className={cn(
        "invisible absolute inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 -translate-x-full flex-col border-r border-outline-variant/55 bg-surface-container-lowest transition-[transform,visibility] duration-200 ease-out md:visible md:static md:max-w-none md:translate-x-0",
        open && "visible translate-x-0",
        dragActive && "ring-2 ring-vault-primary/60 ring-inset",
      )}
    >
      <div className="flex flex-col gap-1.5 p-2.5 pb-2">
        {/* One primary action, split. The secondary creates live behind the
            caret so they stop outranking the notes themselves. */}
        <div className="flex gap-px">
          <button
            onClick={onNewNote}
            title={destinationHint}
            aria-label={`New note — ${destinationHint}`}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-l-lg bg-vault-primary text-[13px] font-semibold text-on-primary-fixed transition-[filter] hover:brightness-110 active:scale-[0.985]"
          >
            <Plus className="h-[15px] w-[15px]" strokeWidth={2.2} />
            New note
          </button>
          <Menu>
            <MenuTrigger asChild>
              <button
                aria-label="More new items"
                className="flex h-8 w-7 items-center justify-center rounded-r-lg border-l border-on-primary-fixed/20 bg-vault-primary text-on-primary-fixed transition-[filter] hover:brightness-110"
              >
                <ChevronDown className="h-[15px] w-[15px]" strokeWidth={2.2} />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setDialog({ mode: "create" })}>
                <FolderPlus className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
                <MenuItemText
                  label="New folder"
                  hint="One passphrase for everything inside"
                />
              </MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => fileInputRef.current?.click()}>
                <Upload className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
                <MenuItemText
                  label="Import .hwrite…"
                  hint="A single note or a whole folder bundle"
                />
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        {/* The one place the UI states passphrase scope at creation time. */}
        <p className="truncate px-0.5 text-[11px] text-outline">
          {destinationHint}
        </p>
      </div>

      {/* A plain list of rows, not an ARIA tree: nothing here implements the
          arrow-key navigation `role="tree"` promises. See TreeRow. */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {isComposingNew && !currentId && (
          <TreeRow
            icon={FileText}
            name={currentTitle?.trim() || "Untitled"}
            selected
            title="Unsaved draft — save it to encrypt it"
            lock={
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-warn"
              >
                <PenLine className="h-[15px] w-[15px]" strokeWidth={1.7} />
              </span>
            }
            meta="Draft"
          />
        )}

        {folderList.length > 0 && (
          <GroupLabel count={folderList.length}>Folders</GroupLabel>
        )}
        {folderList.map((folder) => {
          const contained = byFolder.get(folder.id) || [];
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              count={contained.length}
              unlocked={isFolderUnlocked(folder.id)}
              expanded={expanded.includes(folder.id)}
              isActive={activeFolderId === folder.id}
              onToggle={() => toggleFolder(folder)}
              onUnlock={(pw) => handleUnlockFolder(folder, pw)}
              onLock={() => folders.lockFolder(folder.id)}
              onRename={() => setDialog({ mode: "rename", folderId: folder.id })}
              onChangePassphrase={() =>
                setDialog({ mode: "passphrase", folderId: folder.id })
              }
              onExport={() => setExportFolder(folder)}
              onDelete={() => setDeleteFolderTarget(folder)}
            >
              {contained.length === 0 ? (
                <p className="py-1 pl-9 text-[12px] italic text-outline">
                  Empty folder
                </p>
              ) : (
                contained.map((note) => renderNote(note, true))
              )}
            </FolderRow>
          );
        })}

        {rootNotes.length > 0 && (
          <GroupLabel count={rootNotes.length}>Notes</GroupLabel>
        )}
        {rootNotes.map((note) => renderNote(note, false))}

        {folderList.length === 0 &&
          rootNotes.length === 0 &&
          !isComposingNew && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <FileText className="h-6 w-6 text-outline" strokeWidth={1.5} />
              <p className="text-xs text-outline">No notes yet</p>
            </div>
          )}
      </div>

      {/* The app is h-[100dvh] and this footer is the last thing in it — in
          standalone PWA mode on a notched iPhone it would otherwise sit under
          the home indicator. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-outline-variant/45 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-outline">
        <span className="truncate">
          {notes.length} note{notes.length === 1 ? "" : "s"} ·{" "}
          {folderList.length} folder{folderList.length === 1 ? "" : "s"}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".hwrite,application/json"
          hidden
          onChange={onFilePick}
        />
      </div>

      {/* Owned by the sidebar, never by a row: a row tears its menu down on
          mouseleave, which would take a half-typed export passphrase with it. */}
      {noteExports.dialogs}

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface/60 text-xs font-medium text-vault-primary backdrop-blur-sm">
          Drop .hwrite file to import
        </div>
      )}

      {dialog && (
        <FolderFormDialog
          key={`${dialog.mode}-${dialog.folderId || "new"}`}
          open
          mode={dialog.mode}
          initialName={dialog.mode === "rename" ? dialogFolder?.name || "" : ""}
          folderName={dialogFolder?.name || ""}
          onSubmit={submitDialog}
          onOpenChange={(v) => !v && setDialog(null)}
        />
      )}

      {deleteFolderTarget && (
        <AlertDialog
          open
          onOpenChange={(v) => !v && setDeleteFolderTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteFolderCount
                  ? `Delete "${deleteFolderTarget.name}" and its ${deleteFolderCount} note${deleteFolderCount === 1 ? "" : "s"}? This can't be undone.`
                  : `Delete the empty folder "${deleteFolderTarget.name}"?`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setDeleteFolderTarget(null)}>
                Cancel
              </AlertDialogCancel>
              <Button variant="destructive" onClick={confirmDeleteFolder}>
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {infoTarget && (
        <NoteInfoDialog
          open
          onOpenChange={(v) => !v && setInfoTarget(null)}
          focusSection={infoTarget.section}
          markdown={infoTarget.markdown}
          title={infoTarget.title}
          folderName={
            folderList.find((f) => f.id === infoTarget.note.folderId)?.name ||
            null
          }
          isUnlocked={infoTarget.markdown !== null}
          canMove={
            infoTarget.markdown !== null && infoTarget.note.id !== currentId
          }
          folders={folderList}
          currentFolderId={infoTarget.note.folderId || null}
          isFolderUnlocked={isFolderUnlocked}
          onMoveNote={async (targetFolderId, newPassphrase) => {
            const entry = getFolderKey(infoTarget.note.folderId);
            await folders.moveNoteToFolder(infoTarget.note.id, targetFolderId, {
              sourceKey: entry?.key,
              newPassphrase,
            });
            onNotesChanged?.(await getAllNotes());
          }}
        />
      )}

      {deleteNoteTarget && (
        <DeleteModal
          requirePassphrase={!deleteAuthorizedByFolder}
          canForceDelete={deleteNoteTarget.canForceDelete}
          verify={async (pw) => {
            const { note } = deleteNoteTarget;
            const key = await deriveKey(pw, toBytes(note.salt));
            await decryptContent(
              toBytes(note.ciphertext),
              key,
              toBytes(note.iv),
            );
          }}
          onCancel={() => setDeleteNoteTarget(null)}
          onConfirm={async () => {
            const { note } = deleteNoteTarget;
            setDeleteNoteTarget(null);
            try {
              await removeNote(note);
            } catch (err) {
              toast.error(err.message || "Delete failed");
            }
          }}
        />
      )}

      {exportFolder && (
        <HwriteExportDialog
          folderName={exportFolder.name}
          noteCount={(byFolder.get(exportFolder.id) || []).length}
          onConfirm={handleExportFolder}
          onCancel={() => setExportFolder(null)}
        />
      )}

      {folderImportState && (
        <HwriteFolderImportDialog
          parsed={folderImportState.parsed}
          fileSize={folderImportState.fileSize}
          existingNames={folderList.map((f) => f.name)}
          onConfirm={handleImportFolder}
          onCancel={() => setFolderImportState(null)}
        />
      )}

      {importState && (
        <HwriteImportDialog
          parsed={importState.parsed}
          fileSize={importState.fileSize}
          folders={folderList}
          isFolderUnlocked={isFolderUnlocked}
          onConfirm={async ({ destination, passphrase }) => {
            const { parsed } = importState;
            const titleText = parsed.title || "Untitled";

            if (destination === "root") {
              if (parsed.encrypted) {
                // Keep the encrypted envelope as-is. The user supplies the
                // file's passphrase the first time they open it.
                const { ciphertext, iv, salt } = hwriteEnvelopeToBytes(parsed);
                const now = new Date().toISOString();
                await saveNote({
                  id: uuid4(),
                  ciphertext,
                  iv,
                  salt,
                  title: parsed.title,
                  imageIds: [],
                  folderId: null,
                  createdAt: parsed.created || now,
                  updatedAt: parsed.modified || now,
                });
                setImportState(null);
                onNotesChanged?.(await getAllNotes());
                toast.success(`Imported "${parsed.title}" — locked until opened`);
              } else {
                // Plaintext at the root: load into the editor as a draft so
                // the user can save it under their own passphrase.
                const raw = await decryptHwrite(parsed, undefined);
                const result = await rehydrateInlineImages(raw);
                setImportState(null);
                onActiveFolderChange?.(null);
                onImportNote?.({
                  markdown: result.markdown || "",
                  title: titleText,
                });
              }
              return;
            }

            // Into a folder — always re-encrypt under the folder key.
            let raw;
            if (parsed.encrypted) {
              try {
                raw = await decryptHwrite(parsed, passphrase);
              } catch {
                throw new Error("Wrong passphrase, or the file is corrupted.");
              }
            } else {
              raw = await decryptHwrite(parsed, undefined);
            }
            const result = await rehydrateInlineImages(raw);
            const markdown = result.markdown || "";
            const imageIds = result.imageIds || [];

            const entry = getFolderKey(destination);
            if (!entry) {
              // Defer until the user unlocks that folder; the effect above
              // flushes it once the key is available.
              setPendingImport({
                // Opaque id so the flush effect can claim this import without
                // holding on to the object (and its decrypted markdown).
                token: uuid4(),
                folderId: destination,
                markdown,
                title: titleText,
                imageIds,
                createdAt: parsed.created,
              });
              setImportState(null);
              setExpanded((prev) =>
                prev.includes(destination) ? prev : [...prev, destination],
              );
              toast("Unlock the folder to finish importing", { icon: "🔐" });
              return;
            }

            const now = new Date().toISOString();
            const { ciphertext, iv } = await encryptContent(markdown, entry.key);
            const { ciphertext: titleCiphertext, iv: titleIv } =
              await encryptContent(titleText, entry.key);

            await saveNote({
              id: uuid4(),
              ciphertext,
              iv,
              salt: entry.salt,
              title: "",
              titleCiphertext,
              titleIv,
              imageIds,
              folderId: destination,
              createdAt: parsed.created || now,
              updatedAt: parsed.modified || now,
            });

            setImportState(null);
            onNotesChanged?.(await getAllNotes());
            setExpanded((prev) =>
              prev.includes(destination) ? prev : [...prev, destination],
            );
            toast.success(`"${titleText}" imported`);
          }}
          onCancel={() => setImportState(null)}
        />
      )}
    </nav>
  );
};

export default NoteList;
