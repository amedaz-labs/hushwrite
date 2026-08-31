# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hushwrite is an offline-first encrypted notes PWA with an optional backend for backup and sync. All notes and images live in the browser's IndexedDB; note content is encrypted with AES-GCM using a key derived from a user-supplied passphrase. The app is fully functional without the backend — the server is purely additive for cross-device sync.

Note: this directory sits inside the larger `tbites` monorepo, but hushwrite is an unrelated standalone app — ignore the parent `tbites/CLAUDE.md` (Medusa/Next.js storefront) when working here.

## Commands

**All Node/npm commands run inside Docker — never on the host.** See
[docker-compose.yml](docker-compose.yml). Bare `npm`/`npx`/`node` is blocked by a
`permissions.deny` rule in `~/.claude/settings.json`; containerize the command rather
than asking for an exception.

First run (populates the `node_modules` named volumes):
```bash
docker compose run --rm app npm install
docker compose run --rm app sh -c "cd api && npm install"
```

### Frontend (PWA)
```bash
docker compose up dev                        # Vite dev server → http://localhost:4874
docker compose run --rm app npm run build    # Production build to dist/
docker compose run --rm app npm run preview  # Preview built app
docker compose run --rm app npm run lint     # ESLint (flat config in eslint.config.js)
```

### Backend API ([api/](api/))
```bash
docker compose up api                                     # Wrangler → http://localhost:8787
docker compose run --rm api npm run deploy                # Deploy to Cloudflare Workers
docker compose run --rm api npm run db:migrate            # D1 schema migration (local)
docker compose run --rm api npm run db:migrate:prod       # D1 schema migration (production)
```

`node_modules` lives in named volumes, not the host bind mount — native binaries
(rolldown, esbuild) are platform-specific, so a macOS-installed tree breaks in Linux.
After changing `package.json`, re-run the `npm install` line above.

There is no test suite.

## Architecture

### Stack
- **React 19** + **Vite 8**, JSX (no TypeScript; `jsconfig.json` provides the `@/*` → `src/*` alias also defined in [vite.config.js](vite.config.js))
- **Tailwind CSS 3** + **shadcn/ui** style primitives in [src/components/ui/](src/components/ui/) (Radix-based: dialog, alert-dialog, button, input)
- **`@milkdown/crepe`** + **`@milkdown/react`** power the markdown editor (see [components/MilkdownEditor.jsx](src/components/MilkdownEditor.jsx)); **`marked`** + **`highlight.js`** render preview HTML
- **idb** wraps IndexedDB; **vite-plugin-pwa** registers a service worker (autoUpdate)
- **html2pdf.js** + **dompurify** drive note export/sanitization
- **react-hot-toast** for notifications

### Crypto layer — [src/js/crypto.js](src/js/crypto.js)
- `deriveKey(passphrase, salt)` — PBKDF2-SHA256, **600k iterations** → AES-GCM 256-bit key
- `encryptContent` — random 12-byte IV per encryption; AES-GCM auth tag is the integrity check (no separate plaintext hash is stored)
- `decryptContent` — any failure (tamper, wrong passphrase) is surfaced as a generic "Note corrupted, tampered, or wrong passphrase" error so the two cases are indistinguishable
- `encryptBytes` / `decryptBytes` — the same AES-GCM call for binary payloads (image bytes, wrapped keys). Do **not** route bytes through `encryptContent`: `TextDecoder` silently substitutes U+FFFD for invalid UTF-8, corrupting the data with no error
- `generateContentKey` / `exportRawKey` / `importRawKey` — per-image content keys. Only `generateContentKey` is `extractable: true`, because a fresh CEK must leave WebCrypto once to be wrapped; `deriveKey` and `importRawKey` both produce non-extractable keys

### Data layer — [src/js/db.js](src/js/db.js)
Single IndexedDB database `hushwrite-db` (version 3) with three stores keyed by `id`:
- `notes` — encrypted note records
- `images` — image records referenced from notes by `idb://<uuid>` URIs in the markdown
- `folders` — one record per encrypted folder

