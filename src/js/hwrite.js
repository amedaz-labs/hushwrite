
import {
  deriveKey,
  encryptContent,
  decryptContent,
  generateSalt,
} from "./crypto";
import { loadImageBlob, putImage } from "./imageStore";

// 1.0 = a single note, `content` is markdown.
// 2.0 = a whole folder, `content` is JSON `{ notes: [...] }`. Same envelope,
// same checksum/nonce/salt mechanics — only the payload differs, so one
// passphrase covers every note in the bundle.
export const HWRITE_VERSION = "1.0";
export const HWRITE_BUNDLE_VERSION = "2.0";
const SUPPORTED_VERSIONS = [HWRITE_VERSION, HWRITE_BUNDLE_VERSION];

const TEXT_ENCODER = new TextEncoder();

// --- base64 helpers (Uint8Array <-> string) ---------------------------------

const u8ToBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const base64ToU8 = (b64) => {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
};

const sha256Hex = async (str) => {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};


const IDB_IMG_REGEX = /(!\[[^\]]*\]\()idb:\/\/([0-9a-f-]+)(\))/gi;

// `imageKey` is the key that opens the note the markdown came from — the same
// one `resolveKeyForNote` returns. `loadImageBlob` handles both record shapes,
// so a legacy plaintext blob still inlines with `imageKey` left null.
const inlineImagesForExport = async (markdown, imageKey = null) => {
  const matches = [...markdown.matchAll(IDB_IMG_REGEX)];
  if (!matches.length) return markdown;

  const cache = new Map();
  for (const m of matches) {
    const id = m[2];
    if (cache.has(id)) continue;
    const blob = await loadImageBlob(id, imageKey);
    if (!blob) {
      cache.set(id, null);
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    cache.set(id, dataUrl);
  }

  return markdown.replace(IDB_IMG_REGEX, (full, pre, id, post) => {
    const dataUrl = cache.get(id);
    return dataUrl ? `${pre}${dataUrl}${post}` : full;
  });
};

// Inverse of inlineImagesForExport. Imported notes carry images as inline
// `data:image/...;base64,...` URIs in the markdown. Leaving those in place
// makes the editor lag badly because every keystroke re-renders megabytes of
// base64. We extract each data URI, persist the bytes to the images store
// (encrypted, via `putImage`), and rewrite the markdown to use lightweight
// `idb://uuid` references that the editor resolves on demand.
const DATA_URL_IMG_REGEX =
  /(!\[[^\]]*\]\()(data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)(\))/g;

const dataUrlToBlob = (dataUrl) => {
  const commaIdx = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, commaIdx);
  const b64 = dataUrl.slice(commaIdx + 1);
  const mimeMatch = meta.match(/data:([^;]+);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const bytes = base64ToU8(b64);
  return new Blob([bytes], { type: mime });
};

// `key` opens the note these images belong to. Pass `null` only when there
// isn't one yet (a plaintext import landing in the editor as an unsaved
// draft) — the CEK then waits in the session registry until that draft's
// first save wraps it.
export const rehydrateInlineImages = async (
  markdown,
  key = null,
  ownerNoteId = null,
) => {
  if (!markdown || !markdown.includes("data:image/")) {
    return { markdown: markdown || "", imageIds: [], changed: false };
  }
  const matches = [...markdown.matchAll(DATA_URL_IMG_REGEX)];
  if (!matches.length) {
    return { markdown, imageIds: [], changed: false };
  }
  // Dedup identical data URLs so a reused image shares one blob entry.
  const cache = new Map();
  const newIds = [];
  for (const m of matches) {
    const dataUrl = m[2];
    if (cache.has(dataUrl)) continue;
    const { id } = await putImage(dataUrlToBlob(dataUrl), key, ownerNoteId);
    cache.set(dataUrl, id);
    newIds.push(id);
  }
  const rewritten = markdown.replace(
    DATA_URL_IMG_REGEX,
    (full, pre, dataUrl, post) => {
      const id = cache.get(dataUrl);
      return id ? `${pre}idb://${id}${post}` : full;
    },
  );
  return { markdown: rewritten, imageIds: newIds, changed: true };
};

// --- public API -------------------------------------------------------------

// Encrypt (or not) the payload into `envelope`, checksum it, and hand back the
// downloadable Blob. Shared by the single-note and folder-bundle writers so
// both formats stay byte-compatible in everything except their payload.
const sealEnvelope = async (envelope, payload, { encrypted, passphrase }) => {
  let content;
  if (encrypted) {
    const salt = generateSalt();
    const key = await deriveKey(passphrase, salt);
    const { ciphertext, iv } = await encryptContent(payload, key);
    content = u8ToBase64(ciphertext);
    envelope.nonce = u8ToBase64(iv);
    envelope.salt = u8ToBase64(salt);
  } else {
    content = payload;
  }

  envelope.content = content;
  envelope.checksum = await sha256Hex(content);

  return new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
};

/**
 * Build a .hwrite Blob from a note. Pass `{ encrypted: true, passphrase }` to
 * produce an encrypted file; otherwise the file holds raw markdown.
 */
