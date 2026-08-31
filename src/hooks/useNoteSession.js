import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuid4 } from "uuid";
import toast from "react-hot-toast";
import {
  saveNoteWithImages,
  getAllNotes,
  getNote,
  deleteNote as dbDeleteNote,
  deleteImage,
} from "../js/db";
import {
  deriveKey,
  encryptContent,
  decryptContent,
  generateSalt,
} from "../js/crypto";
import {
  claimImagesForNote,
  releaseSessionKeys,
  revokeAllImageUrls,
  revokeImageUrls,
  rewrapImagesForKey,
} from "../js/imageStore";
import { IDLE_LOCK_MS } from "../lib/folders";
import { rehydrateInlineImages } from "../js/hwrite";

const AUTOSAVE_DEBOUNCE_MS = 1500;


const IDB_IMG_REGEX = /!\[[^\]]*\]\(idb:\/\/([0-9a-f-]+)\)/gi;
// De-duplicated: the same image can appear twice in one note, and every
// consumer of `imageIds` (GC, re-wrap, backup) wants the set, not the list.
const extractImageIds = (md) => {
  const ids = new Set();
  for (const m of md.matchAll(IDB_IMG_REGEX)) ids.add(m[1]);
  return [...ids];
};
const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
const isQuietErr = (err) =>
  err?.message === "cancelled" || err?.message === "superseded";

// Copy for images `claimImagesForNote` had to skip. Deliberately says the text
// WAS saved: the whole point of making these non-blocking is that a picture
// problem must never look like, or become, lost writing.
const imageWarning = (conflictIds, orphanIds) => {
  const parts = [];
  if (conflictIds.length) {
    parts.push(
      conflictIds.length === 1
        ? "An image here belongs to another note, so it won't display in this one. Copying encrypted images between notes isn't supported — add it to this note directly."
        : `${conflictIds.length} images here belong to other notes, so they won't display in this one. Copying encrypted images between notes isn't supported — add them to this note directly.`,
    );
  }
  if (orphanIds.length) {
    parts.push(
      orphanIds.length === 1
        ? "An image in this note lost its key when the page reloaded and can't be shown again. Remove it or add it again."
        : `${orphanIds.length} images in this note lost their keys when the page reloaded and can't be shown again. Remove them or add them again.`,
    );
  }
  if (!parts.length) return null;
  return `${parts.join(" ")} Your text was saved.`;
};