A note record persists `{ id, ciphertext, iv, salt, title, titleCiphertext, titleIv, imageIds, folderId, createdAt, updatedAt }`. **Title is encrypted separately** with its own IV (under the same key); the plaintext `title` field on disk is legacy/best-effort and consumers should prefer the ciphertext pair when available. Preserve all of these when modifying the save/load path.

A folder record persists `{ id, name, salt, verifierCiphertext, verifierIv, createdAt, updatedAt }` — everything needed to re-derive and validate the folder key, and nothing that reveals its contents. **`name` is plaintext** so a locked folder is still identifiable in the sidebar.

`migrateToFolders()` is a one-way migration that must finish before anything reads the `notes` or `folders` stores. It is awaited from **two** call sites — [App.jsx](src/App.jsx) before its first note read, and `FolderProvider` in [lib/folders.jsx](src/lib/folders.jsx) before its first folder list — because the provider must not read the folders store before the migration writes the folder into it. The run-once guarantee comes from a **module-level memoized promise** in [db.js](src/js/db.js) (`migrationPromise ??= runFolderMigration()`), not from having a single caller: both awaits resolve on the same run. Removing the second call site reintroduces the bug where migrated notes render nowhere on first boot; removing the memo lets both call sites run the migration concurrently — each reads the legacy metadata before the other deletes it and mints its own folder id, leaving **two "Vault" folders** with the notes attached to only one. It converts a pre-v3 profile — singleton vault metadata under the reserved id `VAULT_META_ID = "__vault_meta__"` plus notes flagged `vault: true` — into a folder named "Vault" and reparents those notes via `folderId`. **No note is re-encrypted**: the folder inherits the vault's original salt, so the user's existing passphrase still derives the same key.

When changing the schema, bump `DB_VERSION` and extend the `upgrade` callback.

### Folders — [src/lib/folders.jsx](src/lib/folders.jsx)
`FolderProvider` (mounted at the App root) caches one AES-GCM key per unlocked folder in memory (`folderId -> { key, salt }`, never persisted). Each folder stores a salt plus an encrypted verifier string that `unlockFolder` decrypts to validate the passphrase — the verifier plaintext is `"hushwrite:vault:v1"` and **must not change**, or folders migrated from the legacy vault stop opening.

The model the UI presents: every item is encrypted, and a **folder shares one passphrase across all the notes in it**. A note with `folderId: null` is a root note carrying its own passphrase — a leaf row in the same sidebar tree, not a separate section.

- Notes with a `folderId` open with no per-note prompt once that folder is unlocked; the first note you open in a locked folder prompts once and unlocks the whole folder
- `changeFolderPassphrase` re-encrypts every note in the folder; `moveNoteToFolder` re-encrypts one note under a different lock (into a folder, or back to the root with a fresh passphrase)
- **Folder re-key is all-or-nothing.** A folder's salt/verifier and its notes' ciphertext are only valid together, so `changeFolderPassphrase` runs in two phases: every note is decrypted and re-encrypted **in memory first** (buffering ciphertext only — never an array of plaintext), then the folder record and all its notes land in **one** IndexedDB transaction via `saveFolderWithNotes`. Any failure in the crypto phase aborts with "passphrase unchanged" and writes nothing. Do not simplify this back into a per-note save loop — and note the hard constraint that forces the split: with `idb`, a transaction auto-commits across any non-IDB await, so **no crypto can happen inside an open transaction**. `removeFolder` has no two-phase structure — there is no crypto to do — but it does the same collect-then-commit: gather the folder's note and image ids, then hand them to `deleteFolderCascade` for a single transaction
- An **open editor session adopts the new key** on re-key rather than locking (see `useNoteSession`), and the trailing `setKeys` is a functional updater that is a **no-op if the folder locked mid-flight** (`prev[id]` absent) — the folder was unlocked at entry, so its key being gone at commit time means a lock landed during the operation, and re-inserting it would silently re-unlock it. This covers `lockAll`, per-folder `lockFolder`, and any future lock path with no counter to remember
- `IDLE_LOCK_MS` (15 min) is exported here and shared with `useNoteSession` so there is one lock rule to explain. Folder keys drop on idle, on tab hide, and on reload
- The idle timer and the `visibilitychange` / `pagehide` listeners are armed **unconditionally**, not only while a folder key is in memory. Decrypted data can exist precisely *because* everything is locked (a deferred import parks decrypted markdown in `NoteList`'s state while it waits for its destination folder's key), so gating the listeners on "is something unlocked" would leave exactly that case with no lock at all
- `lockEpoch` is a counter bumped on **every** `lockAll()` (idle, tab hide, pagehide, manual lock). **Anything holding decrypted data outside the provider must drop it when the epoch changes** — that is the contract for state the provider can't clear itself. `NoteList`'s pending-import effect is the current consumer; the clear must be synchronous, and any in-flight work must re-check its claim after its last `await` so a lock actually aborts it

