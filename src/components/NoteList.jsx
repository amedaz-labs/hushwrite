import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { v4 as uuid4 } from "uuid";
import {
  parseHwrite,
  decryptHwrite,
  hwriteEnvelopeToBytes,
  rehydrateInlineImages,
} from "../js/hwrite";
import HwriteImportDialog from "./HwriteImportDialog";
import { useVault } from "@/lib/vault";
import { decryptContent, encryptContent } from "../js/crypto";
import { saveNote, getAllNotes } from "../js/db";

const toBytes = (v) =>
  v instanceof Uint8Array ? v : v ? new Uint8Array(v) : null;

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

const formatTimestamp = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (diff < 1000 * 60 * 60 * 48) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

const NoteList = ({
  notes,
  currentId,
  currentTitle,
  titleCache = {},
  onSelectNote,
  onImportNote,
  onNotesChanged,
  onNewNote,
  onSectionChange,
  activeSection = "notes",
  isComposingNew = false,
  isNoteUnlocked = false,
}) => {
  const fileInputRef = useRef(null);
  const [importState, setImportState] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const vault = useVault();
  const [gatePassphrase, setGatePassphrase] = useState("");
  const [gateConfirm, setGateConfirm] = useState("");
  const [gateError, setGateError] = useState(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [vaultTitles, setVaultTitles] = useState({});
  // Holds an unencrypted .hwrite import that's waiting for the vault to be
  // unlocked. Once `isVaultUnlocked` flips true, the effect below encrypts
  // and saves it automatically.
  const [pendingVaultImport, setPendingVaultImport] = useState(null);

  const inVault = activeSection === "vault";
  const showGate = inVault && !vault.isVaultUnlocked;

  // Lock the vault whenever the user navigates away from the Vault section.
  // Re-entering the section then re-prompts for the passphrase.
  useEffect(() => {
    if (!inVault && vault.isVaultUnlocked) {
      vault.lockVault();
    }
  }, [inVault, vault]);

  // Clear decrypted vault titles whenever the vault locks.
  useEffect(() => {
    if (!vault.isVaultUnlocked) setVaultTitles({});
  }, [vault.isVaultUnlocked]);

  // When the vault is unlocked, decrypt every vault note's title so the
  // sidebar shows real labels instead of "Encrypted note".
  useEffect(() => {
    if (!vault.isVaultUnlocked || !vault.vaultKey) return;
    let cancelled = false;
    (async () => {
      const pending = notes.filter(
        (n) =>
          n.vault === true &&
          n.titleCiphertext &&
          n.titleIv &&
          !vaultTitles[n.id],
      );
      if (pending.length === 0) return;
      const next = {};
      for (const n of pending) {
        try {
          const plain = await decryptContent(
            toBytes(n.titleCiphertext),
            vault.vaultKey,
            toBytes(n.titleIv),
          );
          next[n.id] = plain;
        } catch {
          /* skip notes that fail (different key, tampered, etc.) */
        }
      }
      if (!cancelled && Object.keys(next).length) {
        setVaultTitles((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notes, vault.isVaultUnlocked, vault.vaultKey, vaultTitles]);

  // Flush any pending vault import the moment the vault becomes unlocked.
  useEffect(() => {
    if (!pendingVaultImport) return;
    if (!vault.isVaultUnlocked || !vault.vaultKey) return;
    let cancelled = false;
    (async () => {
      const pending = pendingVaultImport;
      try {
        const now = new Date().toISOString();
        const { ciphertext, iv } = await encryptContent(
          pending.markdown,
          vault.vaultKey,
        );
        const { ciphertext: titleCiphertext, iv: titleIv } =
          await encryptContent(pending.title, vault.vaultKey);
        await saveNote({
          id: uuid4(),
          ciphertext,
          iv,
          salt: vault.vaultSalt,
          title: "",
          titleCiphertext,
          titleIv,
          imageIds: pending.imageIds || [],
          vault: true,
          createdAt: pending.createdAt || now,
          updatedAt: now,
        });
        if (cancelled) return;
        setPendingVaultImport(null);
        onNotesChanged?.(await getAllNotes());
        toast.success(`"${pending.title}" added to your vault`);
      } catch (err) {
        if (!cancelled) {
          setPendingVaultImport(null);
          toast.error(err.message || "Could not import to vault");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVaultImport, vault.isVaultUnlocked, vault.vaultKey]);

  const handleGateSubmit = async (e) => {
    e.preventDefault();
    if (!gatePassphrase) return;
    setGateBusy(true);
    setGateError(null);
    try {
      if (vault.hasVault) {
        await vault.unlockVault(gatePassphrase);
      } else {
        if (gatePassphrase !== gateConfirm) {
          setGateError("Passphrases don't match.");
          setGateBusy(false);
          return;
        }
        await vault.createVault(gatePassphrase);
      }
      setGatePassphrase("");
      setGateConfirm("");
    } catch (err) {
      setGateError(err.message || "Could not unlock vault.");
    } finally {
      setGateBusy(false);
    }
  };

  const handleHwriteFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = await parseHwrite(text);
      setImportState({ parsed, fileSize: file.size });
    } catch (err) {
      toast.error(err.message || "Could not read .hwrite file");
    }
  };

  const onFilePick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    handleHwriteFile(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".hwrite")) {
      toast.error("Only .hwrite files can be imported.");
      return;
    }
    handleHwriteFile(file);
  };

  // Resolve the best-known plaintext title for a note. For the active
  // note we prefer the live editor title, but fall back to the session
  // cache when it's empty (the editor title is temporarily blanked while
  // we wait for the user to re-enter the passphrase on a locked note —
  // the sidebar label should stay stable across that transition).
  const resolveTitle = (note) => {
    if (note.id === currentId) {
      return (currentTitle && currentTitle.trim())
        ? currentTitle
        : titleCache[note.id] || vaultTitles[note.id] || note.title || null;
    }
    return titleCache[note.id] || vaultTitles[note.id] || note.title || null;
  };

  const scoped = useMemo(() => {
    const ts = (n) => new Date(n.updatedAt || n.createdAt || 0).getTime();
    return notes
      .filter((n) => (inVault ? n.vault === true : n.vault !== true))
      .sort((a, b) => ts(b) - ts(a)); // most recently edited first
  }, [notes, inVault]);

  const filtered = scoped;

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragActive(false);
      }}
      onDrop={onDrop}
      className={cn(
        "relative flex w-72 flex-col border-r border-outline-variant/10 bg-surface-container-lowest",
        dragActive && "ring-2 ring-vault-primary/60 ring-inset",
      )}
    >
      <div className="border-b border-outline-variant/10 p-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <img src="/panda-192.png" alt="Hushwrite" className="h-9 w-9 rounded-full object-cover" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold leading-none text-vault-primary">
              Hushwrite
            </h2>
            <p className="mt-1 text-[10px] uppercase tracking-widest text-vault-primary/60">
              Secure Session
            </p>
          </div>
        </div>

        <button
          onClick={onNewNote}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-surface-container-high px-3 py-2 text-sm font-medium text-vault-primary transition-all hover:bg-surface-container-highest"
        >
          <Icon name="add" className="text-base" />
          New Note
        </button>

        <div className="flex gap-1 rounded-lg bg-surface-container p-1">
          {[
            { id: "notes", label: "Notes", icon: "description" },
            { id: "vault", label: "Vault", icon: "enhanced_encryption" },
          ].map((s) => {
            const isActive = s.id === activeSection;
            return (
              <button
                key={s.id}
                onClick={() => onSectionChange?.(s.id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  isActive
                    ? "bg-surface-container-high text-vault-primary"
                    : "text-outline hover:text-on-surface",
                )}
              >
                <Icon name={s.icon} className="text-sm" />
                {s.label}
              </button>
            );
          })}
        </div>

        {inVault && vault.isVaultUnlocked && (
          <button
            onClick={() => vault.lockVault()}
            className="mt-3 flex w-full items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-outline transition-colors hover:text-on-surface"
            title="Lock vault"
          >
            <Icon name="lock" className="text-sm" />
            Lock vault
          </button>
        )}

        {!inVault && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-surface-container py-2 text-xs font-medium text-outline transition-all hover:bg-surface-container-high hover:text-on-surface"
            >
              <Icon name="file_upload" className="text-sm" />
              Import .hwrite
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".hwrite,application/json"
              hidden
              onChange={onFilePick}
            />
          </>
        )}
      </div>

      {showGate ? (
        <form
          onSubmit={handleGateSubmit}
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
        >
          {pendingVaultImport && (
            <div className="w-full rounded-lg border border-vault-primary/30 bg-primary-container/10 p-3 text-left">
              <div className="flex items-start gap-2">
                <Icon name="file_download" className="mt-0.5 text-base text-vault-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-vault-primary">
                    Import waiting
                  </p>
                  <p className="mt-0.5 truncate text-xs text-on-surface-variant">
                    "{pendingVaultImport.title}" will be added once the vault is{" "}
                    {vault.hasVault ? "unlocked" : "created"}.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingVaultImport(null);
                      toast("Import cancelled");
                    }}
                    className="mt-1 text-[10px] font-medium uppercase tracking-wider text-outline transition-colors hover:text-error"
                  >
                    Cancel import
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-container/20 ring-1 ring-vault-primary/30">
            <Icon name="enhanced_encryption" className="text-xl text-vault-primary" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-on-surface">
              {vault.hasVault ? "Unlock vault" : "Create vault"}
            </h3>
            <p className="text-xs text-on-surface-variant">
              {vault.hasVault
                ? "One passphrase unlocks every note inside."
                : "Choose one passphrase. It unlocks every note you save in this vault."}
            </p>
          </div>
          <input
            type="password"
            autoFocus
            value={gatePassphrase}
            onChange={(e) => setGatePassphrase(e.target.value)}
            placeholder="Vault passphrase"
            className={cn(
              "w-full rounded-lg border bg-surface-container px-3 py-2 text-sm text-on-surface placeholder-outline focus:outline-none",
              gateError
                ? "border-error/60 focus:border-error"
                : "border-outline-variant/30 focus:border-vault-primary/60",
            )}
          />
          {!vault.hasVault && (
            <input
              type="password"
              value={gateConfirm}
              onChange={(e) => setGateConfirm(e.target.value)}
              placeholder="Confirm passphrase"
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-3 py-2 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          )}
          {gateError && (
            <p className="text-xs text-error">{gateError}</p>
          )}
          <button
            type="submit"
            disabled={gateBusy || !gatePassphrase}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="lock_open" className="text-sm" />
            {vault.hasVault ? "Unlock vault" : "Create vault"}
          </button>
        </form>
      ) : (
      <div className="flex-1 overflow-y-auto">
        {isComposingNew && !currentId && (
          <div className="block w-full border-l-2 border-vault-primary bg-surface-container-high/50 p-4 text-left">
            <div className="mb-1 flex items-start justify-between gap-2">
              <h3 className="truncate text-sm font-semibold text-on-surface">
                {currentTitle?.trim() || "Untitled"}
              </h3>
              <span className="whitespace-nowrap text-[10px] text-outline">
                Now
              </span>
            </div>
            <div className="flex gap-2">
              <span className="rounded bg-primary-container/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-vault-primary">
                Draft
              </span>
            </div>
          </div>
        )}
        {filtered.length === 0 && !isComposingNew && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Icon name="description" className="text-2xl text-outline/60" />
            <p className="text-xs text-outline">No saved notes yet</p>
          </div>
        )}

        {filtered.map((note) => {
          const isActive = note.id === currentId;
          const resolved = resolveTitle(note);
          const displayTitle =
            resolved && resolved.trim()
              ? resolved
              : isActive
                ? "Untitled note"
                : "Encrypted note";
          const isEncrypted = !resolved && !isActive;
          const preview = isEncrypted ? "Locked — unlock to view contents" : "";
          const statusLabel =
            inVault && vault.isVaultUnlocked
              ? isActive
                ? "Open"
                : "Vault"
              : isActive
                ? isNoteUnlocked
                  ? "Open"
                  : "Locked"
                : isEncrypted
                  ? "Encrypted"
                  : "Locked";
          const statusActive =
            (isActive && isNoteUnlocked) || (inVault && vault.isVaultUnlocked);
          return (
            <button
              key={note.id}
              onClick={() => onSelectNote(note)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "group relative block w-full cursor-pointer overflow-hidden border-l-[3px] p-4 text-left transition-all duration-200",
                isActive
                  ? "border-vault-primary bg-gradient-to-r from-vault-primary/12 via-vault-primary/6 to-transparent shadow-[inset_0_0_0_1px_var(--md-sys-color-vault-primary,rgba(124,77,255,0.2))]"
                  : "border-transparent hover:bg-surface-container",
              )}
            >
              {isActive && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-r bg-vault-primary shadow-[0_0_12px_rgba(124,77,255,0.6)]"
                />
              )}
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3
                  className={cn(
                    "truncate text-sm font-semibold transition-colors",
                    isActive ? "text-vault-primary" : "text-on-surface",
                  )}
                >
                  {displayTitle}
                </h3>
                <span
                  className={cn(
                    "whitespace-nowrap text-[10px] tabular-nums",
                    isActive ? "text-vault-primary/70" : "text-outline",
                  )}
                >
                  {formatTimestamp(note.updatedAt || note.createdAt)}
                </span>
              </div>
              {preview && (
                <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-on-surface-variant">
                  {preview}
                </p>
              )}
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    statusActive
                      ? "bg-vault-primary/15 text-vault-primary ring-1 ring-vault-primary/30"
                      : isActive
                        ? "bg-surface-container-highest text-outline"
                        : "bg-surface-container-highest text-on-surface-variant",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full",
                      statusActive
                        ? "bg-vault-primary shadow-[0_0_6px_rgba(124,77,255,0.8)]"
                        : "bg-outline/60",
                    )}
                  />
                  {statusLabel}
                </span>
                {isActive && isNoteUnlocked && (
                  <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-vault-primary/70">
                    <Icon name="edit" className="text-[12px]" />
                    Editing
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      )}

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface/60 text-xs font-medium text-vault-primary backdrop-blur-sm">
          Drop .hwrite file to import
        </div>
      )}

      {importState && (
        <HwriteImportDialog
          parsed={importState.parsed}
          fileSize={importState.fileSize}
          hasVault={vault.hasVault}
          onConfirm={async ({ destination, passphrase }) => {
            const { parsed } = importState;
            const titleText = parsed.title || "Untitled";

            if (destination === "notes") {
              if (parsed.encrypted) {
                // Save the encrypted envelope as-is. The user supplies the
                // file's passphrase the first time they open it.
                const { ciphertext, iv, salt } = hwriteEnvelopeToBytes(parsed);
                const now = new Date().toISOString();
                await saveNote({
                  id: uuid4(),
                  ciphertext,
                  iv,
                  salt,
                  title: parsed.title,
                  imageIds: [],
                  vault: false,
                  createdAt: parsed.created || now,
                  updatedAt: parsed.modified || now,
                });
                setImportState(null);
                onNotesChanged?.(await getAllNotes());
                onSectionChange?.("notes");
                toast.success(`Imported "${parsed.title}" — locked until opened`);
              } else {
                // Plaintext to notes: load into editor as a draft so the user
                // can save it under their own passphrase.
                const raw = await decryptHwrite(parsed, undefined);
                const result = await rehydrateInlineImages(raw);
                const markdown = result.markdown || "";
                setImportState(null);
                onSectionChange?.("notes");
                onImportNote?.({ markdown, title: titleText });
              }
              return;
            }

            // destination === "vault" — always re-encrypt under the vault key.
            let raw;
            if (parsed.encrypted) {
              try {
                raw = await decryptHwrite(parsed, passphrase);
              } catch {
                throw new Error(
                  "Wrong passphrase, or the file is corrupted.",
                );
              }
            } else {
              raw = await decryptHwrite(parsed, undefined);
            }
            const result = await rehydrateInlineImages(raw);
            const markdown = result.markdown || "";
            const imageIds = result.imageIds || [];

            if (!vault.isVaultUnlocked) {
              // Defer until the user unlocks/creates the vault. The effect
              // above flushes the pending import once vaultKey is available.
              setPendingVaultImport({
                markdown,
                title: titleText,
                imageIds,
                createdAt: parsed.created,
              });
              setImportState(null);
              onSectionChange?.("vault");
              toast(
                vault.hasVault
                  ? "Unlock your vault to finish importing"
                  : "Create your vault to finish importing",
                { icon: "🔐" },
              );
              return;
            }

            const now = new Date().toISOString();
            const { ciphertext, iv } = await encryptContent(
              markdown,
              vault.vaultKey,
            );
            const { ciphertext: titleCiphertext, iv: titleIv } =
              await encryptContent(titleText, vault.vaultKey);

            await saveNote({
              id: uuid4(),
              ciphertext,
              iv,
              salt: vault.vaultSalt,
              title: "",
              titleCiphertext,
              titleIv,
              imageIds,
              vault: true,
              createdAt: parsed.created || now,
              updatedAt: parsed.modified || now,
            });

            setImportState(null);
            onNotesChanged?.(await getAllNotes());
            onSectionChange?.("vault");
            toast.success(`"${titleText}" added to your vault`);
          }}
          onCancel={() => setImportState(null)}
        />
      )}
    </section>
  );
};

export default NoteList;
