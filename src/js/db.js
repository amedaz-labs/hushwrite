import { openDB } from "idb";

const DB_NAME = "hushwrite-db";
const DB_VERSION = 3;
const NOTES_STORE = "notes";
const IMAGES_STORE = "images";
const FOLDERS_STORE = "folders";

// Legacy: the singleton vault's metadata (salt + passphrase verifier) used to
// live in the notes store under this reserved id. `migrateToFolders` converts
// it into a regular folder record and removes it. Still filtered out of
// `getAllNotes` so a half-migrated profile can never surface it as a note.
export const VAULT_META_ID = "__vault_meta__";

export const initDB = async () => {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        db.createObjectStore(FOLDERS_STORE, { keyPath: "id" });
      }
    },
  });
};


export const saveNote = async (note) => {
  const db = await initDB();
  await db.put(NOTES_STORE, note);
};

export const getAllNotes = async () => {
  const db = await initDB();
  const all = await db.getAll(NOTES_STORE);
  return all.filter((n) => n.id !== VAULT_META_ID);
};

export const getNote = async (id) => {
  const db = await initDB();
  return db.get(NOTES_STORE, id);
};

export const deleteNote = async (id) => {
  const db = await initDB();
  await db.delete(NOTES_STORE, id);
};

// ---------- Folders ----------
// A folder record is the generalization of the old vault metadata: a name plus
// the salt and encrypted verifier used to derive and check one shared AES-GCM
// key. Notes point at it by `folderId`; the key itself never touches disk.

export const getAllFolders = async () => {
  const db = await initDB();
  return db.getAll(FOLDERS_STORE);
};

export const getFolder = async (id) => {
  const db = await initDB();
  return db.get(FOLDERS_STORE, id);
};

export const saveFolder = async (folder) => {
  const db = await initDB();
  await db.put(FOLDERS_STORE, folder);
};

// One-way migration from the singleton-vault model to folders. Idempotent in
// its own right (a second run finds nothing left to convert), though the
// exported `migrateToFolders` below memoizes it to exactly one run per page
// load. No note is ever re-encrypted — the legacy vault keeps its original
// salt, so the user's existing passphrase still derives the same key.
const runFolderMigration = async () => {
  const db = await initDB();
  const legacyMeta = await db.get(NOTES_STORE, VAULT_META_ID);
  const notes = await db.getAll(NOTES_STORE);

  let folderId = null;
  if (legacyMeta) {
    folderId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.put(FOLDERS_STORE, {
      id: folderId,
      name: "Vault",
      salt: legacyMeta.salt,
      verifierCiphertext: legacyMeta.verifierCiphertext,
      verifierIv: legacyMeta.verifierIv,
      createdAt: legacyMeta.createdAt || now,
      updatedAt: now,
    });
  }

  for (const note of notes) {
    if (note.id === VAULT_META_ID) continue;
    // Already migrated: has the new field and none of the old one.
    if (note.folderId !== undefined && note.vault === undefined) continue;

    const { vault, ...rest } = note;
    await db.put(NOTES_STORE, {
      ...rest,
      folderId: vault === true ? folderId : rest.folderId || null,
    });
  }

  if (legacyMeta) await db.delete(NOTES_STORE, VAULT_META_ID);
};

// One-shot: App's first read and the folder provider's first list both await
// the same run, so the folder list can't be read before the migration writes.
let migrationPromise = null;
export const migrateToFolders = () => (migrationPromise ??= runFolderMigration());

// ---------- Images ----------

export const saveImage = async (image) => {
  const db = await initDB();
  await db.put(IMAGES_STORE, image);
};

export const getImage = async (id) => {
  const db = await initDB();
  return db.get(IMAGES_STORE, id);
};

export const deleteImage = async (id) => {
  const db = await initDB();
  await db.delete(IMAGES_STORE, id);
};

export const getAllImages = async () => {
  const db = await initDB();
  return db.getAll(IMAGES_STORE);
};

// Atomically replace the entire local store with a snapshot's contents.
// Used by restore — wipes all three stores in a single transaction so a partial
// restore can't leave the device in a half-state.
export const replaceAll = async ({ notes = [], images = [], folders = [] }) => {
  const db = await initDB();
  const tx = db.transaction(
    [NOTES_STORE, IMAGES_STORE, FOLDERS_STORE],
    "readwrite",
  );
  const notesStore = tx.objectStore(NOTES_STORE);
  const imagesStore = tx.objectStore(IMAGES_STORE);
  const foldersStore = tx.objectStore(FOLDERS_STORE);
  await notesStore.clear();
  await imagesStore.clear();
  await foldersStore.clear();
  for (const folder of folders) {
    await foldersStore.put(folder);
  }
  for (const note of notes) {
    await notesStore.put(note);
  }
  for (const image of images) {
    await imagesStore.put(image);
  }
  await tx.done;
};

// Write a folder record and a set of its notes in one transaction.
//
// Exists because a folder's salt/verifier and its notes' ciphertext are only
// meaningful together: the salt/verifier say which passphrase derives the key,
// the ciphertext is what that key opens. Landing them separately (as a re-key
// loop of per-note saves followed by a folder save used to) leaves a window
// where notes are encrypted under a key the folder record can no longer
// validate — those notes are unopenable with either passphrase.
//
// Callers must finish ALL crypto before calling: with `idb`, a transaction
// auto-commits once the microtask queue drains with no pending IDB request,
// and a `crypto.subtle` promise is not one — awaiting it here would commit the
// tx early and make the next put throw TransactionInactiveError.
export const saveFolderWithNotes = async (folder, notes = []) => {
  const db = await initDB();
  const tx = db.transaction([NOTES_STORE, FOLDERS_STORE], "readwrite");
  const notesStore = tx.objectStore(NOTES_STORE);
  await tx.objectStore(FOLDERS_STORE).put(folder);
  for (const note of notes) {
    await notesStore.put(note);
  }
  await tx.done;
};

// Delete a folder together with its notes and their images in one transaction.
//
// Exists because the old per-item loop used a separate transaction per delete:
// fail partway through and a surviving note is left pointing at images that are
// already gone, rendering as broken `idb://` refs. One transaction removes that
// failure mode outright — it commits whole or rolls back whole, so no state
// exists where a note outlives its images, and the delete order inside the tx
// is therefore irrelevant.
export const deleteFolderCascade = async ({
  folderId,
  noteIds = [],
  imageIds = [],
}) => {
  const db = await initDB();
  const tx = db.transaction(
    [NOTES_STORE, IMAGES_STORE, FOLDERS_STORE],
    "readwrite",
  );
  const notesStore = tx.objectStore(NOTES_STORE);
  const imagesStore = tx.objectStore(IMAGES_STORE);
  for (const imageId of imageIds) {
    await imagesStore.delete(imageId);
  }
  for (const noteId of noteIds) {
    await notesStore.delete(noteId);
  }
  await tx.objectStore(FOLDERS_STORE).delete(folderId);
  await tx.done;
};
