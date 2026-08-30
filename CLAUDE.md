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
docker compose up dev                        # Vite dev server → http://localhost:5173
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

### Data layer — [src/js/db.js](src/js/db.js)
Single IndexedDB database `hushwrite-db` (version 2) with two stores keyed by `id`:
- `notes` — encrypted note records
- `images` — image blobs referenced from notes by `idb://<uuid>` URIs in the markdown

A note record persists `{ id, ciphertext, iv, salt, title, titleCiphertext, titleIv, imageIds, vault, createdAt, updatedAt }`. **Title is encrypted separately** with its own IV (under the same key); the plaintext `title` field on disk is legacy/best-effort and consumers should prefer the ciphertext pair when available. Preserve all of these when modifying the save/load path.

The reserved id `VAULT_META_ID = "__vault_meta__"` lives in the `notes` store and persists vault metadata (salt + verifier ciphertext). `getAllNotes` filters it out; `getVaultMeta` / `saveVaultMeta` are the dedicated accessors.

When changing the schema, bump `DB_VERSION` and extend the `upgrade` callback.

### Vault — [src/lib/vault.jsx](src/lib/vault.jsx)
`VaultProvider` (mounted at the App root) supplies a single shared AES-GCM key for "vault notes". Vault metadata stores a salt plus an encrypted verifier string that `unlockVault` decrypts to validate the passphrase. While the vault is unlocked:
- Notes flagged `vault: true` open without a per-note passphrase prompt
- Saves in the vault re-use the cached `vaultKey` / `vaultSalt`
- Idle-locking is **disabled** (one explicit Lock or reload tears down the key)

`useVault()` reads context; treat `vaultKey === null` as "locked".

### Note session — [src/hooks/useNoteSession.js](src/hooks/useNoteSession.js)
Owns all per-note crypto/lifecycle state via refs. Notable behaviors:
- Autosave debounce **1500 ms**; idle-lock **3 minutes** (non-vault only)
- Autosave only runs when there is both a `currentId` AND an in-memory session key — brand-new drafts wait for an explicit `saveManual` so the user can supply a fresh passphrase
- `lock()` flushes pending edits, then drops the key but **keeps `currentId`** so the sidebar selection survives — re-entering the passphrase resumes the same note
- `switchToNote()` autosaves the outgoing note, moves the highlight, then prompts for the new note's passphrase; wrong passphrase leaves the user on the locked-card UI rather than reverting
- `visibilitychange` / `pagehide` lock automatically; `beforeunload` warns when dirty
- Three delete paths: `deleteCurrent` (verify passphrase), `deleteVaultNote` (vault key already authorized), `forceDeleteCurrent` (caller-enforced age gate, e.g. 30-day rule)
- On unlock, `rehydrateInlineImages` lifts any inline `data:image/...;base64` URIs out of the markdown into the `images` store and rewrites them to `idb://<uuid>` — keeps the editor responsive on imported notes

### Image storage
Images are referenced from markdown as `![alt](idb://<uuid>)`. `IdbImage` resolves these to object URLs at render time. On save, `extractImageIds` walks the markdown and GC's any image blobs no longer referenced by the note. On `.hwrite` export, `inlineImagesForExport` swaps `idb://` refs back to data URIs so the file is self-contained.

### Modal queue — [src/hooks/useModalQueue.js](src/hooks/useModalQueue.js)
Promise-returning modal manager. `open(spec)` returns a Promise; opening a new modal while one is pending **rejects the previous Promise with `"superseded"`**. Confirm/cancel handlers are bound to a per-open `id` so late-firing Radix lifecycle events can't settle a modal that was opened afterwards. Treat `cancelled` and `superseded` as "quiet" errors that should not toast (see `isQuietError` / `isQuietErr`).

### .hwrite files — [src/js/hwrite.js](src/js/hwrite.js)
Portable single-note format. JSON envelope with `{ hwrite: "1.0", encrypted, title, created, modified, content, checksum }`; encrypted envelopes additionally carry base64 `nonce` and `salt`. `parseHwrite` validates the version, required fields, and SHA-256 checksum before returning. `hwriteEnvelopeToBytes` lets the import path stash the encrypted envelope directly as a note record so the user can open it later with the normal unlock flow.