`useFolders()` reads context; `isFolderUnlocked(id)` is the locked/unlocked test.

### Note session — [src/hooks/useNoteSession.js](src/hooks/useNoteSession.js)
Owns all per-note crypto/lifecycle state via refs. `resolveKeyForNote` is the single place that decides which key opens a note (folder key vs. per-note passphrase); `sessionFolderIdRef` tracks which folder, if any, owns the key in memory. Notable behaviors:
- Autosave debounce **1500 ms**; idle-lock `IDLE_LOCK_MS` (**15 min**, imported from [lib/folders.jsx](src/lib/folders.jsx))
- A note inside a folder runs **no** session idle timer — the folder owns the lock, and an effect tears the session down when its folder's key disappears. That effect compares key **identity**, not set membership: a re-key replaces the entry without the id ever leaving the unlocked set, so it `adoptSessionKey`s the new key instead of locking (locking would flush pending edits under the stale key)
- Autosave only runs when there is both a `currentId` AND an in-memory session key — brand-new drafts wait for an explicit `saveManual` so the user can supply a fresh passphrase
- `lock()` flushes pending edits, then drops the key but **keeps `currentId`** so the sidebar selection survives — re-entering the passphrase resumes the same note
- `switchToNote()` autosaves the outgoing note, moves the highlight, then prompts for the new note's passphrase; wrong passphrase leaves the user on the locked-card UI rather than reverting
- `visibilitychange` / `pagehide` lock automatically; `beforeunload` warns when dirty
- Three delete paths: `deleteCurrent` (root note — verify passphrase), `deleteFolderNote` (folder key already authorized, confirm only), `forceDeleteCurrent` (caller-enforced age gate, e.g. 30-day rule)
- On unlock, `rehydrateInlineImages` lifts any inline `data:image/...;base64` URIs out of the markdown into the `images` store (encrypted, under the key that just opened the note) and rewrites them to `idb://<uuid>` — keeps the editor responsive on imported notes
- `persistNote` lands the note record, its image records and the image GC in ONE transaction (`saveNoteWithImages`). It only inspects images that are *new* to the note, so a steady-state autosave adds exactly one await (a `claimImagesForNote` that returns immediately on an empty list) and the delete/save race documented around `finalizeDelete` barely widens
- `claimImagesForNote` **never throws**. An image it can't claim — owned by another note, or one whose key died with a reload — is dropped from the record's `imageIds` and reported back so `persistNote` can toast a deduped, non-blocking warning. Refusing to write the body over an image problem is what made a note silently stop saving and then lose its buffer on the next lock; don't reintroduce it

### Image storage — [src/js/imageStore.js](src/js/imageStore.js)
Images are referenced from markdown as `![alt](idb://<uuid>)`. On save, `extractImageIds` walks the markdown and GC's any image records no longer referenced by the note. On `.hwrite` export, `inlineImagesForExport` swaps `idb://` refs back to data URIs so the file is self-contained.

