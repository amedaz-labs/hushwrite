// Encrypted image storage — envelope encryption, one content encryption key
// (CEK) per image.
//
// The bytes are encrypted exactly once, under a random CEK. That CEK is then
// wrapped under whatever key opens the OWNING NOTE — the folder key for a
// folder note, the note's own derived key for a root note (i.e. precisely what
// `resolveKeyForNote` hands back).
//
// Why the indirection instead of encrypting the bytes under the note key
// directly: `changeFolderPassphrase` re-encrypts every note in a folder and
// has to do all of its crypto before its single transaction opens (see
// lib/folders.jsx). Direct encryption would mean buffering every image's
// plaintext AND ciphertext in memory for the length of a re-key. With an
// envelope, a re-key touches 32 bytes per image and never reads the image
// bytes at all.
//
// TWO RECORD SHAPES COEXIST, INDEFINITELY:
//   v: 1  -> { id, v, ciphertext (Blob), iv, wrappedKey, wrapIv, mime, size,
//              ownerNoteId, createdAt }
//   legacy -> { id, blob }        (no `v`; written before this change)
// There is no migration. Every reader branches on `record.v === 1`.
//
// `ciphertext` is stored as a Blob, not a Uint8Array, on purpose: IDB
// materializes a typed array into the JS heap on `get`, while a Blob stays a
// lazy handle. `rewrapImagesForKey` is where that pays off — it reads whole
// records for an entire folder and must never pull image bytes into memory.
// (Backup does NOT benefit: `backupSnapshot` base64s every image through
// `imageToWire` anyway, concurrently.)

import { v4 as uuid4 } from "uuid";
import {
  decryptBytes,
  encryptBytes,
  exportRawKey,
  generateContentKey,
  importRawKey,
} from "./crypto";
import {
  deleteImage,
  getAllImages,
  getAllNotes,
  getImage,
  saveImage,
} from "./db";

const toBytes = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

// ---------- Session CEK registry ----------
//
// An image can be uploaded into a note that has NO key yet: a brand-new draft
// waits for an explicit save so the user can supply a fresh passphrase. Those
// CEKs live here, in memory only, until the note's first save wraps them.
// Never persisted — an unsaved draft's images are unreadable after a reload,
// and `sweepOrphans` removes them.
const sessionKeys = new Map(); // imageId -> CryptoKey

// ---------- Object-URL cache ----------
//
// Byte-capped, LRU. Uncapped this is a mobile tab crash: decrypting a large
// JPEG holds roughly three live copies (record ciphertext, plaintext bytes,
// Blob), and a photo-heavy note resolves them all within a few frames.
const URL_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const urlCache = new Map(); // id -> { url, bytes }   (insertion order = LRU)
let urlCacheBytes = 0;

// Bumped by every revoke. A decrypt started before a lock and finishing after
// it would otherwise re-populate the cache with a live `blob:` URL belonging to
// a session that has ended — the exact thing revoking exists to prevent.
// `loadImageUrl` captures this before decrypting and drops the result if it
// moved.
let cacheEpoch = 0;

const dropCacheEntry = (id) => {
  const entry = urlCache.get(id);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  urlCache.delete(id);
  urlCacheBytes -= entry.bytes;
};

const cacheUrl = (id, url, bytes) => {
  dropCacheEntry(id);
  urlCache.set(id, { url, bytes });
  urlCacheBytes += bytes;
  // Evict oldest-first until we're back under the cap. Never evict the entry
  // just inserted, even if it alone exceeds the cap — the caller is about to
  // render it.
  for (const oldest of urlCache.keys()) {
    if (urlCacheBytes <= URL_CACHE_LIMIT_BYTES || urlCache.size <= 1) break;
    if (oldest === id) continue;
    dropCacheEntry(oldest);
  }
};

// Synchronous cache read. Crepe's `proxyDomURL` is called synchronously while
// a node renders and can only use a hit.
export const peekImageUrl = (id) => {
  const entry = urlCache.get(id);
  if (!entry) return null;
  // Touch: move to the end of the LRU order.
  urlCache.delete(id);
  urlCache.set(id, entry);
  return entry.url;
};