export function useNoteSession({
  markdown,
  title,
  currentId,
  setMarkdown,
  setTitle,
  setCurrentId,
  setNotes,
  askPassphrase,
  folders,
  activeFolderId = null,
}) {
  const sessionKeyRef = useRef(null);
  const sessionSaltRef = useRef(null);
  // Which folder (if any) owns the key currently in memory. `null` means the
  // note is a root note with its own passphrase.
  const sessionFolderIdRef = useRef(null);
  const lastSavedRef = useRef({ markdown: "", title: "" });
  const isSavingRef = useRef(false);
  const idleTimerRef = useRef(null);
  const debounceTimerRef = useRef(null);
  // Last image warning `persistNote` surfaced, so a note that permanently
  // carries an unclaimable image toasts once, not once per autosave tick.
  const imageWarnRef = useRef(null);

  const [saveStatus, setSaveStatus] = useState("idle");
  const [unlockError, setUnlockError] = useState(null);

  const isUnlocked = useCallback(
    () => !!(sessionKeyRef.current && sessionSaltRef.current),
    [],
  );

  const isDirty = useCallback(
    () =>
      markdown !== lastSavedRef.current.markdown ||
      title !== lastSavedRef.current.title,
    [markdown, title],
  );

  // The open note's key, for callers that need to re-encrypt it elsewhere
  // (moving it between folders). Never leaves the client.
  const getSessionKey = useCallback(() => sessionKeyRef.current, []);

  // Adopt a new key for the note already in the editor — used after a move
  // re-encrypts it, so editing continues without a re-unlock.
  const adoptSessionKey = useCallback((key, salt, folderId) => {
    sessionKeyRef.current = key;
    sessionSaltRef.current = salt;
    sessionFolderIdRef.current = folderId ?? null;
  }, []);

  const folderName = useCallback(
    (id) => folders.folders.find((f) => f.id === id)?.name || "",
    [folders],
  );

  // The one place that decides which key opens a note. A note inside a folder
  // is opened by the folder's key — prompting once unlocks every note in it.
  // A root note keeps its own passphrase.
  const resolveKeyForNote = useCallback(
    async (note) => {
      const folderId = note.folderId || null;
      if (folderId) {
        const cached = folders.getFolderKey(folderId);
        if (cached) return { ...cached, folderId };
        const pw = await askPassphrase("decrypt", {
          folderName: folderName(folderId),
          // Carried so the prompt can say how many notes this one passphrase
          // opens. Display only — the key path does not read it.
          folderId,
        });
        const unlocked = await folders.unlockFolder(folderId, pw);
        return { ...unlocked, folderId };
      }
      const pw = await askPassphrase("decrypt");
      const salt = toBytes(note.salt);
      return { key: await deriveKey(pw, salt), salt, folderId: null };
    },
    [askPassphrase, folders, folderName],
  );

  const persistNoteInner = useCallback(
    async (key, salt, folderId = null) => {
      if (!markdown.trim() || !title.trim()) return false;

      isSavingRef.current = true;
      setSaveStatus("saving");
      try {
        const trimmedTitle = title.trim();
        const { ciphertext, iv } = await encryptContent(markdown, key);
        const { ciphertext: titleCiphertext, iv: titleIv } =
          await encryptContent(trimmedTitle, key);
        const imageIds = extractImageIds(markdown);

        const existingNote = currentId ? await getNote(currentId) : null;

        const id = currentId || uuid4();
        // An existing note never changes folders on a plain save; a brand-new
        // one is filed into whichever folder the sidebar has focused.
        const targetFolderId = existingNote
          ? existingNote.folderId || null
          : folderId;

        // Images that were removed from the note since the last save. Their
        // blobs are GC'd inside the write transaction below rather than
        // deleted here — one fewer await on the autosave path, and the note
        // can no longer land without its GC (or vice versa).
        const previousIds = new Set(existingNote?.imageIds || []);
        const stillReferenced = new Set(imageIds);
        const removedIds = [...previousIds].filter(
          (imageId) => !stillReferenced.has(imageId),
        );

        // Only images NEW to this note need touching: an image already listed
        // on the stored record is already wrapped under this key and already
        // owned by this note. That keeps the steady-state autosave (no image
        // changes) at exactly the same number of awaits as before — the
        // delete/save race the comments in `finalizeDelete` and
        // NoteList.removeNote guard against does not get any wider.
        const addedIds = imageIds.filter(
          (imageId) => !previousIds.has(imageId),
        );
        const {
          records: imageRecords,
          conflictIds,
          orphanIds,
        } = await claimImagesForNote(addedIds, id, key);

        // Images this note couldn't take ownership of are dropped from the
        // record's `imageIds` — but NOT from `removedIds` above, which is
        // computed against the full markdown set so nothing still referenced
        // gets GC'd. Excluding them means a later delete of this note can't
        // destroy another note's image, and an orphan stays sweepable instead
        // of being pinned forever by a reference nothing can open.
        const unclaimable = new Set([...conflictIds, ...orphanIds]);
        const storedImageIds = unclaimable.size
          ? imageIds.filter((imageId) => !unclaimable.has(imageId))
          : imageIds;

        await saveNoteWithImages(
          {
            id,
            ciphertext,
            iv,
            salt,
            title: trimmedTitle,
            titleCiphertext,
            titleIv,
            imageIds: storedImageIds,
            folderId: targetFolderId,
            createdAt: existingNote?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          imageRecords,
          removedIds,
        );

        // Committed: the wrapped copies are on disk, so the in-memory CEKs are
        // redundant. Only after `tx.done`, never before. Orphans have no CEK to
        // release and conflicts' CEKs belong to their owning note, so neither
        // is in this set.
        releaseSessionKeys(imageRecords.map((record) => record.id));

        // The save STOOD; this is advisory. Deduped by message so a note that
        // permanently carries a foreign image doesn't toast once per keystroke.
        const warning = imageWarning(conflictIds, orphanIds);
        if (warning !== imageWarnRef.current) {
          imageWarnRef.current = warning;
          if (warning) toast.error(warning);
        }

        sessionFolderIdRef.current = targetFolderId;
        setCurrentId(id);
        setNotes(await getAllNotes());
        lastSavedRef.current = { markdown, title };
        setSaveStatus("saved");
        return true;
      } catch (err) {
        console.error("[persistNote] failed:", err);
        setSaveStatus("dirty");
        throw err;
      } finally {
        isSavingRef.current = false;
      }
    },
    [markdown, title, currentId, setCurrentId, setNotes],
  );

  // Cooperative re-entrancy guard. A second save can't run concurrently with a
  // first — but it must not report "done" while the first is still mid-flight
  // either. Every caller treats the return value as "the flush is complete",
  // and on a folder note two `lock()` calls genuinely race: `folders.lockAll()`
  // queues `setKeys({})`, the awaited lock #1 starts a save, React flushes the
  // state, and the folder-teardown effect fires lock #2. If #2 returned
  // immediately it would run `lockKeepSelected` -> `revokeAllImageUrls()` and
  // clear the session CEK registry out from under #1's `claimImagesForNote`,
  // which would then classify a just-pasted image as an orphan and drop it.
  // So the loser awaits the winner instead of skipping ahead.
  const savingPromiseRef = useRef(null);
  const persistNote = useCallback(
    async (key, salt, folderId = null) => {
      if (isSavingRef.current) {
        try {
          await savingPromiseRef.current;
        } catch {
          // The running save reports its own error to its own caller.
        }
        return false;
      }
      const p = persistNoteInner(key, salt, folderId);
      savingPromiseRef.current = p;
      return p;
    },
    [persistNoteInner],
  );

  // The last error text autoSave surfaced, so a save that keeps failing for
  // the same reason toasts once instead of once per debounce tick.
  const autoSaveErrorRef = useRef(null);

  const autoSave = useCallback(async () => {
    if (!isUnlocked()) return;
    try {
      await persistNote(
        sessionKeyRef.current,
        sessionSaltRef.current,
        sessionFolderIdRef.current,
      );
      autoSaveErrorRef.current = null;
    } catch (err) {
      // Crypto/consistency failures used to be swallowed entirely here, on the
      // theory that the "Unsaved" pill said enough. It doesn't for an image
      // that can't be claimed (one copied in from another note, or one whose
      // key died with a reload): the note simply stops saving and the pill
      // gives no reason. Surface the message, once per distinct cause.
      const message = err?.message;
      if (message && !isQuietErr(err) && autoSaveErrorRef.current !== message) {
        autoSaveErrorRef.current = message;
        toast.error(message);
      }
    }
  }, [persistNote, isUnlocked]);

  // Wipe everything in memory. Always safe to call.
  //
  // `revokeAllImageUrls` is part of "everything": a decrypted image lives on as
  // a `blob:` URL that stays fetchable until it is revoked, and the session
  // CEK registry holds keys for images an abandoned draft uploaded.
  const wipeSession = useCallback(() => {
    revokeAllImageUrls();
    sessionKeyRef.current = null;
    sessionSaltRef.current = null;
    sessionFolderIdRef.current = null;
    lastSavedRef.current = { markdown: "", title: "" };
    setMarkdown("");
    setTitle("");
    setCurrentId(null);
    setSaveStatus("locked");
  }, [setMarkdown, setTitle, setCurrentId]);


  // Lock the session without yanking the note out of the sidebar.
  // We persist any pending edits, drop the encryption key + plaintext from
  // memory, but keep `currentId` so the note stays selected and the user can
  // re-enter their passphrase to resume editing.
  const lockKeepSelected = useCallback(() => {
    revokeAllImageUrls();
    sessionKeyRef.current = null;
    sessionSaltRef.current = null;
    sessionFolderIdRef.current = null;
    lastSavedRef.current = { markdown: "", title: "" };
    setMarkdown("");
    setTitle("");
    setSaveStatus("locked");
  }, [setMarkdown, setTitle]);

  const lock = useCallback(async () => {
    clearTimeout(idleTimerRef.current);
    clearTimeout(debounceTimerRef.current);

    const dirty = isDirty();

    // Branch 1: existing unlocked note with edits.
    if (isUnlocked()) {
      if (dirty) {
        try {
          await persistNote(
            sessionKeyRef.current,
            sessionSaltRef.current,
            sessionFolderIdRef.current,
          );
        } catch {
          toast.error("Lock: last save failed, recent edits may be lost.");
        }
      }
      lockKeepSelected();
      return;
    }

    // Branch 2: brand-new note that has content but no key yet.
    if (!currentId && dirty && markdown.trim() && title.trim()) {
      try {
        const cached = activeFolderId
          ? folders.getFolderKey(activeFolderId)
          : null;
        if (cached) {
          await persistNote(cached.key, cached.salt, activeFolderId);
        } else {
          const pw = await askPassphrase("encrypt");
          const salt = generateSalt();
          const key = await deriveKey(pw, salt);
          await persistNote(key, salt, null);
        }
        lockKeepSelected();
      } catch (err) {
        if (!isQuietErr(err)) toast.error(err.message);
        // Cancelled or failed: drop the plaintext draft entirely.
        wipeSession();
      }
      return;
    }

    // Branch 3: nothing to flush. Plain wipe.
    wipeSession();
  }, [
    markdown,
    title,
    currentId,
    persistNote,
    wipeSession,
    lockKeepSelected,
    askPassphrase,
    isUnlocked,
    isDirty,
    activeFolderId,
    folders,
  ]);


  const unlockExisting = useCallback(
    async (selectedNote) => {
      const { key, salt, folderId } = await resolveKeyForNote(selectedNote);

      const decrypted = await decryptContent(
        toBytes(selectedNote.ciphertext),
        key,
        toBytes(selectedNote.iv),
      );

      let decryptedTitle = selectedNote.title || "";
      if (selectedNote.titleCiphertext && selectedNote.titleIv) {
        decryptedTitle = await decryptContent(
          toBytes(selectedNote.titleCiphertext),
          key,
          toBytes(selectedNote.titleIv),
        );
      }

      // Imported-encrypted notes can carry inline data: image URIs. Lift
      // them into the images store on first open so the editor stays
      // responsive; the dirty diff that results triggers an autoSave which
      // re-encrypts the lighter form so future unlocks skip this work.
      const { markdown: rehydrated, changed: rehydratedChanged } =
        await rehydrateInlineImages(decrypted, key, selectedNote.id);

      sessionKeyRef.current = key;
      sessionSaltRef.current = salt;
      sessionFolderIdRef.current = folderId;
      // New note in the editor: whatever image warning the last one was
      // suppressing doesn't apply to this one.
      imageWarnRef.current = null;
      lastSavedRef.current = {
        markdown: rehydratedChanged ? decrypted : rehydrated,
        title: decryptedTitle,
      };

      setMarkdown(rehydrated);
      setCurrentId(selectedNote.id);
      setTitle(decryptedTitle);
      setSaveStatus(rehydratedChanged ? "dirty" : "saved");
      setUnlockError(null);
    },
    [resolveKeyForNote, setMarkdown, setCurrentId, setTitle],
  );

  // Re-prompt for the passphrase on the currently-selected (locked) note and
  // restore its plaintext into the editor.
  const unlockCurrent = useCallback(async () => {
    if (isUnlocked()) return;
    if (!currentId) return;
    const note = await getNote(currentId);
    if (!note) return;
    try {
      await unlockExisting(note);
    } catch (err) {
      if (!isQuietErr(err)) setUnlockError(err.message);
      throw err;
    }
  }, [currentId, isUnlocked, unlockExisting]);

  // Switch the editor to a different note: lock+autosave the current one,
  // move the sidebar highlight immediately, then prompt for the new note's
  // passphrase. Wrong passphrase leaves the note in the locked-card UI with
  // an error message instead of bouncing back to the prior note.
  const switchToNote = useCallback(
    async (note) => {
      if (!note) return;
      if (note.id === currentId && isUnlocked()) return;

      clearTimeout(idleTimerRef.current);
      clearTimeout(debounceTimerRef.current);

      if (isUnlocked() && isDirty()) {
        try {
          await persistNote(
            sessionKeyRef.current,
            sessionSaltRef.current,
            sessionFolderIdRef.current,
          );
        } catch {
          toast.error("Could not save current note before switching.");
        }
      }

      // The outgoing note's decrypted images must not follow us to the next
      // one: a `blob:` URL outlives the key that produced it.
      revokeAllImageUrls();
      sessionKeyRef.current = null;
      sessionSaltRef.current = null;
      sessionFolderIdRef.current = null;
      lastSavedRef.current = { markdown: "", title: "" };
      setMarkdown("");
      setTitle("");
      setCurrentId(note.id);
      setSaveStatus("locked");
      setUnlockError(null);

      try {
        await unlockExisting(note);
      } catch (err) {
        if (!isQuietErr(err)) setUnlockError(err.message);
        throw err;
      }
    },
    [
      currentId,
      isUnlocked,
      isDirty,
      persistNote,
      setMarkdown,
      setTitle,
      setCurrentId,
      unlockExisting,
    ],
  );

  // Re-encrypt the current note under a brand-new passphrase. Requires the
  // session to be unlocked (so the existing key is in memory) and the note
  // to already exist on disk. Notes inside a folder are rejected — their key
  // belongs to the folder, not the note.
  const changePassphrase = useCallback(
    async (newPassphrase) => {
      if (!currentId) throw new Error("No note selected.");
      if (!isUnlocked()) throw new Error("Unlock the note first.");
      if (!newPassphrase || !newPassphrase.trim()) {
        throw new Error("Enter a new passphrase.");
      }
      // Disarm any pending autosave before we start. `deriveKey` alone is a
      // ~300ms window; a debounce timer armed before this dialog opened would
      // otherwise fire inside it and re-encrypt the note under the key we are
      // replacing — landing after the re-key and leaving a note the OLD
      // passphrase opens whose image CEKs are wrapped under the new one.
      clearTimeout(debounceTimerRef.current);
      const note = await getNote(currentId);
      if (!note) throw new Error("Note not found.");
      if (note.folderId) {
        throw new Error("Notes in a folder share the folder passphrase.");
      }

      // Flush FIRST, under the key still in memory. An image pasted since the
      // last save exists only in the live `markdown` and in the session CEK
      // registry — it is absent from the stored `imageIds`, so re-wrapping off
      // that list would skip it and the new passphrase would open the text but
      // not the picture. Saving first wraps those CEKs under the old key and
      // lands their ids, so the re-wrap below covers everything.
      if (isDirty()) {
        await persistNote(sessionKeyRef.current, sessionSaltRef.current, null);
      }
      const flushed = (await getNote(currentId)) || note;

      const trimmedTitle = (title || "").trim();
      const newSalt = generateSalt();
      const newKey = await deriveKey(newPassphrase, newSalt);
      const { ciphertext, iv } = await encryptContent(markdown, newKey);
      const { ciphertext: titleCiphertext, iv: titleIv } =
        await encryptContent(trimmedTitle, newKey);

      // Root-note equivalent of the folder re-key's image step: this note's
      // image CEKs are wrapped under the key the OLD passphrase derived, so
      // without re-wrapping them the new passphrase opens the text and nothing
      // else. All crypto first, then one transaction.
      const rewrapped = await rewrapImagesForKey(
        flushed.imageIds || [],
        sessionKeyRef.current,
        newKey,
      );

      await saveNoteWithImages(
        {
          ...flushed,
          ciphertext,
          iv,
          salt: newSalt,
          title: trimmedTitle,
          titleCiphertext,
          titleIv,
          updatedAt: new Date().toISOString(),
        },
        rewrapped,
      );
      // The cached object URLs were minted under the old key; they are still
      // valid images, but the cache is keyed by image id and nothing else, so
      // dropping them keeps "what's in memory" honest after a re-key.
      //
      // URLs only. NOT `revokeAllImageUrls`: this is a re-key, not a lock — the
      // session stays live, and clearing its CEK registry here would destroy
      // the keys of any image still waiting to be wrapped.
      revokeImageUrls();

      sessionKeyRef.current = newKey;
      sessionSaltRef.current = newSalt;
      lastSavedRef.current = { markdown, title: trimmedTitle };
      setNotes(await getAllNotes());
      setSaveStatus("saved");
    },
    [currentId, isUnlocked, isDirty, persistNote, markdown, title, setNotes],
  );

  const saveManual = useCallback(async () => {
    // Existing notes reuse their own derived key+salt — we can't change
    // the passphrase of an already-encrypted note through a normal save.
    if (isUnlocked() && currentId) {
      await persistNote(
        sessionKeyRef.current,
        sessionSaltRef.current,
        sessionFolderIdRef.current,
      );
      return "saved";
    }
    // New note inside an unlocked folder: every note in the folder shares one
    // key, so the folder unlock already covers this save — no prompt.
    const cached = activeFolderId ? folders.getFolderKey(activeFolderId) : null;
    if (!currentId && cached) {
      await persistNote(cached.key, cached.salt, activeFolderId);
      sessionKeyRef.current = cached.key;
      sessionSaltRef.current = cached.salt;
      sessionFolderIdRef.current = activeFolderId;
      return "encrypted";
    }
    // New note at the root: gets its own passphrase, independent of any
    // folder that happens to be unlocked.
    const pw = await askPassphrase("encrypt");
    const salt = generateSalt();
    const key = await deriveKey(pw, salt);
    await persistNote(key, salt, null);
    sessionKeyRef.current = key;
    sessionSaltRef.current = salt;
    sessionFolderIdRef.current = null;
    return "encrypted";
  }, [
    persistNote,
    askPassphrase,
    isUnlocked,
    currentId,
    activeFolderId,
    folders,
  ]);

  // Save the current note/draft exactly like the Save button before the user
  // navigates away (e.g. presses "New Note"), so unsaved work is never silently
  // discarded. Returns true when it's safe to proceed, false when the caller
  // should stay put (user cancelled the passphrase, or the draft can't be saved
  // yet — so we don't lose it).
  const saveBeforeLeaving = useCallback(async () => {
    if (!isDirty()) return true;
    const hasBody = !!markdown.trim();
    const hasTitle = !!title.trim();

    // Nothing worth keeping.
    if (!hasBody && !hasTitle) return true;
    // Title-only draft has no body to save — let it go.
    if (!hasBody) return true;
    // Body but no title: can't encrypt/save it, but don't discard it either.
    if (!hasTitle) {
      toast.error("Add a title to save this note before starting a new one.");
      return false;
    }

    try {
      await saveManual();
      return true;
    } catch (err) {
      if (!isQuietErr(err)) toast.error(err.message);
      return false; // cancelled or failed — keep the draft on screen
    }
  }, [isDirty, markdown, title, saveManual]);


  // Shared cleanup after ANY delete path — including the sidebar's, which
  // reaches it through the ref App threads in. Drops the in-memory session key,
  // clears the editor, and refreshes the sidebar list.
  //
  // Everything down to the ref wipes is synchronous on purpose. The sidebar
  // calls this BEFORE it destroys the record, and a debounce timer already at
  // its deadline would otherwise fire from the macrotask queue between the
  // delete and the cleanup — `persistNote` would find no existing record and
  // `put` the note straight back with a fresh `createdAt`, minus the image
  // blobs the caller had already collected.
  const finalizeDelete = useCallback(async () => {
    clearTimeout(debounceTimerRef.current);
    clearTimeout(idleTimerRef.current);
    revokeAllImageUrls();
    sessionKeyRef.current = null;
    sessionSaltRef.current = null;
    sessionFolderIdRef.current = null;
    lastSavedRef.current = { markdown: "", title: "" };

    setMarkdown("");
    setTitle("");
    setCurrentId(null);
    setNotes(await getAllNotes());
    setSaveStatus("idle");
  }, [setMarkdown, setTitle, setCurrentId, setNotes]);

  // Root notes: prompt for the note's passphrase and verify it by attempting
  // to decrypt before destroying the record.
  const deleteCurrent = useCallback(async (passphrase) => {
    if (!currentId) throw new Error("No note selected!");
    const note = await getNote(currentId);
    if (!note) throw new Error("Note not found");

    const pw = passphrase ?? (await askPassphrase("decrypt"));
    const verifyKey = await deriveKey(pw, toBytes(note.salt));
    await decryptContent(
      toBytes(note.ciphertext),
      verifyKey,
      toBytes(note.iv),
    );

    if (note?.imageIds?.length) {
      await Promise.all(note.imageIds.map((id) => deleteImage(id)));
    }
    await dbDeleteNote(currentId);
    await finalizeDelete();
  }, [currentId, askPassphrase, finalizeDelete]);

  // Age-gated delete: drop the record without a passphrase. Caller is
  // responsible for enforcing the 30-day rule — this helper trusts them.
  const forceDeleteCurrent = useCallback(async () => {
    if (!currentId) throw new Error("No note selected!");
    const note = await getNote(currentId);
    if (!note) throw new Error("Note not found");
    if (note.imageIds?.length) {
      await Promise.all(note.imageIds.map((id) => deleteImage(id)));
    }
    await dbDeleteNote(currentId);
    await finalizeDelete();
  }, [currentId, finalizeDelete]);

  // Folder delete: the folder key already authorized access to every note
  // inside, so we skip the per-note passphrase prompt and just remove the
  // record (and its images).
  const deleteFolderNote = useCallback(async () => {
    if (!currentId) throw new Error("No note selected!");
    const note = await getNote(currentId);
    if (!note) throw new Error("Note not found");
    if (!note.folderId) throw new Error("Not a folder note.");
    if (!folders.isFolderUnlocked(note.folderId)) {
      throw new Error("Folder is locked.");
    }

    if (note.imageIds?.length) {
      await Promise.all(note.imageIds.map((id) => deleteImage(id)));
    }
    await dbDeleteNote(currentId);
    await finalizeDelete();
  }, [currentId, folders, finalizeDelete]);


  useEffect(() => {
    if (!isDirty()) return;
    if (!markdown.trim() || !title.trim()) return;

    setSaveStatus("dirty");

    // Only auto-save when we're editing a note that already exists in the
    // store (has an id) AND the session key matches that note. New drafts
    // never background-save — they wait for a manual save so the user can
    // provide a fresh passphrase for the new note.
    if (!sessionKeyRef.current || !currentId) return;
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      autoSave();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(debounceTimerRef.current);
  }, [markdown, title, currentId, autoSave, isDirty]);


  // Notes inside a folder don't run their own idle timer: the folder owns the
  // lock (FolderProvider drops the key after IDLE_LOCK_MS) and the effect
  // below tears the session down when that happens. Re-locking the session
  // separately would only force a redundant re-open.
  useEffect(() => {
    if (sessionFolderIdRef.current) return;
    const hasContent = markdown.trim() && title.trim();
    const armed = sessionKeyRef.current || (!currentId && hasContent);
    if (!armed) return;

    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(async () => {
      await lock();
      toast("Locked due to inactivity. Enter your passphrase to continue.", {
        icon: "🔒",
      });
      if (!document.hidden) {
        unlockCurrent().catch(() => {
          // Surfaced inside the locked-card UI via unlockError.
        });
      }
    }, IDLE_LOCK_MS);
    return () => clearTimeout(idleTimerRef.current);
  }, [markdown, title, currentId, lock, unlockCurrent]);

  // Track the folder that owns the open note's key. Two distinct events look
  // similar from here and must be told apart by key IDENTITY, not by whether
  // the folder id is still in the unlocked set — a re-key *replaces* the
  // entry, so the id never leaves the set:
  //   gone      -> the folder locked (idle, tab hidden, explicit Lock): lock.
  //   different -> the folder was re-keyed: adopt the new key.
  // Adopt rather than lock on a re-key, because lock() flushes pending edits
  // first and flushing under the stale old key would write a note the folder's
  // new passphrase can no longer open.
  const getFolderKey = folders.getFolderKey;
  useEffect(() => {
    const folderId = sessionFolderIdRef.current;
    if (!folderId) return;
    if (!sessionKeyRef.current) return;
    const entry = getFolderKey(folderId);
    if (!entry) {
      lock();
      return;
    }
    if (entry.key !== sessionKeyRef.current) {
      adoptSessionKey(entry.key, entry.salt, folderId);
    }
  }, [getFolderKey, lock, adoptSessionKey]);


  useEffect(() => {
    const isDirtyNow = () =>
      markdown !== lastSavedRef.current.markdown ||
      title !== lastSavedRef.current.title;
    const hasNewNoteDraft = () =>
      !currentId && markdown.trim() && title.trim() && isDirtyNow();

    const onVisibility = () => {
      if (document.hidden) {
        if (sessionKeyRef.current || hasNewNoteDraft()) {
          lock();
        }
        return;
      }
      // Returning to the tab while locked → re-prompt for the passphrase so
      // the user can resume the note they had open.
      if (!sessionKeyRef.current && currentId) {
        unlockCurrent().catch(() => {
          // Surfaced inside the locked-card UI via unlockError.
        });
      }
    };
    const onPageHide = () => {
      if (sessionKeyRef.current) lock();
    };
    const onBeforeUnload = (e) => {
      if (isDirtyNow()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [lock, unlockCurrent, markdown, title, currentId]);

  return {
    saveStatus,
    unlockError,
    isUnlocked,
    getSessionKey,
    adoptSessionKey,
    lock,
    unlockExisting,
    unlockCurrent,
    switchToNote,
    saveManual,
    saveBeforeLeaving,
    changePassphrase,
    deleteCurrent,
    deleteFolderNote,
    forceDeleteCurrent,
    // Exposed so the sidebar's row-level delete ends in the same teardown the
    // three editor delete paths do, instead of clearing App state and leaving
    // the session key, salt and folder id pointing at a deleted record.
    finalizeDelete,
  };
}