**Envelope encryption, new images only.** Each image gets a random content encryption key (CEK); the bytes are encrypted once under the CEK, and the CEK is wrapped under the key that opens the *owning note* — exactly what `resolveKeyForNote` returns. The indirection is what keeps a folder re-key cheap: `changeFolderPassphrase` must finish all crypto before its single transaction opens, so direct encryption would mean buffering every image's plaintext *and* ciphertext in memory. With an envelope, a re-key touches 32 bytes per image and never reads the image bytes.

**Two record shapes coexist indefinitely. Every reader branches on `record.v === 1`.**
- `v: 1` — `{ id, v, ciphertext (Blob), iv, wrappedKey, wrapIv, mime, size, ownerNoteId, createdAt }`
- legacy (no `v`) — `{ id, blob }`, plaintext, written before this change

There is **no migration** and there must not be one: no key exists at `openDB` time, and `initDB` runs on paths that execute before any unlock — which is also why `DB_VERSION` stays at 3. The manual escape hatch is "Delete unencrypted images" in [BackupPanel](src/components/BackupPanel.jsx).

`ciphertext` is a **Blob**, not a `Uint8Array`: IDB materializes a typed array into the heap on every `get`, while a Blob stays a lazy handle. `rewrapImagesForKey` is where that pays off — it reads whole records for every image in a folder and touches only the 32-byte wrapped key. Backup does *not* benefit: `backupSnapshot` base64s every image concurrently through `imageToWire` regardless. `iv` / `wrappedKey` / `wrapIv` stay `Uint8Array`, matching note records.

Notable pieces:
- A module-level **session CEK registry** holds keys for images uploaded before any note key exists (a brand-new draft). Never persisted; `persistNote` wraps them on the note's first save, `sweepOrphans` deletes any that didn't make it
- `loadImageUrl` memoizes object URLs in a **64 MB byte-capped LRU** and de-dupes in-flight decrypts; `revokeImageUrls` drops the URLs, `revokeAllImageUrls` drops the URLs *and* the session keys. **Only `useNoteSession` may call `revokeAllImageUrls`**, and only after flushing — the registry is the sole copy of an unsaved image's key, so anything else (an editor effect, a folder lock) destroying it breaks a live session's saves
- `rewrapImagesForKey` **returns records and writes nothing** — the caller lands them in its own transaction, so a folder re-key stays all-or-nothing
- Images shared between two notes are **not** supported (copying an image node in Milkdown keeps the same `idb://` uuid). `claimImagesForNote` reports a mismatched `ownerNoteId` back to the caller rather than re-wrapping and orphaning the first note's access
- `sweepOrphans` only deletes an unwrapped record that is **unreferenced by every stored note AND older than 24h**. Its `sessionKeys` check is not sufficient on its own: that Map is per-tab, IndexedDB is not, so a second tab would otherwise delete an image the first has open but unsaved

### Modal queue — [src/hooks/useModalQueue.js](src/hooks/useModalQueue.js)
Promise-returning modal manager. `open(spec)` returns a Promise; opening a new modal while one is pending **rejects the previous Promise with `"superseded"`**. Confirm/cancel handlers are bound to a per-open `id` so late-firing Radix lifecycle events can't settle a modal that was opened afterwards. Treat `cancelled` and `superseded` as "quiet" errors that should not toast (see `isQuietError` / `isQuietErr`).

### .hwrite files — [src/js/hwrite.js](src/js/hwrite.js)
Portable export format, two versions sharing one envelope shape `{ hwrite, encrypted, title, created, modified, content, checksum }` (encrypted envelopes additionally carry base64 `nonce` and `salt`, and `sealEnvelope` writes both):

- **`1.0`** — a single note. `content` is markdown. `serializeNote` writes it; `hwriteEnvelopeToBytes` lets the import path stash the encrypted envelope directly as a note record so the user can open it later with the normal unlock flow.
- **`2.0`** — a whole folder, marked `kind: "folder"`. `content` is JSON `{ notes: [{ title, content, created, modified }] }`, so one passphrase covers the whole bundle exactly like the folder does in-app. `serializeFolder` writes it, `isFolderBundle` detects it, `parseFolderPayload` decodes it. Plaintext `note_count` rides along so the import dialog can preview before decrypting.