### Component layout — [src/](src/)
- [App.jsx](src/App.jsx) is the single top-level component. It owns canonical state (`notes`, `currentId`, `selectedNote`, `markdown`, `title`, `activeSection`, `isComposingNew`), auth state (`authed`, `syncing` — backed by `isLoggedIn()` from [js/api.js](src/js/api.js) and a `hushwrite-skip-auth` localStorage opt-out), and a session-only `titleCache` (plaintext titles keyed by note id, populated on unlock/save) so the sidebar can show real titles instead of "Encrypted note". When unauthed and not skipped, App renders [AuthScreen](src/components/AuthScreen.jsx) instead of the editor. There is no router and no global state library; the vault is the only React context.
- [components/AuthScreen.jsx](src/components/AuthScreen.jsx) — login/register/skip UI for the optional backend; calls into [js/api.js](src/js/api.js) and flips `authed` in App
- [components/Markdown.jsx](src/components/Markdown.jsx) — editor host; wires `useNoteSession` + `useModalQueue` + `useVault` and renders the [MilkdownEditor](src/components/MilkdownEditor.jsx), [Preview](src/components/Preview.jsx), [PassPhraseModal](src/components/PassPhraseModal.jsx), and [DeleteModal](src/components/DeleteModal.jsx)
- [components/MilkdownEditor.jsx](src/components/MilkdownEditor.jsx) — Crepe-based markdown editor wrapper
- [components/Preview.jsx](src/components/Preview.jsx) — read-only marked + DOMPurify preview pane
- [components/PassPhraseModal.jsx](src/components/PassPhraseModal.jsx), [components/DeleteModal.jsx](src/components/DeleteModal.jsx) — extracted modal components driven by `useModalQueue`
- [components/NoteList.jsx](src/components/NoteList.jsx) + [Sidebar.jsx](src/components/Sidebar.jsx) — section nav, note list, vault tab, new-note + import entry points
- [components/TopNav.jsx](src/components/TopNav.jsx) — lock button + status; also defines the in-file `AboutPage` component opened from the menu
- [components/IdbImage.jsx](src/components/IdbImage.jsx) — resolves `idb://<uuid>` to a blob URL
- [components/Hwrite{Import,Export}Dialog.jsx](src/components/) — `.hwrite` flows
- [components/ExportNotes.jsx](src/components/ExportNotes.jsx) — PDF/markdown export pipeline
- [lib/theme.jsx](src/lib/theme.jsx) — theme provider; [lib/utils.js](src/lib/utils.js) — `cn()` class merge helper

### Backend client — [src/js/api.js](src/js/api.js) + [src/js/sync.js](src/js/sync.js)
- [api.js](src/js/api.js) — fetch wrapper for the Workers API. Reads `VITE_API_URL` (default `http://localhost:8787`); persists token + user metadata in localStorage under `hushwrite-token` / `hushwrite-user` / `hushwrite-email`. Exports `getToken`, `setAuth`, `clearAuth`, `getUserId`, `getUserEmail`, `isLoggedIn`, plus the grouped `api` object for register/login/notes/sync calls.
- [sync.js](src/js/sync.js) — orchestrates `POST /api/v1/sync`. Tracks `hushwrite-last-synced` and a `hushwrite-pending-deletes` queue in localStorage; `queueDeleteForSync(noteId)` is called from the delete paths so deletions propagate even when offline. `localToServer` / `serverToLocal` translate between IndexedDB note records (Uint8Array crypto fields) and base64 wire format. App calls `syncNotes()` after auth.

### PWA — [vite.config.js](vite.config.js)
`VitePWA` is configured with `registerType: "autoUpdate"` and `devOptions.enabled: true` (so the SW is active in dev too). When changing icons/manifest, edit this file rather than adding a separate `manifest.json`.

### Backend API — [api/](api/)
Hono application running on Cloudflare Workers with D1 (SQLite) for storage. The server is a **dumb encrypted storage box** — it never sees plaintext. Notes are encrypted client-side before upload and decrypted client-side after download.

**Stack:** Hono + Cloudflare Workers + D1 (SQLite). No external auth libraries — password hashing (PBKDF2) and JWT (HMAC-SHA256) use the Web Crypto API natively available in Workers.

**Entry point:** [api/src/index.js](api/src/index.js) — registers middleware and routes.

**Routes:**
- [api/src/routes/auth.js](api/src/routes/auth.js) — `POST /auth/register`, `POST /auth/login` (returns JWT)
- [api/src/routes/notes.js](api/src/routes/notes.js) — `GET/POST/DELETE /api/v1/notes` (CRUD for encrypted blobs, all auth-guarded)
- [api/src/routes/sync.js](api/src/routes/sync.js) — `POST /api/v1/sync` (last-write-wins conflict resolution based on `updated_at`)

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
- Vault notes carry `vault: true`. Preserve the flag across saves; new notes inherit it from `vaultMode`.
- New images saved into a note must be referenced as `idb://<uuid>` in the markdown — never embed data URIs (the editor will lag and autosave will balloon the ciphertext).
- The backend API lives in [api/](api/) and is a separate Hono app deployed to Cloudflare Workers. It has its own `package.json` and `node_modules`. Run `cd api && npm run dev` to start it locally.
- The server must never see plaintext. All encryption/decryption happens client-side. The API only stores and returns opaque encrypted blobs.
- Sync uses last-write-wins based on `updated_at` timestamps. The `POST /api/v1/sync` endpoint accepts client notes and returns server-side notes that are newer.
- Auth is JWT-based (HMAC-SHA256) with no external libraries. Tokens expire after 7 days. The `JWT_SECRET` in `wrangler.toml` must be changed before production deployment.
