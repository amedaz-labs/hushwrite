import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import MilkdownEditor from "./MilkdownEditor.jsx";
import Preview from "./Preview.jsx";
import ExportNote from "./ExportNotes.jsx";
import PassphraseModal from "./PassPhraseModal.jsx";
import DeleteModal from "./DeleteModal.jsx";
import AIActionsMenu from "./AIActionsMenu.jsx";
import AISettingsDialog from "./AISettingsDialog.jsx";
import NoteInfoDialog from "./NoteInfoDialog.jsx";
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
import { useVault } from "@/lib/vault";

const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

const Icon = ({ name, className, fill }) => (
  <span
    className={cn("material-symbols-outlined", className)}
    style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}
  >
    {name}
  </span>
);

const SaveStatus = ({ status, vaultMode }) => {
  switch (status) {
    case "saving":
      return (
        <div className="flex items-center gap-1.5 text-on-surface-variant">
          <Icon name="progress_activity" className="animate-spin text-sm" />
          <span>SAVING…</span>
        </div>
      );
    case "saved":
      return (
        <div className="flex items-center gap-1.5 text-on-surface-variant">
          <Icon name="check_circle" className="text-sm" fill />
          <span>{vaultMode ? "SAVED · VAULT" : "SAVED"}</span>
        </div>
      );
    case "dirty":
      return (
        <div className="flex items-center gap-1.5 text-tertiary">
          <Icon name="edit" className="text-sm" />
          <span>UNSAVED</span>
        </div>
      );
    case "locked":
      return (
        <div className="flex items-center gap-1.5 text-outline">
          <Icon name="lock" className="text-sm" />
          <span>LOCKED</span>
        </div>
      );
    default:
      return null;
  }
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
  vaultMode = false,
  isComposingNew = false,
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
  const {
    isVaultUnlocked,
    vaultKey,
    vaultSalt,
    changeVaultPassphrase,
  } = useVault();

  const { modal, open: openModal } = useModalQueue();
  const askPassphrase = (mode) => openModal({ type: "passphrase", mode });
  const askDeleteConfirm = (opts = {}) =>
    openModal({ type: "delete", ...opts });

  const vaultSession =
    vaultMode && isVaultUnlocked ? { key: vaultKey, salt: vaultSalt } : null;

  const {
    saveStatus,
    unlockError,
    isUnlocked,
    lock,
    unlockCurrent,
    switchToNote,
    saveManual,
    saveBeforeLeaving,
    changePassphrase,
    deleteCurrent,
    deleteVaultNote,
    forceDeleteCurrent,
  } = useNoteSession({
    markdown,
    title,
    currentId,
    setMarkdown,
    setTitle,
    setCurrentId,
    setNotes,
    askPassphrase,
    vault: vaultSession,
  });

  // Expose lock + unlock-state to TopNav via refs passed from App.
  useEffect(() => {
    if (onLockRef) onLockRef.current = lock;
    if (onIsUnlockedRef) onIsUnlockedRef.current = isUnlocked;
    if (onSaveBeforeNewRef) onSaveBeforeNewRef.current = saveBeforeLeaving;
  });

  useEffect(() => {
    if (!currentId) setTitle("");
  }, [currentId, setTitle]);

  useEffect(() => {
    if (!selectedNote) return;
    (async () => {
      try {
        await switchToNote(selectedNote);
        if (!vaultMode) toast.success("Note unlocked");
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
      } else if (vaultMode) {
        await askDeleteConfirm({ requirePassphrase: false });
        await deleteVaultNote();
      } else {
        // Unlocked non-vault: verify the passphrase inside the dialog so a
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

  // A locked note older than 30 days can be deleted without a passphrase.
  // Younger notes force a passphrase verify to prevent casual wipes.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const currentNoteMeta = notes.find((n) => n.id === currentId);
  const noteCreatedAt = currentNoteMeta?.createdAt
    ? new Date(currentNoteMeta.createdAt)
    : null;
  const noteAgeMs = noteCreatedAt ? Date.now() - noteCreatedAt.getTime() : 0;
  const canDeleteWithoutUnlock = noteAgeMs >= THIRTY_DAYS_MS;
  const eligibleDeleteDate = noteCreatedAt
    ? new Date(noteCreatedAt.getTime() + THIRTY_DAYS_MS)
    : null;
  const daysUntilEligible = eligibleDeleteDate
    ? Math.max(0, Math.ceil((eligibleDeleteDate - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  const [inlinePassphrase, setInlinePassphrase] = useState("");
  const [unlockPending, setUnlockPending] = useState(false);

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
  };

  // Suppress the passphrase modal for decrypt mode while locked —
  // the inline form in the locked card handles it instead.
  const suppressPassphraseModal =
    modal?.type === "passphrase" && modal.mode === "decrypt" && isLocked;

  const hasNoteOpen = !!currentId || isComposingNew;

  return (
    <section className="relative flex flex-1 flex-col bg-surface">
      {modal?.type === "passphrase" && !suppressPassphraseModal && (
        <PassphraseModal
          mode={modal.mode}
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
        markdown={markdown}
        title={title}
        vaultMode={vaultMode}
        isUnlocked={vaultMode ? isVaultUnlocked : isUnlocked()}
        onChangePassphrase={changePassphrase}
        onChangeVaultPassphrase={changeVaultPassphrase}
      />

      {!hasNoteOpen ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Icon name="edit_note" className="text-5xl text-outline-variant/40" />
          <p className="text-sm text-on-surface-variant/60">
            Select a note or create a new one to get started
          </p>
        </div>
      ) : (
      <>
      {/* Toolbar / status bar */}
      <div className="flex h-12 items-center justify-between border-b border-outline-variant/10 px-6">
        <div className="flex items-center gap-1">
          {!isLocked && (
            <>
              <ExportNote note={{ content: markdown, title }} />
              {currentId && (
                <>
                  <div className="mx-1 h-4 w-px bg-outline-variant/30" />
                  <button
                    onClick={handleDelete}
                    title="Delete note (requires passphrase)"
                    className="rounded p-1.5 text-outline transition-all hover:bg-error-container/30 hover:text-error"
                  >
                    <Icon name="delete" className="text-xl" />
                  </button>
                </>
              )}
              <div className="mx-1 h-4 w-px bg-outline-variant/30" />
              <AIActionsMenu
                markdown={markdown}
                setMarkdown={setMarkdown}
                title={title}
                setTitle={setTitle}
                vaultMode={vaultMode}
                onOpenSettings={() => setAiSettingsOpen(true)}
                onSnapshot={(snapshot) => setAiSnapshot(snapshot)}
                disabled={!!aiSnapshot}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] font-medium text-on-surface-variant">
          <span className="tabular-nums tracking-wide">
            {wordCount.toLocaleString()} WORDS
          </span>
          <div className="flex items-center gap-1 rounded-full bg-surface-container-low px-2.5 py-1">
            <SaveStatus status={saveStatus} vaultMode={vaultMode} />
            {currentId && saveStatus !== "locked" && (
              <button
                onClick={() => setInfoOpen(true)}
                title="Note info & passphrase"
                aria-label="Note info"
                className="ml-0.5 rounded-full p-0.5 text-outline transition-colors hover:text-vault-primary"
              >
                <Icon name="info" className="text-sm" />
              </button>
            )}
          </div>
          {!isLocked && (
            <button
              onClick={() => setShowPreview((v) => !v)}
              title={showPreview ? "Hide markdown" : "Show markdown"}
              aria-label="Toggle markdown view"
              className={cn(
                "rounded-full p-1.5 transition-all hover:bg-surface-container-high",
                showPreview
                  ? "bg-vault-primary/10 text-vault-primary"
                  : "text-outline hover:text-on-surface",
              )}
            >
              <Icon name="visibility" className="text-base" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {isLocked ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <form
            onSubmit={handleInlineUnlock}
            className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl bg-surface-container-low p-10 text-center"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-container/20 ring-1 ring-vault-primary/30">
              <Icon name="lock" className="text-2xl text-vault-primary" />
            </div>
            <div className="space-y-1">
              {titleCache[currentId] && (
                <p className="text-xs font-semibold uppercase tracking-widest text-vault-primary">
                  {titleCache[currentId]}
                </p>
              )}
              <h3 className="text-lg font-semibold tracking-tight text-on-surface">
                {unlockError ? "Wrong passphrase" : "This note is locked"}
              </h3>
              <p className="text-sm text-on-surface-variant">
                {unlockError
                  ? "That passphrase didn't unlock this note. Try again."
                  : "Enter your passphrase to continue where you left off."}
              </p>
            </div>
            <input
              type="password"
              autoFocus
              value={inlinePassphrase}
              onChange={(e) => setInlinePassphrase(e.target.value)}
              placeholder="Passphrase"
              className={cn(
                "w-full rounded-lg border bg-surface-container px-4 py-2.5 text-sm text-on-surface placeholder-outline transition-all focus:outline-none",
                unlockError
                  ? "border-error/60 focus:border-error"
                  : "border-outline-variant/30 focus:border-vault-primary/60",
              )}
            />
            <button
              type="submit"
              disabled={!inlinePassphrase}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-5 py-2.5 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="lock_open" className="text-sm" />
              Unlock note
            </button>
            {canDeleteWithoutUnlock ? (
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-1.5 text-xs font-medium text-outline transition-colors hover:text-error"
                title="This note is older than 30 days — can be deleted without a passphrase"
              >
                <Icon name="delete" className="text-sm" />
                Delete without unlocking
              </button>
            ) : eligibleDeleteDate ? (
              <p className="max-w-xs text-center text-[11px] leading-snug text-on-surface-variant/80">
                <Icon name="info" className="mr-1 align-[-2px] text-xs" />
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
        <div className="relative flex flex-1 overflow-hidden">
          {aiSnapshot && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2">
              <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-vault-primary/30 bg-surface-container px-4 py-2 shadow-2xl shadow-vault-primary/20">
                <div className="flex items-center gap-1.5 text-xs font-semibold tracking-tight text-vault-primary">
                  <Icon name="auto_awesome" className="text-sm" />
                  AI · {aiSnapshot.label}
                </div>
                <span className="h-4 w-px bg-outline-variant/30" />
                <button
                  onClick={() => {
                    setMarkdown(aiSnapshot.markdown);
                    setTitle(aiSnapshot.title);
                    setAiSnapshot(null);
                  }}
                  className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-outline transition-all hover:bg-error/10 hover:text-error active:scale-95"
                >
                  <Icon name="close" className="text-sm" />
                  Discard
                </button>
                <button
                  onClick={() => setAiSnapshot(null)}
                  className="flex items-center gap-1 rounded-full bg-vault-primary px-3 py-1 text-xs font-semibold text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95"
                >
                  <Icon name="check" className="text-sm" />
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
              "flex flex-col overflow-y-auto px-12 py-12",
              showPreview ? "flex-1 border-r border-outline-variant/10" : "w-full",
              aiSnapshot && "pt-20",
            )}
          >
            <div className="mx-auto w-full max-w-3xl">
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
                className="mb-8 w-full border-none bg-transparent text-4xl font-bold tracking-tight text-on-surface placeholder-outline-variant outline-none focus:ring-0"
              />
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
            <div className="flex w-[42%] flex-col overflow-y-auto bg-surface-container-low p-6">
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

      {/* FAB — save */}
      {!isLocked && (
        <button
          onClick={onSave}
          disabled={saveStatus === "saving"}
          aria-label="Save note"
          title={`Save (${isMac ? "⌘" : "Ctrl+"}S)`}
          className={cn(
            "group absolute bottom-8 right-8 flex items-center gap-2.5 rounded-full bg-vault-primary py-3 pl-4 pr-3 text-on-primary-fixed shadow-2xl shadow-vault-primary/30 transition-all duration-200",
            "hover:scale-[1.03] hover:shadow-vault-primary/40 active:scale-95",
            "disabled:cursor-not-allowed disabled:opacity-70",
          )}
        >
          <Icon
            name={saveStatus === "saving" ? "progress_activity" : "save"}
            className={cn(
              "text-xl",
              saveStatus === "saving" && "animate-spin",
            )}
            fill
          />
          <span className="text-sm font-semibold tracking-tight">
            {saveStatus === "saving" ? "Saving" : "Save"}
          </span>
          <kbd className="rounded-md bg-on-primary-fixed/15 px-1.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide">
            {isMac ? "⌘S" : "Ctrl+S"}
          </kbd>
        </button>
      )}
      </>
      )}
    </section>
  );
};

export default Markdown;