`parseHwrite` validates the version, required fields, and SHA-256 checksum for both. Images are inlined as data URIs on export and lifted back into the `images` store by `rehydrateInlineImages` on import, so a bundle is self-contained.

Folder export lives in the folder row's overflow menu (unlocked folders only, since the notes must be decrypted first). Importing a folder bundle **always creates a new folder** — for an encrypted file the file's passphrase becomes the new folder's passphrase, so it round-trips with one entry; merging into an existing folder is deliberately not offered.

### Component layout — [src/](src/)
- [App.jsx](src/App.jsx) is the single top-level component. It owns canonical state (`notes`, `currentId`, `selectedNote`, `markdown`, `title`, `activeFolderId`, `isComposingNew`) and a session-only `titleCache` (plaintext titles keyed by note id, populated on unlock/save) so the sidebar can show real titles instead of "Encrypted note". `activeFolderId` is the folder new notes are filed into (`null` = a root note with its own passphrase). There is no router and no global state library; `FolderProvider` and the theme provider are the only React contexts.
- [components/BackupPanel.jsx](src/components/BackupPanel.jsx) — login/register + snapshot backup/restore UI for the optional backend, opened from TopNav. Owns its own `authed` state; the editor never gates on it
- [components/Markdown.jsx](src/components/Markdown.jsx) — editor host; wires `useNoteSession` + `useModalQueue` + `useFolders` and renders the [MilkdownEditor](src/components/MilkdownEditor.jsx), [Preview](src/components/Preview.jsx), [PassPhraseModal](src/components/PassPhraseModal.jsx), and [DeleteModal](src/components/DeleteModal.jsx)
- [components/MilkdownEditor.jsx](src/components/MilkdownEditor.jsx) — Crepe-based markdown editor wrapper. Its `proxyDomURL` returns a **Promise** for `idb://` URLs; Crepe's image NodeView (`bindAttrs`) awaits a non-string return and assigns `src.value` itself. Don't return a synchronous placeholder and patch `img.src` from a MutationObserver — `bindAttrs` re-runs on every NodeView update and overwrites DOM written behind Vue's back. On failure it returns the original `idb://` URL — the browser can't fetch that scheme, so the image just doesn't render. There is **no** broken-image glyph (Crepe writes an empty `alt`): an `image-block` collapses to a blank 100px box (its CSS `min-height` floor), an `image-inline` to nothing at all. The real notice is the toast `persistNote` raises for an image it couldn't claim
- [components/Preview.jsx](src/components/Preview.jsx) — the right-hand pane: an **editable raw-markdown `<textarea>`** (line/cursor tracking + scroll sync), not a rendered preview. It uses neither `marked` nor DOMPurify — the only `marked` consumer is [js/notePdf.js](src/js/notePdf.js)
- [components/PassPhraseModal.jsx](src/components/PassPhraseModal.jsx), [components/DeleteModal.jsx](src/components/DeleteModal.jsx) — extracted modal components driven by `useModalQueue`
- [components/NoteList.jsx](src/components/NoteList.jsx) — the sidebar tree: folders (expandable, one lock each) and root notes in one list, plus the new-note / new-folder / import entry points. Rows come from [FolderRow.jsx](src/components/FolderRow.jsx); folder create/rename/re-key all share [FolderFormDialog.jsx](src/components/FolderFormDialog.jsx)
- [components/TopNav.jsx](src/components/TopNav.jsx) — lock button + status; also defines the in-file `AboutPage` component opened from the menu
- [components/Hwrite{Import,Export}Dialog.jsx](src/components/) — `.hwrite` flows
- Export pipeline — [hooks/useNoteExports.jsx](src/hooks/useNoteExports.jsx) drives it and renders [components/PdfExportDialog.jsx](src/components/PdfExportDialog.jsx); [js/exportNote.js](src/js/exportNote.js) is the entry point and [js/notePdf.js](src/js/notePdf.js) does the `marked` + jsPDF rendering (images pulled through `loadImageBlob`, undecryptable ones silently dropped)
- [lib/theme.jsx](src/lib/theme.jsx) — theme provider; [lib/utils.js](src/lib/utils.js) — `cn()` class merge helper

