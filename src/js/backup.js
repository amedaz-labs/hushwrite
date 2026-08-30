import { api, isLoggedIn } from "./api";
import {
  getAllNotes,
  getAllImages,
  getAllFolders,
  replaceAll,
} from "./db";

const DEVICE_ID_KEY = "hushwrite-device-id";
const DEVICE_LABEL_KEY = "hushwrite-device-label";
const LAST_SNAPSHOT_ID_KEY = "hushwrite-last-snapshot-id";
const LAST_LOCAL_HASH_KEY = "hushwrite-last-local-hash";

// 1.1 replaced the singleton `vault_meta` + `vault: true` note flag with a
// `folders` array and a `folder_id` per note. 1.0 snapshots still restore —
// their vault is folded into one folder on the way in.
const SNAPSHOT_SCHEMA = "1.1";
const LEGACY_SCHEMA = "1.0";

// ---------- Device identity ----------

function uuid() {
  return crypto.randomUUID();
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getDeviceLabel() {
  return localStorage.getItem(DEVICE_LABEL_KEY) || "";
}

export function setDeviceLabel(label) {
  const trimmed = (label || "").trim();
  if (!trimmed) {
    localStorage.removeItem(DEVICE_LABEL_KEY);
    return "";
  }
  localStorage.setItem(DEVICE_LABEL_KEY, trimmed);
  return trimmed;
}

function defaultDeviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "This device";
}

export function getOrInitDeviceLabel() {
  return getDeviceLabel() || defaultDeviceLabel();
}

// ---------- Tracking pointers ----------

export function getLastSnapshotId() {
  return localStorage.getItem(LAST_SNAPSHOT_ID_KEY) || null;
}

function setLastSnapshotId(id) {
  if (id) localStorage.setItem(LAST_SNAPSHOT_ID_KEY, id);
  else localStorage.removeItem(LAST_SNAPSHOT_ID_KEY);
}

function setLastLocalHash(hash) {
  if (hash) localStorage.setItem(LAST_LOCAL_HASH_KEY, hash);
  else localStorage.removeItem(LAST_LOCAL_HASH_KEY);
}

function getStoredLocalHash() {
  return localStorage.getItem(LAST_LOCAL_HASH_KEY) || null;
}

// ---------- Binary helpers ----------

function arrayToBase64(arr) {
  if (!arr) return null;
  const bytes =
    arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer || arr);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

function base64ToArray(b64) {
  if (!b64) return null;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  return arrayToBase64(new Uint8Array(buf));
}