// Drop every decrypted image from memory. A `blob:` URL stays fetchable for as
// long as it is alive, so revoking is the only thing that actually takes the
// pictures away.
//
// This one does NOT touch the session key registry, and the split matters:
// it is what an editor unmount calls, and under StrictMode an unmount cleanup
// fires immediately after the first mount. Clearing the registry there would
// destroy the keys of images an import had just written.
export const revokeImageUrls = () => {
  for (const { url } of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  urlCacheBytes = 0;
  cacheEpoch++;
  // Drop the in-flight map too. Every pending promise captured the OLD epoch,
  // so each is now guaranteed to resolve `null` — and `loadImageUrl` would
  // hand that doomed promise to every later joiner, including callers that
  // started after this revoke and deserve a fresh decrypt. They'd get `null`,
  // fall back to the raw `idb://` URL, and stay stranded until the node
  // updates. Clearing lets the next caller start a real decrypt; the
  // `.finally` identity guard already stops a stale promise from evicting its
  // replacement.
  inFlight.clear();
};

// The full teardown: decrypted images AND the session content keys held for
// images a not-yet-saved draft uploaded.
//
// ONLY the note session may call this. The session CEK registry belongs to
// `useNoteSession`, which clears it in `wipeSession`, `lockKeepSelected`,
// `switchToNote` and `finalizeDelete` — all of them AFTER the pending edits
// have been flushed. Anything else calling it (an editor effect, a folder
// lock) destroys the content keys of a live, unrelated session: the next
// autosave throws, and because the note keeps no other copy of those keys the
// note then silently stops saving until the buffer is dropped by the next
// lock. Use `revokeImageUrls` instead.
export const revokeAllImageUrls = () => {
  revokeImageUrls();
  sessionKeys.clear();
};

// ---------- Reads ----------

// The session registry is consulted ONLY for a record that has no wrapped key —
// i.e. one whose CEK has never been persisted. Once a save wraps the key the
// caller must present the note's key like everyone else. (In practice
// `releaseSessionKeys` already drops the entry at that point; the guard is here
// so a `loadImageBlob(id, null)` can never open a *stored* image just because
// some entry with that id is loitering in a per-tab Map.)
const unwrapCek = async (record, key) => {
  if (!record.wrappedKey || !record.wrapIv) {
    return sessionKeys.get(record.id) || null;
  }
  if (!key) return null;
  const raw = await decryptBytes(
    toBytes(record.wrappedKey),
    key,
    toBytes(record.wrapIv),
  );
  try {
    return await importRawKey(raw);
  } finally {
    raw.fill(0);
  }
};

/**
 * Decrypt (or, for a legacy record, simply return) an image's blob.
 * Resolves to `null` when the image is missing or cannot be opened with `key`.
 */
export const loadImageBlob = async (id, key = null) => {
  const record = await getImage(id);
  if (!record) return null;
  if (record.v !== 1) return record.blob || null; // legacy plaintext
  try {
    const cek = await unwrapCek(record, key);
    if (!cek) return null;
    const ciphertext =
      record.ciphertext instanceof Blob
        ? new Uint8Array(await record.ciphertext.arrayBuffer())
        : toBytes(record.ciphertext);
    const plain = await decryptBytes(ciphertext, cek, toBytes(record.iv));
    return new Blob([plain], {
      type: record.mime || "application/octet-stream",
    });
  } catch (err) {
    console.error("[loadImageBlob] failed:", id, err);
    return null;
  }
};

// In-flight decrypts, so N concurrent callers for one id cost one decrypt.
// The cache above only memoizes COMPLETED resolutions, and the editor's
// pre-warm effect re-runs on every keystroke: without this, the whole cold
// window of a multi-megabyte photo is one redundant decrypt per keypress.
const inFlight = new Map(); // id -> Promise<string|null>

/**
 * Resolve an image id to an object URL, memoized in the byte-capped cache.
 */
export const loadImageUrl = (id, key = null) => {
  const hit = peekImageUrl(id);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const promise = (async () => {
    // Captured BEFORE the decrypt: if a lock lands while we're working, the
    // result belongs to an ended session and must not reach the cache.
    const epoch = cacheEpoch;
    const blob = await loadImageBlob(id, key);
    if (!blob) return null;
    if (epoch !== cacheEpoch) return null;
    // Another caller may have resolved the same id while we were decrypting.
    const raced = peekImageUrl(id);
    if (raced) return raced;
    const url = URL.createObjectURL(blob);
    cacheUrl(id, url, blob.size || 0);
    return url;
  })().finally(() => {
    if (inFlight.get(id) === promise) inFlight.delete(id);
  });

  inFlight.set(id, promise);
  return promise;
};

// ---------- Writes ----------

/**
 * Encrypt `blob` under a fresh CEK and persist it.
 *
 * `key` is the key that opens the owning note. Pass `null` when there isn't
 * one yet (a brand-new draft); the CEK is parked in the session registry and
 * the note's first save wraps it.
 */
export const putImage = async (blob, key = null, ownerNoteId = null) => {
  const id = uuid4();
  const cek = await generateContentKey();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { ciphertext, iv } = await encryptBytes(bytes, cek);

  const record = {
    id,
    v: 1,
    ciphertext: new Blob([ciphertext]),
    iv,
    wrappedKey: null,
    wrapIv: null,
    mime: blob.type || "application/octet-stream",
    size: blob.size ?? bytes.length,
    ownerNoteId: ownerNoteId || null,
    createdAt: new Date().toISOString(),
  };

  if (key) {
    const raw = await exportRawKey(cek);
    const wrapped = await encryptBytes(raw, key);
    raw.fill(0);
    record.wrappedKey = wrapped.ciphertext;
    record.wrapIv = wrapped.iv;
  } else {
    sessionKeys.set(id, cek);
  }

  await saveImage(record);
  return { id };
};

/**
 * Prepare the image records a note's save must land: wrap any session-only
 * CEKs under the note's key, and stamp ownership.
 *
 * Returns records; writes NOTHING. The caller lands them in the same
 * transaction as the note (`saveNoteWithImages`).
 *
 * Ownership is claim-on-first-save: a record with `ownerNoteId: null` is
 * unclaimed (freshly uploaded, or just imported) and this note takes it.
 *
 * NOTHING HERE THROWS. An image that cannot be claimed is skipped and its id
 * reported back, because the alternative — refusing to persist the note — is
 * far worse than a picture that doesn't render: the note silently stops saving
 * and the next lock discards the user's text. Two images get skipped:
 *
 *   `conflictIds` — already owned by a DIFFERENT note. Reachable by copying an
 *     `idb://` reference between notes (the Preview textarea shows the literal
 *     markdown, and Milkdown's own copy/paste preserves `node.attrs.src`).
 *     Re-wrapping would silently revoke the first note's access, so we don't.
 *   `orphanIds` — no wrapped key and no session key, i.e. the CEK died with a
 *     reload before the draft was ever saved. Nothing can open these again.
 *
 * The caller drops both sets from the note's stored `imageIds` (so a later
 * delete can't GC another note's image, and a dead record stays sweepable) and
 * surfaces a non-blocking warning.
 */
export const claimImagesForNote = async (imageIds, noteId, key) => {
  const empty = { records: [], conflictIds: [], orphanIds: [] };
  if (!imageIds?.length) return empty;
  const stored = await Promise.all(imageIds.map((id) => getImage(id)));
  const records = [];
  const conflictIds = [];
  const orphanIds = [];

  for (let i = 0; i < stored.length; i++) {
    const record = stored[i];
    // Missing, or a legacy plaintext blob: nothing to wrap, nothing to claim.
    if (!record || record.v !== 1) continue;
    const id = imageIds[i];

    if (record.ownerNoteId && record.ownerNoteId !== noteId) {
      conflictIds.push(id);
      continue;
    }

    const cek = sessionKeys.get(id);
    if (cek) {
      const raw = await exportRawKey(cek);
      const wrapped = await encryptBytes(raw, key);
      raw.fill(0);
      records.push({
        ...record,
        wrappedKey: wrapped.ciphertext,
        wrapIv: wrapped.iv,
        ownerNoteId: noteId,
      });
      continue;
    }

    // Orphan check FIRST. A record this note already owns can still have no
    // wrapped key (claimed by an import, then the CEK died with a reload). If
    // the ownership check ran first that record would fall through unreported,
    // stay in the note's `imageIds`, and so be pinned in `sweepOrphans`' keep
    // set forever — unrenderable, unwarnable, unsweepable.
    if (!record.wrappedKey) {
      orphanIds.push(id);
      continue;
    }
    if (record.ownerNoteId === noteId) continue; // already claimed and wrapped
    records.push({ ...record, ownerNoteId: noteId });
  }

  return { records, conflictIds, orphanIds };
};

// Drop session CEKs the caller has just persisted a wrapped copy of.
export const releaseSessionKeys = (imageIds = []) => {
  for (const id of imageIds) sessionKeys.delete(id);
};

/**
 * Re-wrap a set of images' CEKs from `oldKey` to `newKey`.
 *
 * Returns records; writes NOTHING — the caller lands them inside its own
 * transaction, so a folder re-key stays all-or-nothing.
 *
 * Never reads image bytes: `record.ciphertext` is a Blob handle that is copied
 * through untouched. Only the 32-byte wrapped key is decrypted and re-encrypted.
 */
export const rewrapImagesForKey = async (imageIds, oldKey, newKey) => {
  if (!imageIds?.length) return [];
  const records = await Promise.all(imageIds.map((id) => getImage(id)));
  const out = [];
  for (const record of records) {
    if (!record || record.v !== 1) continue; // legacy plaintext: nothing to re-wrap
    if (!record.wrappedKey || !record.wrapIv) continue; // never claimed
    const raw = await decryptBytes(
      toBytes(record.wrappedKey),
      oldKey,
      toBytes(record.wrapIv),
    );
    const wrapped = await encryptBytes(raw, newKey);
    raw.fill(0);
    out.push({
      ...record,
      wrappedKey: wrapped.ciphertext,
      wrapIv: wrapped.iv,
    });
  }
  return out;
};

// An unclaimed image must outlive any plausible editing session before it is
// considered abandoned. See the two-tab hazard in `sweepOrphans`.
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove encrypted images whose CEK only ever existed in memory — i.e. images
 * uploaded into a draft that was never saved, and which are therefore
 * undecryptable after a reload.
 *
 * Three independent guards, because the obvious predicate
 * (`!wrappedKey && !sessionKeys.has(id)`) is WRONG on its own: `sessionKeys` is
 * per-tab module state while IndexedDB is shared across every tab and window of
 * an installed PWA. Tab A pastes an image (on disk, unwrapped, CEK in Tab A's
 * memory); Tab B reloads, sees no wrapped key and an empty registry, and
 * deletes it out from under Tab A. So we also require:
 *   - the record is not referenced by any stored note's `imageIds`, and
 *   - it is older than `ORPHAN_MIN_AGE_MS` (a record with no parseable
 *     `createdAt` is never swept).
 * Either guard alone closes the two-tab race; both are cheap.
 */
export const sweepOrphans = async (keepIds = []) => {
  const keep = new Set(keepIds);
  const notes = await getAllNotes();
  for (const note of notes) {
    for (const id of note?.imageIds || []) keep.add(id);
  }

  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const all = await getAllImages();
  const doomed = all.filter((r) => {
    if (r?.v !== 1 || r.wrappedKey) return false;
    if (keep.has(r.id) || sessionKeys.has(r.id)) return false;
    const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
    return Number.isFinite(created) && created < cutoff;
  });
  for (const record of doomed) await deleteImage(record.id);
  return doomed.length;
};

/**
 * Destroy every legacy (unencrypted) image blob. There is no migration path —
 * this is the manual escape hatch that gets a profile to a clean state where
 * every stored image is encrypted. Notes that referenced them keep their
 * `idb://` links; those simply stop resolving.
 */
export const deleteLegacyImages = async () => {
  const all = await getAllImages();
  const legacy = all.filter((r) => r && r.v !== 1);
  for (const record of legacy) await deleteImage(record.id);
  return legacy.length;
};

/** How many stored images are still unencrypted. */
export const countLegacyImages = async () => {
  const all = await getAllImages();
  return all.filter((r) => r && r.v !== 1).length;
};