### Backend client — [src/js/api.js](src/js/api.js) + [src/js/backup.js](src/js/backup.js)
- [api.js](src/js/api.js) — fetch wrapper for the Workers API. Reads `VITE_API_URL` (default `http://localhost:8787`); persists token + user metadata in localStorage under `hushwrite-token` / `hushwrite-user` / `hushwrite-email`. Exports `getToken`, `setAuth`, `clearAuth`, `getUserId`, `getUserEmail`, `isLoggedIn`, plus the grouped `api` object: `register` / `login`, password reset + change (`forgotPassword`, `resetPassword`, `changePassword`), and snapshot CRUD (`listSnapshots`, `getSnapshot`, `createSnapshot`, `patchSnapshot`, `deleteSnapshot`). `api.sync` exists but is currently unused, and there is no note-CRUD client.
- [backup.js](src/js/backup.js) — whole-device snapshot backup/restore on top of those snapshot endpoints. Keeps `hushwrite-device-id` / `hushwrite-last-snapshot-id` / `hushwrite-last-local-hash` pointers in localStorage; `noteToWire` / `folderToWire` / `imageToWire` (and their `wireTo*` inverses) translate between IndexedDB records (Uint8Array crypto fields, image records) and the base64 wire format. `imageToWire`/`wireToImage` handle both image shapes: a `v: 1` wire record carries `iv`/`wrapped_key`/`wrap_iv`/`mime`/`owner_note_id` plus base64 ciphertext, a record with no `v` is a legacy plaintext blob and round-trips unchanged. Snapshots carry schema `1.1`; a `1.0` snapshot still restores, with the legacy singleton vault folded into a "Vault" folder on the way in. Restore lands via `replaceAll` so the three stores swap atomically.

### PWA — [vite.config.js](vite.config.js)
`VitePWA` is configured with `registerType: "autoUpdate"` and `devOptions.enabled: true` (so the SW is active in dev too). When changing icons/manifest, edit this file rather than adding a separate `manifest.json`.

### Backend API — [api/](api/)
Hono application running on Cloudflare Workers with D1 (SQLite) for storage. The server is a **dumb encrypted storage box** — it never sees plaintext. Notes are encrypted client-side before upload and decrypted client-side after download.

**Stack:** Hono + Cloudflare Workers + D1 (SQLite). No external auth libraries — password hashing (PBKDF2) and JWT (HMAC-SHA256) use the Web Crypto API natively available in Workers.

**Entry point:** [api/src/index.js](api/src/index.js) — registers middleware and routes.

**Routes:**
- [api/src/routes/auth.js](api/src/routes/auth.js) — `POST /auth/register`, `POST /auth/login` (returns JWT)
- [api/src/routes/notes.js](api/src/routes/notes.js) — `GET/POST/DELETE /api/v1/notes` (CRUD for encrypted blobs, all auth-guarded)
- [api/src/routes/sync.js](api/src/routes/sync.js) — `POST /api/v1/sync` (last-write-wins conflict resolution based on `updated_at`). Route exists and works, but **no frontend code calls it** — see the backend-client section
- [api/src/routes/snapshots.js](api/src/routes/snapshots.js) — `POST /api/v1/snapshots`, `GET /api/v1/snapshots`, `GET|PATCH|DELETE /api/v1/snapshots/:id` (whole-profile encrypted backups). **This is the only note-data backend the frontend calls**, via [src/js/backup.js](src/js/backup.js) — the auth routes above are the only other endpoints with a client

**Middleware:**
- [api/src/middleware/auth.js](api/src/middleware/auth.js) — JWT verification from `Authorization: Bearer <token>` header; sets `userId` on the context
- [api/src/middleware/cors.js](api/src/middleware/cors.js) — CORS headers so the PWA can call the API

