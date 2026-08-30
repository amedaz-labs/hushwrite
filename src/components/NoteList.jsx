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
import { decryptContent, encryptContent } from "../js/crypto";
import { saveNote, getAllNotes } from "../js/db";

const toBytes = (v) =>
  v instanceof Uint8Array ? v : v ? new Uint8Array(v) : null;

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

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

const NoteRow = ({ note, isActive, title, unlocked, indented, onSelect }) => {
  const displayTitle =
    title && title.trim()
      ? title
      : isActive
        ? "Untitled note"
        : "Encrypted note";
  const encrypted = !title && !isActive;

  return (
    <button
      onClick={onSelect}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "group relative block w-full cursor-pointer overflow-hidden border-l-[3px] py-2.5 pr-3 text-left transition-all duration-200",
        indented ? "pl-9" : "pl-3",
        isActive
          ? "border-vault-primary bg-gradient-to-r from-vault-primary/12 via-vault-primary/6 to-transparent"
          : "border-transparent hover:bg-surface-container",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          name={unlocked ? "description" : "lock"}
          className={cn(
            "shrink-0 text-base",
            isActive ? "text-vault-primary" : "text-outline/70",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            isActive
              ? "font-semibold text-vault-primary"
              : encrypted
                ? "text-on-surface-variant"
                : "text-on-surface",
          )}
        >
          {displayTitle}
        </span>
        <span
          className={cn(
            "shrink-0 text-[10px] tabular-nums",
            isActive ? "text-vault-primary/70" : "text-outline",
          )}
        >
          {formatTimestamp(note.updatedAt || note.createdAt)}
        </span>
      </div>
    </button>
  );
};

const NoteList = ({
  open = false,
  notes,
  currentId,
  currentTitle,
  titleCache = {},
  onSelectNote,
  onImportNote,
  onNotesChanged,
  onNewNote,
  activeFolderId = null,
  onActiveFolderChange,
  isComposingNew = false,
  isNoteUnlocked = false,
}) => {
  const fileInputRef = useRef(null);
  const [importState, setImportState] = useState(null);
  const [folderImportState, setFolderImportState] = useState(null);
  const [exportFolder, setExportFolder] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [folderTitles, setFolderTitles] = useState({});
  const [dialog, setDialog] = useState(null); // { mode, folderId }
  const [deleteFolderTarget, setDeleteFolderTarget] = useState(null);
  // An import whose destination folder isn't unlocked yet. Flushed by the
  // effect below the moment that folder's key becomes available.
  const [pendingImport, setPendingImport] = useState(null);
  const claimedImportRef = useRef(null);

  const folders = useFolders();
  const {
    folders: folderList,
    unlockedIds,
    lockEpoch,
    isFolderUnlocked,
    getFolderKey,
  } = folders;

  const activeFolder = folderList.find((f) => f.id === activeFolderId) || null;

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

  const renderNote = (note, indented) => (
    <NoteRow
      key={note.id}
      note={note}
      indented={indented}
      isActive={note.id === currentId}
      title={resolveTitle(note)}
      unlocked={
        note.folderId
          ? isFolderUnlocked(note.folderId)
          : note.id === currentId && isNoteUnlocked
      }
      onSelect={() => {
        onActiveFolderChange?.(note.folderId || null);
        onSelectNote(note);
      }}
    />
  );

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
    <section
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
        "invisible absolute inset-y-0 left-0 z-40 flex w-72 max-w-[85%] shrink-0 -translate-x-full flex-col border-r border-outline-variant/10 bg-surface-container-lowest transition-[transform,visibility] duration-200 ease-out md:visible md:static md:max-w-none md:translate-x-0",
        open && "visible translate-x-0",
        dragActive && "ring-2 ring-vault-primary/60 ring-inset",
      )}
    >
      <div className="border-b border-outline-variant/10 p-3">
        <div className="mb-2.5 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-outline">
            Notes
          </h2>
          <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold tabular-nums text-on-surface-variant">
            {notes.length}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onNewNote}
            className="group flex flex-col items-center gap-1.5 rounded-xl border border-vault-primary/25 bg-primary-container/10 px-2 py-3 transition-all hover:border-vault-primary/50 hover:bg-primary-container/20 active:scale-[0.98]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-vault-primary/15 text-vault-primary">
              <Icon name="add" className="text-[18px]" />
            </span>
            <span className="text-xs font-semibold text-vault-primary">
              New note
            </span>
            <span className="w-full truncate text-center text-[10px] leading-tight text-vault-primary/60">
              {activeFolder ? `in ${activeFolder.name}` : "own passphrase"}
            </span>
          </button>

          <button
            onClick={() => setDialog({ mode: "create" })}
            className="group flex flex-col items-center gap-1.5 rounded-xl border border-outline-variant/20 bg-surface-container px-2 py-3 transition-all hover:border-outline-variant/40 hover:bg-surface-container-high active:scale-[0.98]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
              <Icon name="create_new_folder" className="text-[18px]" />
            </span>
            <span className="text-xs font-semibold text-on-surface">
              New folder
            </span>
            <span className="w-full truncate text-center text-[10px] leading-tight text-outline">
              shared passphrase
            </span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isComposingNew && !currentId && (
          <div className="block w-full border-l-2 border-vault-primary bg-surface-container-high/50 p-3 text-left">
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-semibold text-on-surface">
                {currentTitle?.trim() || "Untitled"}
              </h3>
              <span className="rounded bg-primary-container/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-vault-primary">
                Draft
              </span>
            </div>
          </div>
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
                <p className="px-3 py-2 pl-9 text-[11px] text-outline">
                  Empty folder
                </p>
              ) : (
                contained.map((note) => renderNote(note, true))
              )}
            </FolderRow>
          );
        })}

        {rootNotes.map((note) => renderNote(note, false))}

        {folderList.length === 0 &&
          rootNotes.length === 0 &&
          !isComposingNew && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <Icon name="description" className="text-2xl text-outline/60" />
              <p className="text-xs text-outline">No notes yet</p>
            </div>
          )}
      </div>

      <div className="border-t border-outline-variant/10 p-3">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-outline transition-colors hover:text-on-surface md:min-h-0"
        >
          <Icon name="file_upload" className="text-base" />
          Import .hwrite
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".hwrite,application/json"
          hidden
          onChange={onFilePick}
        />
      </div>

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
    </section>
  );
};

export default NoteList;
