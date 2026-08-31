
const PBKDF2_ITERATIONS = 600_000;

export const generateSalt = (length = 16) => {
  return crypto.getRandomValues(new Uint8Array(length));
};

export const deriveKey = async (passphrase, salt) => {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export const encryptContent = async (content, key) => {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = enc.encode(content);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  return {
    ciphertext: new Uint8Array(ciphertextBuffer),
    iv,
  };
};

export const decryptContent = async (ciphertext, key, iv) => {
  const dec = new TextDecoder();
  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return dec.decode(decryptedBuffer);
  } catch (err) {
    // Log the real cause for debugging; surface a friendly message to callers.
    console.error("[decrypt] failed:", err);
    throw new Error("Note corrupted, tampered, or wrong passphrase.");
  }
};

// ---------- Binary payloads ----------
//
// Same AES-GCM primitive as the two above, same random 12-byte IV, minus the
// text codec. The string versions CANNOT be reused for image bytes: encoding
// runs them through TextEncoder/TextDecoder, and `TextDecoder` silently
// substitutes U+FFFD for any byte sequence that isn't valid UTF-8 — the image
// would come back corrupted with no error anywhere.

export const encryptBytes = async (bytes, key) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    bytes,
  );
  return { ciphertext: new Uint8Array(ciphertextBuffer), iv };
};

export const decryptBytes = async (ciphertext, key, iv) => {
  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new Uint8Array(decryptedBuffer);
  } catch (err) {
    // Non-distinguishing, exactly like decryptContent: tamper and wrong-key
    // must look identical from the outside.
    console.error("[decryptBytes] failed:", err);
    throw new Error("Image corrupted, tampered, or wrong passphrase.");
  }
};

// A per-image content encryption key. `extractable: true` — unlike the
// passphrase-derived keys, a freshly GENERATED CEK has to leave the WebCrypto
// boundary once, so it can be wrapped under the key that opens the owning note.
// Neither `deriveKey` nor `importRawKey` is extractable, and neither should
// become so: nothing ever needs to export those.
export const generateContentKey = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);

export const exportRawKey = async (key) =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

// `extractable: false`. A key that arrives here came from unwrapping a stored
// `wrappedKey`, and nothing ever re-exports one — `rewrapImagesForKey` works on
// the wrapped bytes directly, and `claimImagesForNote` only exports keys from
// `generateContentKey`. Non-extractable keeps the raw bytes inside WebCrypto.
export const importRawKey = (raw) =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
