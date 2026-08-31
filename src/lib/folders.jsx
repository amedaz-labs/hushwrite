import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { v4 as uuid4 } from "uuid";
import {
  deriveKey,
  encryptContent,
  decryptContent,
  generateSalt,
} from "../js/crypto";
import {
  getAllFolders,
  getFolder,
  saveFolder,
  saveFolderWithNotes,
  saveNoteWithImages,
  deleteFolderCascade,
  getAllNotes,
  getNote,
  migrateToFolders,
} from "../js/db";
import { rewrapImagesForKey } from "../js/imageStore";

// Unchanged from the singleton-vault era on purpose: folders migrated from a
// legacy vault carry a verifier encrypted with this exact string, so changing
// it would lock users out of their own data.
const VERIFIER_PLAINTEXT = "hushwrite:vault:v1";

// One lock rule for the whole app: every folder key is dropped after this much
// inactivity. Note sessions use the same constant so there is a single number
// to explain.
export const IDLE_LOCK_MS = 15 * 60 * 1000;

const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

const FolderContext = createContext(null);

export const FolderProvider = ({ children }) => {
  const [folders, setFolders] = useState([]);
  // folderId -> { key, salt }. Memory only; never persisted, dropped on reload.
  const [keys, setKeys] = useState({});
  // Bumped on every lockAll so consumers holding decrypted data outside this
  // provider can drop it under the same single lock rule.
  const [lockEpoch, setLockEpoch] = useState(0);
  const idleTimerRef = useRef(null);

  const refreshFolders = useCallback(async () => {
    const all = await getAllFolders();
    all.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    setFolders(all);
    return all;
  }, []);

  // The legacy-vault migration writes the folder it creates, so it has to
  // finish before the very first list read or that folder renders nowhere.
  useEffect(() => {
    (async () => {
      await migrateToFolders();
      await refreshFolders();
    })();
  }, [refreshFolders]);

  // Bumps `lockEpoch` for the same reason `lockAll` does. A note-info dialog or
  // an export dialog opened from a row in THIS folder is holding that note's
  // decrypted markdown outside the provider, and the epoch effects are the only
  // thing that drops it. Locking one folder from its row menu has to honour the
  // lock as completely as locking everything does.
  //
  // Trade-off, accepted: the epoch is global, so this also discards a deferred
  // import waiting on a *different* folder. Erring toward dropping plaintext.
  const lockFolder = useCallback((id) => {
    setKeys((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLockEpoch((n) => n + 1);
  }, []);

  const lockAll = useCallback(() => {
    setKeys((prev) => (Object.keys(prev).length ? {} : prev));
    setLockEpoch((n) => n + 1);
  }, []);

  const isFolderUnlocked = useCallback((id) => !!(id && keys[id]), [keys]);
  const getFolderKey = useCallback((id) => (id ? keys[id] || null : null), [keys]);

  // Idle auto-lock. Real user activity (pointer/keyboard) resets the timer;
  // hiding the tab or navigating away locks immediately.
  //
  // Armed unconditionally, not just while a folder key is in memory: anything
  // holding decrypted data has to be dropped on lock, and some of it exists
  // *because* nothing is unlocked — a deferred import parks decrypted markdown
  // in React state while it waits for its destination folder's key. Gating on
  // "is a folder unlocked" would leave exactly that case with no timer and no
  // listeners. lockAll's setKeys is a no-op when nothing is unlocked, so the
  // only cost is an epoch bump and one cheap render.
  useEffect(() => {
    const arm = () => {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(lockAll, IDLE_LOCK_MS);
    };
    const onHide = () => {
      if (document.hidden) lockAll();
    };

    arm();
    document.addEventListener("pointerdown", arm);
    document.addEventListener("keydown", arm);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", lockAll);
    return () => {
      clearTimeout(idleTimerRef.current);
      document.removeEventListener("pointerdown", arm);
      document.removeEventListener("keydown", arm);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", lockAll);
    };
  }, [lockAll]);

  const createFolder = useCallback(
    async (name, passphrase) => {
      const trimmed = (name || "").trim();
      if (!trimmed) throw new Error("Give the folder a name.");
      if (!passphrase) throw new Error("Choose a passphrase.");

      const salt = generateSalt();
      const key = await deriveKey(passphrase, salt);
      const { ciphertext, iv } = await encryptContent(VERIFIER_PLAINTEXT, key);
      const now = new Date().toISOString();
      const folder = {
        id: uuid4(),
        name: trimmed,
        salt,
        verifierCiphertext: ciphertext,
        verifierIv: iv,
        createdAt: now,
        updatedAt: now,
      };

      await saveFolder(folder);
      await refreshFolders();
      setKeys((prev) => ({ ...prev, [folder.id]: { key, salt } }));
      // The key comes back with the folder: `keys` won't be readable until the
      // next render, and callers that seed a new folder with notes need it now.
      return { folder, key, salt };
    },
    [refreshFolders],
  );

  const unlockFolder = useCallback(async (id, passphrase) => {
    const folder = await getFolder(id);
    if (!folder) throw new Error("Folder not found.");

    const salt = toBytes(folder.salt);
    const candidate = await deriveKey(passphrase, salt);
    const plaintext = await decryptContent(
      toBytes(folder.verifierCiphertext),
      candidate,
      toBytes(folder.verifierIv),
    );
    if (plaintext !== VERIFIER_PLAINTEXT) {
      throw new Error("Wrong folder passphrase.");
    }

    setKeys((prev) => ({ ...prev, [id]: { key: candidate, salt } }));
    return { key: candidate, salt };
  }, []);

  const renameFolder = useCallback(
    async (id, name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) throw new Error("Give the folder a name.");
      const folder = await getFolder(id);
      if (!folder) throw new Error("Folder not found.");
      await saveFolder({
        ...folder,
        name: trimmed,
        updatedAt: new Date().toISOString(),
      });
      await refreshFolders();
    },
    [refreshFolders],
  );

  // Destroys the folder and everything inside it. Requires the folder to be
  // unlocked so a passer-by can't wipe notes they can't read.
  const removeFolder = useCallback(
    async (id) => {
      if (!keys[id]) throw new Error("Unlock the folder first.");
      const all = await getAllNotes();
      const contained = all.filter((n) => n.folderId === id);

      // Collect first, delete once: a partial cascade could otherwise strip a
      // note's images and then fail to remove the note, leaving it rendering
      // broken `idb://` refs.
      await deleteFolderCascade({
        folderId: id,
        noteIds: contained.map((n) => n.id),
        imageIds: contained.flatMap((n) => n.imageIds || []),
      });

      lockFolder(id);
      await refreshFolders();
      return contained.length;
    },
    [keys, lockFolder, refreshFolders],
  );

  // Re-encrypt the verifier and every note in the folder under a brand-new
  // passphrase. The folder must be unlocked so the current key is in memory to
  // decrypt each note before re-encrypting it.
  //
  // All-or-nothing, in two phases. A folder's salt/verifier and its notes'
  // ciphertext are only valid together, so a per-note save loop followed by a
  // folder save is unsafe: abort halfway (a tab close, or one note that won't
  // decrypt) and the already-rewritten notes are unopenable with either
  // passphrase. Phase A does every decrypt/encrypt in memory and writes
  // nothing; Phase B commits the folder and all its notes in one transaction.
  // The split is forced anyway — an `idb` transaction auto-commits across a
  // non-IDB await, so no crypto can happen inside one.
  const changeFolderPassphrase = useCallback(
    async (id, newPassphrase) => {
      const current = keys[id];
      if (!current) throw new Error("Unlock the folder first.");
      if (!newPassphrase || !newPassphrase.trim()) {
        throw new Error("Enter a new passphrase.");
      }

      const folder = await getFolder(id);
      if (!folder) throw new Error("Folder not found.");

      const newSalt = generateSalt();
      const newKey = await deriveKey(newPassphrase, newSalt);
      const { ciphertext: verifierCiphertext, iv: verifierIv } =
        await encryptContent(VERIFIER_PLAINTEXT, newKey);

      const all = await getAllNotes();
      const contained = all.filter((n) => n.folderId === id);
      const now = new Date().toISOString();

      // Phase A — all crypto, zero writes. Each iteration decrypts and
      // immediately re-encrypts, buffering only the CIPHERTEXT record; that
      // note's plaintext goes out of scope at the end of the iteration, so
      // peak live plaintext stays at one note. Do not "optimize" this into a
      // decrypt-all pass — it would hold every note in the clear at once.
      //
      // The same rule holds for images, and holds by construction: images use
      // envelope encryption, so `rewrapImagesForKey` decrypts and re-encrypts
      // only the 32-byte content key. `rekeyedImages` buffers WRAPPED KEYS,
      // never image bytes — the `ciphertext` field it carries through is a Blob
      // handle IDB never materialized. Do not replace that with a
      // decrypt-bytes/re-encrypt-bytes pass; a photo-heavy folder would then
      // hold every picture in the clear at once.
      const rekeyed = [];
      const rekeyedImages = [];
      try {
        for (const note of contained) {
          const plainBody = await decryptContent(
            toBytes(note.ciphertext),
            current.key,
            toBytes(note.iv),
          );
          let plainTitle = note.title || "";
          if (note.titleCiphertext && note.titleIv) {
            plainTitle = await decryptContent(
              toBytes(note.titleCiphertext),
              current.key,
              toBytes(note.titleIv),
            );
          }

          const { ciphertext, iv } = await encryptContent(plainBody, newKey);
          const { ciphertext: titleCiphertext, iv: titleIv } =
            await encryptContent(plainTitle, newKey);

          // Without this every image saved since the encrypted-images change
          // would be permanently undecryptable after a passphrase change: its
          // CEK is wrapped under the OLD folder key.
          rekeyedImages.push(
            ...(await rewrapImagesForKey(
              note.imageIds || [],
              current.key,
              newKey,
            )),
          );

          rekeyed.push({
            ...note,
            ciphertext,
            iv,
            salt: newSalt,
            title: "",
            titleCiphertext,
            titleIv,
            updatedAt: now,
          });
        }
      } catch (err) {
        // One unreadable note OR image aborts the whole re-key, and nothing
        // has been written yet so the folder is exactly as it was. Skipping
        // the bad item instead would leave it on the old key — the corruption
        // this structure exists to prevent. decryptContent's own message ("Note
        // corrupted, tampered, or wrong passphrase") misleads here, since the
        // passphrase the user just typed is not the one that failed — so log
        // the real error before replacing it with the accurate one.
        console.error("[changeFolderPassphrase] re-encrypt failed:", err);
        throw new Error(
          "Could not re-encrypt every note in this folder — passphrase unchanged.",
        );
      }

      // Phase B — one transaction. Either the folder's new salt/verifier,
      // every re-encrypted note and every re-wrapped image key land, or none
      // of them do.
      //
      // Residual, accepted: an editor autosave that lands between Phase A and
      // this transaction is overwritten by it, losing up to one autosave
      // interval of edits. That costs edits, not decryptability; wiring the
      // editor session into the re-key would be disproportionate.
      await saveFolderWithNotes(
        {
          ...folder,
          salt: newSalt,
          verifierCiphertext,
          verifierIv,
          updatedAt: now,
        },
        rekeyed,
        rekeyedImages,
      );

      // Only after disk has committed — React state must never claim a re-key
      // the store didn't take.
      await refreshFolders();
      // A lock (idle timer, tab hidden, explicit Lock, this folder's own Lock)
      // can land while the re-key runs. The captured key saw the operation
      // through, but re-inserting it here would silently re-unlock a folder the
      // user just locked. The updater's `prev` is the CURRENT key map — the one
      // thing the map closed over at entry cannot report — and this function
      // required `keys[id]` to start, so a missing `prev[id]` means exactly
      // "locked mid-flight".
      setKeys((prev) =>
        prev[id] ? { ...prev, [id]: { key: newKey, salt: newSalt } } : prev,
      );
      return contained.length;
    },
    [keys, refreshFolders],
  );

  // Re-encrypt one note under a different lock.
  //   targetFolderId set  -> that folder must be unlocked; note joins it.
  //   targetFolderId null -> note goes back to the root with its own fresh
  //                          passphrase (`newPassphrase` required).
  // `sourceKey` covers root notes, whose key only the editor session holds.
  const moveNoteToFolder = useCallback(
    async (noteId, targetFolderId, { sourceKey, newPassphrase } = {}) => {
      const note = await getNote(noteId);
      if (!note) throw new Error("Note not found.");
      if ((note.folderId || null) === (targetFolderId || null)) return;

      const from = note.folderId ? keys[note.folderId] : null;
      const readKey = from?.key || sourceKey;
      if (!readKey) throw new Error("Unlock the note before moving it.");

      let writeKey;
      let writeSalt;
      if (targetFolderId) {
        const target = keys[targetFolderId];
        if (!target) throw new Error("Unlock the destination folder first.");
        writeKey = target.key;
        writeSalt = target.salt;
      } else {
        if (!newPassphrase || !newPassphrase.trim()) {
          throw new Error("Choose a passphrase for the note.");
        }
        writeSalt = generateSalt();
        writeKey = await deriveKey(newPassphrase, writeSalt);
      }

      const plainBody = await decryptContent(
        toBytes(note.ciphertext),
        readKey,
        toBytes(note.iv),
      );
      let plainTitle = note.title || "";
      if (note.titleCiphertext && note.titleIv) {
        plainTitle = await decryptContent(
          toBytes(note.titleCiphertext),
          readKey,
          toBytes(note.titleIv),
        );
      }

      const { ciphertext, iv } = await encryptContent(plainBody, writeKey);
      const { ciphertext: titleCiphertext, iv: titleIv } =
        await encryptContent(plainTitle, writeKey);

      // The note's images move with it. Their CEKs are wrapped under the key
      // this note used to answer to, so a move without this re-wrap strands
      // every image the moment the destination's key takes over. All crypto
      // first, then one transaction — same discipline as the folder re-key.
      const movedImages = await rewrapImagesForKey(
        note.imageIds || [],
        readKey,
        writeKey,
      );

      await saveNoteWithImages(
        {
          ...note,
          ciphertext,
          iv,
          salt: writeSalt,
          title: "",
          titleCiphertext,
          titleIv,
          folderId: targetFolderId || null,
          updatedAt: new Date().toISOString(),
        },
        movedImages,
      );

      return { key: writeKey, salt: writeSalt, title: plainTitle };
    },
    [keys],
  );

  const value = useMemo(
    () => ({
      folders,
      unlockedIds: Object.keys(keys),
      lockEpoch,
      isFolderUnlocked,
      getFolderKey,
      refreshFolders,
      createFolder,
      unlockFolder,
      lockFolder,
      lockAll,
      renameFolder,
      removeFolder,
      changeFolderPassphrase,
      moveNoteToFolder,
    }),
    [
      folders,
      keys,
      lockEpoch,
      isFolderUnlocked,
      getFolderKey,
      refreshFolders,
      createFolder,
      unlockFolder,
      lockFolder,
      lockAll,
      renameFolder,
      removeFolder,
      changeFolderPassphrase,
      moveNoteToFolder,
    ],
  );

  return (
    <FolderContext.Provider value={value}>{children}</FolderContext.Provider>
  );
};

export const useFolders = () => {
  const ctx = useContext(FolderContext);
  if (!ctx) throw new Error("useFolders must be used within FolderProvider");
  return ctx;
};
