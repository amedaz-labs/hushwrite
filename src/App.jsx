import { useEffect, useRef, useState } from "react";
import toast, { Toaster } from "react-hot-toast";
import TopNav from "./components/TopNav";
import NoteList from "./components/NoteList";
import Markdown from "./components/Markdown";
import BackupPanel from "./components/BackupPanel";
import { getAllNotes, migrateToFolders } from "./js/db";
import { sweepOrphans } from "./js/imageStore";
import { useFolders } from "./lib/folders";
import { isLoggedIn, clearAuth } from "./js/api";
import { getCloudState, resetBackupPointers } from "./js/backup";

const POLL_INTERVAL_MS = 30 * 1000;

const App = () => {
  const [markdown, setMarkdown] = useState("");
  const [currentId, setCurrentId] = useState(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  // Which folder new notes are filed into. `null` = a root note that carries
  // its own passphrase.
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [isComposingNew, setIsComposingNew] = useState(false);
  const [titleCache, setTitleCache] = useState({});

  const [notesOpen, setNotesOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [cloud, setCloud] = useState({ state: "loading", latest: null });

  // Two small pieces lifted out of NoteList so the editor's empty state can
  // reach the same entry points: the folder create/rename/re-key dialog, and a
  // nonce that pops the (still NoteList-owned) hidden file input.
  const [folderDialog, setFolderDialog] = useState(null);
  const [importRequest, setImportRequest] = useState(0);

  // Folder keys live in context, so the top bar's lock indicator can count
  // them reactively — `isUnlocked` alone only reports the editor session.
  const folders = useFolders();
  const { unlockedIds } = folders;

  // Escape closes the mobile drawer (the overlay only handles clicks).
  useEffect(() => {
    if (!notesOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setNotesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notesOpen]);

  const lockRef = useRef(() => {});
  const isUnlockedRef = useRef(() => false);
  // Saves the current note/draft (prompting for a passphrase if needed) before
  // a new note replaces it. Resolves false if the user cancels, so we keep the
  // current draft instead of discarding it.
  const saveBeforeNewRef = useRef(async () => true);
  const saveBeforeNew = () =>
    saveBeforeNewRef.current ? saveBeforeNewRef.current() : Promise.resolve(true);
  // The note session's own `finalizeDelete`. `Markdown` is mounted for the
  // whole life of the app and assigns this on every render, so it is set well
  // before any row-level delete can be clicked.
  const noteDeletedRef = useRef(null);
  // `isUnlockedRef` reads a ref that React never re-renders for, so this tick
  // is what keeps the top bar and the sidebar's lock glyphs from going stale.
  // Folder state is reactive via `useFolders()`; only the editor session still
  // needs polling. Replacing it means having Markdown push its unlock
  // transitions up — worth doing, but not in the same pass as the redesign.
  // Do NOT add a second interval alongside it.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (currentId) setIsComposingNew(false);
  }, [currentId]);

  const loadNotes = async () => setNotes(await getAllNotes());
  // Convert any pre-folders profile (singleton vault + loose notes) before the
  // first read, so nothing ever renders against the old shape.
  useEffect(() => {
    (async () => {
      await migrateToFolders();
      await loadNotes();
      // An image uploaded into a draft that was never saved has a content key
      // that only ever existed in memory, so after this reload it is bytes
      // nothing can open. Drop them. Only ever touches encrypted records with
      // no wrapped key — legacy plaintext images are never swept.
      sweepOrphans().catch((err) =>
        console.error("[imageStore] orphan sweep failed:", err),
      );
    })();
  }, []);

  // Poll cloud state in the background. Cheap (manifest only) and gives the
  // TopNav badge live awareness of other devices' activity.
  const refreshCloud = async () => {
    try {
      const result = await getCloudState();
      setCloud(result);
    } catch (err) {
      setCloud({ state: "error", error: err.message });
    }
  };

  useEffect(() => {
    refreshCloud();
    const id = setInterval(refreshCloud, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Recompute cloud state whenever local notes change so the badge reflects
  // unbacked-up edits immediately.
  useEffect(() => {
    refreshCloud();
  }, [notes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!currentId || !title.trim()) return;
    setTitleCache((prev) =>
      prev[currentId] === title ? prev : { ...prev, [currentId]: title },
    );
  }, [currentId, title]);

  useEffect(() => {
    setTitleCache((prev) => {
      const ids = new Set(notes.map((n) => n.id));
      const next = {};
      let changed = false;
      for (const [id, t] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = t;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [notes]);

  const handleNewNote = async () => {
    // Treat "New Note" like a save first: persist the current draft (prompting
    // for a passphrase if needed) so unsaved work isn't lost. If the user
    // cancels, stay on the current note instead of discarding it.
    if (!(await saveBeforeNew())) return;
    setMarkdown("");
    setTitle("");
    setCurrentId(null);
    setSelectedNote(null);
    setIsComposingNew(true);
    toast.success("New note created");
  };

  const handleImportNote = ({ markdown: md, title: t }) => {
    setSelectedNote(null);
    setCurrentId(null);
    setTitle(t || "Untitled");
    setMarkdown(md || "");
    setIsComposingNew(true);
    toast.success("Imported. Save to encrypt with your passphrase.");
  };

  // Folder keys drop FIRST. `lock()` flushes pending edits and can await a
  // passphrase prompt for an unsaved draft — chaining `lockAll()` behind it
  // left every folder key in memory for as long as that prompt stayed open,
  // after the user had already clicked "Lock everything now".
  //
  // The toast lands AFTER the lock finishes, not between the two steps: `lock()`
  // can await a passphrase prompt for an unsaved draft (branch 2), so announcing
  // "Session locked" first put the confirmation on screen ahead of the prompt —
  // and a failed final save then toasted its error after the success message.
  const handleLock = async () => {
    folders.lockAll();
    await lockRef.current?.();
    toast("Session locked", { icon: "🔒" });
  };

  // A note deleted from a sidebar row may be the one the editor is holding
  // open. Clearing App state is NOT enough: the session key, salt and folder id
  // live in refs inside `useNoteSession`, and left in place they point at a
  // deleted record — `lock()` would then flush a brand-new note under the
  // deleted note's key, salt and folder. Run the hook's own teardown, the same
  // one every editor delete path ends in.
  //
  // Awaited, and called by `NoteList` BEFORE it destroys anything, so the
  // pending autosave is cancelled while the record still exists.
  const handleNoteDeleted = async (noteId) => {
    if (noteId !== currentId) return;
    setSelectedNote(null);
    setIsComposingNew(false);
    await noteDeletedRef.current?.();
  };

  const handleLogout = () => {
    clearAuth();
    resetBackupPointers();
    refreshCloud();
    toast.success("Signed out");
  };

  const handleOpenBackup = () => {
    setBackupOpen(true);
  };

  const handleAfterRestore = async () => {
    await loadNotes();
    refreshCloud();
  };

  const handleAfterBackup = async () => {
    refreshCloud();
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-surface font-body text-on-surface selection:bg-vault-primary/30">
      <TopNav
        isUnlocked={isUnlockedRef.current?.() ?? false}
        unlockedFolderCount={unlockedIds.length}
        onLock={handleLock}
        cloudState={cloud.state}
        cloudLatest={cloud.latest}
        onOpenBackup={handleOpenBackup}
        isLocalOnly={!isLoggedIn()}
        onLogout={handleLogout}
        onSignIn={handleOpenBackup}
        onToggleNotes={() => setNotesOpen((v) => !v)}
        notesOpen={notesOpen}
      />
      <main className="relative flex flex-1 overflow-hidden">
        {notesOpen && (
          <div
            className="absolute inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setNotesOpen(false)}
            aria-hidden="true"
          />
        )}
        <NoteList
          open={notesOpen}
          notes={notes}
          currentId={currentId}
          currentTitle={title}
          titleCache={titleCache}
          onSelectNote={(n) => {
            setIsComposingNew(false);
            setSelectedNote(n);
            setNotesOpen(false);
          }}
          onImportNote={(payload) => {
            setNotesOpen(false);
            handleImportNote(payload);
          }}
          onNotesChanged={(next) => setNotes(next)}
          onNoteDeleted={handleNoteDeleted}
          onNewNote={() => {
            setNotesOpen(false);
            return handleNewNote();
          }}
          activeFolderId={activeFolderId}
          onActiveFolderChange={setActiveFolderId}
          isComposingNew={isComposingNew}
          isNoteUnlocked={isUnlockedRef.current?.() ?? false}
          folderDialog={folderDialog}
          onFolderDialogChange={setFolderDialog}
          importRequest={importRequest}
        />
        <Markdown
          selectedNote={selectedNote}
          markdown={markdown}
          setMarkdown={setMarkdown}
          currentId={currentId}
          setCurrentId={setCurrentId}
          title={title}
          setTitle={setTitle}
          notes={notes}
          setNotes={setNotes}
          titleCache={titleCache}
          onLockRef={lockRef}
          onIsUnlockedRef={isUnlockedRef}
          onSaveBeforeNewRef={saveBeforeNewRef}
          onNoteDeletedRef={noteDeletedRef}
          activeFolderId={activeFolderId}
          isComposingNew={isComposingNew}
          onNewNote={handleNewNote}
          onNewFolder={() => setFolderDialog({ mode: "create" })}
          onImport={() => setImportRequest((n) => n + 1)}
        />
      </main>
      <BackupPanel
        open={backupOpen}
        onOpenChange={setBackupOpen}
        onRestoreComplete={handleAfterRestore}
        onAfterBackup={handleAfterBackup}
      />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "var(--v-surface-container)",
            color: "var(--v-on-surface)",
            border: "1px solid var(--v-outline-variant)",
            borderRadius: "0.5rem",
            fontSize: "13px",
          },
          success: {
            iconTheme: {
              primary: "var(--v-primary)",
              secondary: "var(--v-surface-container)",
            },
          },
          error: {
            iconTheme: {
              primary: "hsl(var(--destructive))",
              secondary: "var(--v-surface-container)",
            },
          },
        }}
      />
    </div>
  );
};

export default App;