function base64ToBlob(b64, mime) {
  const bytes = base64ToArray(b64);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

// ---------- Note (de)serialization ----------

function noteToWire(note) {
  return {
    id: note.id,
    ciphertext: arrayToBase64(note.ciphertext),
    iv: arrayToBase64(note.iv),
    salt: arrayToBase64(note.salt),
    title_ciphertext: note.titleCiphertext
      ? arrayToBase64(note.titleCiphertext)
      : null,
    title_iv: note.titleIv ? arrayToBase64(note.titleIv) : null,
    title: note.title || null,
    folder_id: note.folderId || null,
    image_ids: Array.isArray(note.imageIds) ? note.imageIds : [],
    created_at: note.createdAt || null,
    updated_at: note.updatedAt || null,
  };
}

function wireToNote(wire) {
  return {
    id: wire.id,
    ciphertext: base64ToArray(wire.ciphertext),
    iv: base64ToArray(wire.iv),
    salt: base64ToArray(wire.salt),
    titleCiphertext: wire.title_ciphertext
      ? base64ToArray(wire.title_ciphertext)
      : null,
    titleIv: wire.title_iv ? base64ToArray(wire.title_iv) : null,
    title: wire.title || "",
    folderId: wire.folder_id || null,
    imageIds: Array.isArray(wire.image_ids) ? wire.image_ids : [],
    createdAt: wire.created_at || null,
    updatedAt: wire.updated_at || null,
  };
}

// A folder's wire form carries only what's needed to re-derive its key on
// another device: the salt and the encrypted verifier. The key itself is never
// serialized. The name travels in plaintext so a locked folder is still
// identifiable after a restore.
function folderToWire(folder) {
  return {
    id: folder.id,
    name: folder.name || "",
    salt: arrayToBase64(folder.salt),
    verifier_ciphertext: folder.verifierCiphertext
      ? arrayToBase64(folder.verifierCiphertext)
      : null,
    verifier_iv: folder.verifierIv ? arrayToBase64(folder.verifierIv) : null,
    created_at: folder.createdAt || null,
    updated_at: folder.updatedAt || null,
  };
}

function wireToFolder(wire) {
  return {
    id: wire.id,
    name: wire.name || "Folder",
    salt: base64ToArray(wire.salt),
    verifierCiphertext: wire.verifier_ciphertext
      ? base64ToArray(wire.verifier_ciphertext)
      : null,
    verifierIv: wire.verifier_iv ? base64ToArray(wire.verifier_iv) : null,
    createdAt: wire.created_at || null,
    updatedAt: wire.updated_at || null,
  };
}

async function imageToWire(image) {
  const blob = image.blob;
  const mime = blob?.type || "application/octet-stream";
  const data = blob ? await blobToBase64(blob) : "";
  return { id: image.id, mime, data };
}

function wireToImage(wire) {
  return { id: wire.id, blob: base64ToBlob(wire.data, wire.mime) };
}

// ---------- Local snapshot building ----------

async function buildLocalState() {
  const notes = await getAllNotes();
  const folders = await getAllFolders();
  const images = await getAllImages();
  return { notes, folders, images };
}

function buildManifest(notes) {
  return notes.map((n) => ({
    id: n.id,
    updated_at: n.updatedAt || null,
    folder_id: n.folderId || null,
  }));
}

async function hashManifest(manifest) {
  const text = JSON.stringify(manifest);
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return arrayToBase64(new Uint8Array(digest));
}

// ---------- Public API ----------

/**
 * Build a snapshot from current local state and upload it.
 * Returns the metadata of the new snapshot.
 */
export async function backupSnapshot() {
  if (!isLoggedIn()) throw new Error("Not signed in to a backup account");

  const { notes, folders, images } = await buildLocalState();
  const manifest = buildManifest(notes);

  const wireNotes = notes.map(noteToWire);
  const wireImages = await Promise.all(images.map(imageToWire));
  const wireFolders = folders.map(folderToWire);

  const blobObj = {
    schema: SNAPSHOT_SCHEMA,
    notes: wireNotes,
    folders: wireFolders,
    images: wireImages,
  };
  const blob = JSON.stringify(blobObj);

  const created = await api.createSnapshot({
    device_id: getDeviceId(),
    device_label: getOrInitDeviceLabel(),
    note_count: notes.length,
    image_count: images.length,
    // Server column predates folders; it now means "has encrypted folders".
    has_vault: folders.length > 0,
    manifest,
    blob,
  });

  setLastSnapshotId(created.id);
  setLastLocalHash(await hashManifest(manifest));
  return created;
}

/**
 * Fetch the list of snapshots (metadata + manifest, no blob).
 */
export async function listSnapshots() {
  if (!isLoggedIn()) return { snapshots: [], limit: 0 };
  return api.listSnapshots();
}

/**
 * Restore a snapshot, atomically replacing all local state.
 */
export async function restoreSnapshot(snapshotId) {
  if (!isLoggedIn()) throw new Error("Not signed in to a backup account");

  const snap = await api.getSnapshot(snapshotId);
  if (!snap || !snap.blob) throw new Error("Snapshot is empty or unreadable");

  let parsed;
  try {
    parsed = JSON.parse(snap.blob);
  } catch {
    throw new Error("Snapshot data is corrupt");
  }
  if (
    !parsed ||
    (parsed.schema !== SNAPSHOT_SCHEMA && parsed.schema !== LEGACY_SCHEMA)
  ) {
    throw new Error("Snapshot uses an unsupported format");
  }

  const wireNotes = Array.isArray(parsed.notes) ? parsed.notes : [];
  const wireImages = Array.isArray(parsed.images) ? parsed.images : [];

  let folders;
  let notes;
  if (parsed.schema === LEGACY_SCHEMA) {
    // Pre-folders snapshot: fold the singleton vault into one folder and
    // reparent its notes, mirroring `migrateToFolders`.
    const wireVault = parsed.vault_meta || null;
    if (wireNotes.some((n) => n && n.vault) && !wireVault) {
      throw new Error(
        "Snapshot is missing vault metadata; refusing to restore.",
      );
    }
    const legacyFolderId = wireVault ? crypto.randomUUID() : null;
    folders = wireVault
      ? [wireToFolder({ ...wireVault, id: legacyFolderId, name: "Vault" })]
      : [];
    notes = wireNotes.map((w) => ({
      ...wireToNote(w),
      folderId: w.vault ? legacyFolderId : null,
    }));
  } else {
    folders = (Array.isArray(parsed.folders) ? parsed.folders : []).map(
      wireToFolder,
    );
    notes = wireNotes.map(wireToNote);
    const known = new Set(folders.map((f) => f.id));
    if (notes.some((n) => n.folderId && !known.has(n.folderId))) {
      throw new Error(
        "Snapshot references a missing folder; refusing to restore.",
      );
    }
  }

  const images = wireImages.map(wireToImage);

  await replaceAll({ notes, images, folders });

  setLastSnapshotId(snap.id);
  const localManifest = buildManifest(notes);
  setLastLocalHash(await hashManifest(localManifest));
}

export async function deleteSnapshot(id) {
  if (!isLoggedIn()) throw new Error("Not signed in to a backup account");
  await api.deleteSnapshot(id);
  if (getLastSnapshotId() === id) setLastSnapshotId(null);
}

export async function setSnapshotPinned(id, pinned) {
  if (!isLoggedIn()) throw new Error("Not signed in to a backup account");
  await api.patchSnapshot(id, { pinned: !!pinned });
}

export async function renameSnapshotDevice(id, label) {
  if (!isLoggedIn()) throw new Error("Not signed in to a backup account");
  await api.patchSnapshot(id, { device_label: label });
}

// ---------- Diffs ----------

/**
 * Compute the diff between local state and a snapshot manifest.
 * Returns counts and the per-id breakdown.
 */
export async function computeDiff(snapshotManifest) {
  const { notes } = await buildLocalState();
  const localById = new Map(notes.map((n) => [n.id, n]));
  const remoteById = new Map(
    (snapshotManifest || []).map((m) => [m.id, m]),
  );

  const added = []; // in snapshot, not local
  const removed = []; // in local, not in snapshot
  const updatedNewer = []; // snapshot newer than local
  const updatedOlder = []; // local newer than snapshot
  const same = [];

  for (const [id, m] of remoteById) {
    const local = localById.get(id);
    if (!local) {
      added.push(id);
      continue;
    }
    const localT = new Date(local.updatedAt || 0).getTime();
    const remoteT = new Date(m.updated_at || 0).getTime();
    if (remoteT > localT) updatedNewer.push(id);
    else if (localT > remoteT) updatedOlder.push(id);
    else same.push(id);
  }
  for (const [id] of localById) {
    if (!remoteById.has(id)) removed.push(id);
  }

  return { added, removed, updatedNewer, updatedOlder, same };
}

/**
 * Snapshot of cloud state from the perspective of *this* device, used by the
 * TopNav badge. Returns one of:
 *   - "no-account"      not signed in
 *   - "no-snapshots"    signed in, cloud is empty
 *   - "up-to-date"      local matches the latest snapshot
 *   - "needs-backup"    local has changes since the latest backup
 *   - "newer-available" cloud has a snapshot newer than the one we restored
 *   - "diverged"        both: local has changes AND cloud has a newer snapshot
 *                       from a different device
 */
export async function getCloudState() {
  if (!isLoggedIn()) return { state: "no-account" };

  let snapshots;
  try {
    const data = await api.listSnapshots();
    snapshots = data.snapshots || [];
  } catch (err) {
    return { state: "error", error: err.message };
  }

  if (!snapshots.length) {
    const { notes } = await buildLocalState();
    return {
      state: "no-snapshots",
      latest: null,
      localCount: notes.length,
    };
  }

  const latest = snapshots[0];
  const lastId = getLastSnapshotId();
  const storedHash = getStoredLocalHash();

  const { notes } = await buildLocalState();
  const localManifest = buildManifest(notes);
  const localHash = await hashManifest(localManifest);
  const localChanged = storedHash !== localHash;

  // The "newer available" notion compares against the snapshot this device
  // last touched. If we've never restored or backed up, but cloud has data,
  // the "newer" check is implicit.
  const knownBaseline = lastId
    ? snapshots.find((s) => s.id === lastId)
    : null;
  const baselineCreatedAt = knownBaseline ? knownBaseline.created_at : null;
  const newerAvailable =
    !lastId ||
    (baselineCreatedAt &&
      new Date(latest.created_at).getTime() >
        new Date(baselineCreatedAt).getTime() &&
      latest.id !== lastId);

  if (localChanged && newerAvailable) {
    return {
      state: "diverged",
      latest,
      snapshots,
      localCount: notes.length,
    };
  }
  if (localChanged) {
    return {
      state: "needs-backup",
      latest,
      snapshots,
      localCount: notes.length,
    };
  }
  if (newerAvailable) {
    return {
      state: "newer-available",
      latest,
      snapshots,
      localCount: notes.length,
    };
  }
  return {
    state: "up-to-date",
    latest,
    snapshots,
    localCount: notes.length,
  };
}

/**
 * Reset local pointers (used after sign-out so the next sign-in shows a
 * clean state instead of stale "diverged" warnings).
 */
export function resetBackupPointers() {
  setLastSnapshotId(null);
  setLastLocalHash(null);
}
