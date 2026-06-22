import { useEffect, useRef, useState } from "react";
import toast, { Toaster } from "react-hot-toast";
import TopNav from "./components/TopNav";
import NoteList from "./components/NoteList";
import Markdown from "./components/Markdown";
import BackupPanel from "./components/BackupPanel";
import { getAllNotes } from "./js/db";
import { VaultProvider } from "./lib/vault";
import { isLoggedIn, clearAuth } from "./js/api";
import { getCloudState, resetBackupPointers } from "./js/backup";

const POLL_INTERVAL_MS = 30 * 1000;

const App = () => {
  const [markdown, setMarkdown] = useState("");
  const [currentId, setCurrentId] = useState(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [activeSection, setActiveSection] = useState("notes");
  const [isComposingNew, setIsComposingNew] = useState(false);
  const [titleCache, setTitleCache] = useState({});

  const [backupOpen, setBackupOpen] = useState(false);
  const [cloud, setCloud] = useState({ state: "loading", latest: null });

  const lockRef = useRef(() => {});
  const isUnlockedRef = useRef(() => false);
  // Saves the current note/draft (prompting for a passphrase if needed) before
  // a new note replaces it. Resolves false if the user cancels, so we keep the
  // current draft instead of discarding it.
  const saveBeforeNewRef = useRef(async () => true);
  const saveBeforeNew = () =>
    saveBeforeNewRef.current ? saveBeforeNewRef.current() : Promise.resolve(true);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (currentId) setIsComposingNew(false);
  }, [currentId]);

  const loadNotes = async () => setNotes(await getAllNotes());
  useEffect(() => {
    loadNotes();
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

  const handleLock = () => {
    lockRef.current?.();
    toast("Session locked", { icon: "🔒" });
  };

  const handleNewNoteInVault = async () => {
    // Save the current draft under its current section before switching to the
    // vault, then create the new note (handleNewNote's own save is a no-op now).
    if (!(await saveBeforeNew())) return;
    setActiveSection("vault");
    handleNewNote();
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
    <VaultProvider>
    <div className="flex h-screen flex-col overflow-hidden bg-surface font-body text-on-surface selection:bg-vault-primary/30">
      <TopNav
        isUnlocked={isUnlockedRef.current?.() ?? false}
        onLock={handleLock}
        notesCount={notes.length}
        cloudState={cloud.state}
        cloudLatest={cloud.latest}
        onOpenBackup={handleOpenBackup}
        isLocalOnly={!isLoggedIn()}
        onLogout={handleLogout}
        onSignIn={handleOpenBackup}
      />
      <main className="flex flex-1 overflow-hidden">
        <NoteList
          notes={notes}
          currentId={currentId}
          currentTitle={title}
          titleCache={titleCache}
          onSelectNote={(n) => {
            setIsComposingNew(false);
            setSelectedNote(n);
          }}
          onImportNote={handleImportNote}
          onNotesChanged={(next) => setNotes(next)}
          onNewNote={activeSection === "vault" ? handleNewNoteInVault : handleNewNote}
          activeSection={activeSection}
          onSectionChange={(id) => {
            setActiveSection(id);
            setSelectedNote(null);
            setCurrentId(null);
            setMarkdown("");
            setTitle("");
            setIsComposingNew(false);
          }}
          isComposingNew={isComposingNew}
          isNoteUnlocked={isUnlockedRef.current?.() ?? false}
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
          vaultMode={activeSection === "vault"}
          isComposingNew={isComposingNew}
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
    </VaultProvider>
  );
};

export default App;