**Auth utilities:** [api/src/lib/auth.js](api/src/lib/auth.js) — `hashPassword`, `verifyPassword` (PBKDF2, 100k iterations), `createToken`, `verifyToken` (HMAC-SHA256 JWT with 7-day expiry)

**Database:** [api/src/db/schema.sql](api/src/db/schema.sql) — base tables: `users` (id, email, password_hash) and `notes` (id, user_id, ciphertext, iv, salt, title_ciphertext, title_iv, vault, image_ids, created_at, updated_at). The notes table mirrors the IndexedDB note record structure. [api/src/db/migration-002-reset-and-deletes.sql](api/src/db/migration-002-reset-and-deletes.sql) layers on `password_resets` and a `deleted_notes` tombstone table that the sync endpoint uses to propagate deletions across devices. Apply migrations in order via `wrangler d1 execute hushwrite-db --file=...` (the `db:migrate*` scripts only run `schema.sql` — apply migration 002 manually for now).

**Config:** [api/wrangler.toml](api/wrangler.toml) — Workers config, D1 binding (`DB`), and `JWT_SECRET` env var (must be changed in production).

## Conventions

- Use the `@/` import alias for anything under `src/` (e.g. `import { Button } from "@/components/ui/button"`).
- New UI primitives should follow the shadcn pattern already in [src/components/ui/](src/components/ui/) (Radix slot + `class-variance-authority` + `cn()`).
- Plaintext must never be persisted: anything written to the `notes` store goes through `encryptContent` first. The same applies to titles — encrypt them into `titleCiphertext` / `titleIv` alongside the body.
- Gated actions (passphrase entry, delete confirmation) use the `useModalQueue` promise pattern. Treat `cancelled` / `superseded` as quiet — don't toast them.
- Notes carry `folderId` (`null` for a root note). Preserve it across saves; new notes inherit `activeFolderId`. Never reintroduce the old `vault` boolean.
- Moving a note between locks always goes through `moveNoteToFolder` — it decrypts under the old key and re-encrypts under the new one, and re-wraps its images' content keys in the same transaction. Never rewrite `folderId` on its own; the ciphertext would no longer match the folder's key.
- **Anything that changes the key opening a note must re-wrap that note's image CEKs**, or every image saved since this change becomes permanently undecryptable. The three places are `changeFolderPassphrase` + `moveNoteToFolder` ([lib/folders.jsx](src/lib/folders.jsx)) and `changePassphrase` ([useNoteSession.js](src/hooks/useNoteSession.js)); all three use `rewrapImagesForKey` and land the result in the same transaction as the note.
- New images saved into a note must be referenced as `idb://<uuid>` in the markdown — never embed data URIs (the editor will lag and autosave will balloon the ciphertext). Write them through `putImage`, never `saveImage` directly, or they land unencrypted.
- The backend API lives in [api/](api/) and is a separate Hono app deployed to Cloudflare Workers. It has its own `package.json` and `node_modules`. Run `cd api && npm run dev` to start it locally.
- The server never sees note plaintext. All encryption/decryption happens client-side; the API stores and returns opaque encrypted blobs. The one deliberate exception is **folder names**, which travel and are stored unencrypted so a locked folder stays identifiable in the sidebar and after a restore — treat folder names as metadata, not secrets, and don't put anything else in that category.
- **The app has no live note-sync.** Cross-device transfer is whole-profile snapshot backup/restore over `/api/v1/snapshots` ([src/js/backup.js](src/js/backup.js)); `api.sync` and the `POST /api/v1/sync` route (last-write-wins on `updated_at`, returning server notes that are newer) exist server-side but have no client. Don't describe or design around per-note sync as if it were wired up — if you need it, wiring the client is the work.
- Auth is JWT-based (HMAC-SHA256) with no external libraries. Tokens expire after 7 days. The `JWT_SECRET` in `wrangler.toml` must be changed before production deployment.