export const serializeNote = async (
  { title, markdown, createdAt, modifiedAt, imageKey = null },
  { encrypted, passphrase } = {},
) => {
  if (encrypted && !passphrase) {
    throw new Error("Passphrase required for encrypted export.");
  }

  const inlinedMarkdown = await inlineImagesForExport(markdown || "", imageKey);
  const now = new Date().toISOString();

  return sealEnvelope(
    {
      hwrite: HWRITE_VERSION,
      encrypted: !!encrypted,
      title: (title || "Untitled").trim() || "Untitled",
      created: createdAt || now,
      modified: modifiedAt || now,
    },
    inlinedMarkdown,
    { encrypted, passphrase },
  );
};

/**
 * Build a .hwrite Blob holding an entire folder. `notes` must already be
 * decrypted — the caller owns the folder key. Images are inlined per note so
 * the bundle is self-contained, and the whole set is sealed under one
 * passphrase, mirroring how the folder works inside the app.
 */
export const serializeFolder = async (
  { name, notes = [], imageKey = null },
  { encrypted, passphrase } = {},
) => {
  if (encrypted && !passphrase) {
    throw new Error("Passphrase required for encrypted export.");
  }

  const now = new Date().toISOString();
  const exported = [];
  for (const note of notes) {
    exported.push({
      title: (note.title || "Untitled").trim() || "Untitled",
      content: await inlineImagesForExport(note.markdown || "", imageKey),
      created: note.createdAt || now,
      modified: note.modifiedAt || now,
    });
  }

  return sealEnvelope(
    {
      hwrite: HWRITE_BUNDLE_VERSION,
      kind: "folder",
      encrypted: !!encrypted,
      title: (name || "Folder").trim() || "Folder",
      created: now,
      modified: now,
      // Plaintext, like the folder name itself — lets the import dialog show a
      // preview before anything is decrypted.
      note_count: exported.length,
    },
    JSON.stringify({ notes: exported }),
    { encrypted, passphrase },
  );
};


export const parseHwrite = async (fileText) => {
  let parsed;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("Not a valid .hwrite file (invalid JSON).");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Not a valid .hwrite file.");
  }
  if (!SUPPORTED_VERSIONS.includes(parsed.hwrite)) {
    throw new Error(
      `Unsupported .hwrite version: ${parsed.hwrite || "unknown"}. Please update Hushwrite.`,
    );
  }
  if (parsed.hwrite === HWRITE_BUNDLE_VERSION && parsed.kind !== "folder") {
    throw new Error("Not a valid .hwrite file (unknown bundle kind).");
  }

  const required = [
    "encrypted",
    "content",
    "checksum",
    "title",
    "created",
    "modified",
  ];
  for (const f of required) {
    if (!(f in parsed)) {
      throw new Error(`Not a valid .hwrite file (missing field: ${f}).`);
    }
  }
  if (typeof parsed.content !== "string" || typeof parsed.checksum !== "string") {
    throw new Error("Not a valid .hwrite file (bad field types).");
  }
  if (parsed.encrypted && (!parsed.nonce || !parsed.salt)) {
    throw new Error("Encrypted .hwrite file is missing nonce or salt.");
  }

  const expected = await sha256Hex(parsed.content);
  if (expected !== parsed.checksum) {
    throw new Error(
      "This file appears to be corrupted or modified. It cannot be safely imported.",
    );
  }

  return parsed;
};

export const isFolderBundle = (parsed) =>
  parsed?.hwrite === HWRITE_BUNDLE_VERSION && parsed?.kind === "folder";

// Decode the JSON payload of a folder bundle (the output of `decryptHwrite`)
// into the same note shape the rest of the app uses.
export const parseFolderPayload = (plaintext) => {
  let data;
  try {
    data = JSON.parse(plaintext);
  } catch {
    throw new Error("Folder file contents are unreadable.");
  }
  if (!data || !Array.isArray(data.notes)) {
    throw new Error("Folder file is missing its notes.");
  }
  return data.notes.map((n) => ({
    title:
      typeof n.title === "string" && n.title.trim() ? n.title.trim() : "Untitled",
    markdown: typeof n.content === "string" ? n.content : "",
    createdAt: n.created || null,
    modifiedAt: n.modified || null,
  }));
};

// Convert a parsed encrypted envelope's base64 fields back to raw bytes so the
// envelope can be persisted directly as a note record. Passphrase stays with
// the user — the note is opened with the normal unlock flow later.
export const hwriteEnvelopeToBytes = (parsed) => {
  if (!parsed.encrypted) {
    throw new Error("hwriteEnvelopeToBytes: envelope is not encrypted.");
  }
  return {
    ciphertext: base64ToU8(parsed.content),
    iv: base64ToU8(parsed.nonce),
    salt: base64ToU8(parsed.salt),
  };
};

export const decryptHwrite = async (parsed, passphrase) => {
  if (!parsed.encrypted) return parsed.content;
  const salt = base64ToU8(parsed.salt);
  const iv = base64ToU8(parsed.nonce);
  const ciphertext = base64ToU8(parsed.content);
  const key = await deriveKey(passphrase, salt);
  
  return decryptContent(ciphertext, key, iv);
};

export const downloadHwrite = (blob, title) => {
  const slug = (title || "note")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "note";
  const d = new Date();
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const filename = `${slug}-${yyyymmdd}.hwrite`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
};
