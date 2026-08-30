import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  api,
  clearAuth,
  getUserEmail,
  isLoggedIn,
  setAuth,
} from "@/js/api";
import {
  backupSnapshot,
  computeDiff,
  deleteSnapshot,
  getDeviceLabel,
  getLastSnapshotId,
  getOrInitDeviceLabel,
  listSnapshots,
  renameSnapshotDevice,
  resetBackupPointers,
  restoreSnapshot,
  setDeviceLabel,
  setSnapshotPinned,
} from "@/js/backup";
import { useFolders } from "@/lib/folders";

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `today, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) {
    return `yesterday, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const BackupPanel = ({ open, onOpenChange, onRestoreComplete, onAfterBackup }) => {
  const folders = useFolders();
  // A restore swaps out every folder record, so any key held in memory is now
  // meaningless — drop them and re-read the folder list.
  const afterRestore = async () => {
    folders.lockAll();
    await folders.refreshFolders();
    onRestoreComplete?.();
  };
  const [authed, setAuthed] = useState(isLoggedIn());
  const [snapshots, setSnapshots] = useState([]);
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [error, setError] = useState(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelInitialized, setLabelInitialized] = useState(false);

  const [confirm, setConfirm] = useState(null);

  const lastId = getLastSnapshotId();

  const refresh = async () => {
    if (!isLoggedIn()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listSnapshots();
      setSnapshots(data.snapshots || []);
      setLimit(data.limit || 10);
    } catch (err) {
      setError(err.message || "Couldn't load backups");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setAuthed(isLoggedIn());
    if (isLoggedIn()) refresh();
    if (!labelInitialized) {
      setLabelDraft(getDeviceLabel() || getOrInitDeviceLabel());
      setLabelInitialized(true);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignedIn = async () => {
    setAuthed(true);
    await refresh();
  };

  const handleSignOut = () => {
    clearAuth();
    resetBackupPointers();
    setAuthed(false);
    setSnapshots([]);
    toast.success("Signed out");
  };

  const usage = useMemo(() => {
    const pinned = snapshots.filter((s) => s.pinned).length;
    return { used: snapshots.length, pinned, free: Math.max(0, limit - snapshots.length) };
  }, [snapshots, limit]);

  // ----- actions -----

  const handleBackup = async () => {
    setError(null);
    setBusyAction("backup");
    try {
      const latest = snapshots[0] || null;
      const diff = latest ? await computeDiff(latest.manifest || []) : null;
      setConfirm({ kind: "backup", diff, latest });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction(null);
    }
  };

  const confirmBackup = async () => {
    setBusyAction("backup");
    setError(null);
    try {
      const label = (labelDraft || "").trim();
      if (label) setDeviceLabel(label);
      const created = await backupSnapshot();
      toast.success(`Backed up · ${created.note_count} notes`);
      setConfirm(null);
      await refresh();
      onAfterBackup?.();
    } catch (err) {
      setError(err.message || "Backup failed");
      toast.error(err.message || "Backup failed");
    } finally {
      setBusyAction(null);
    }
  };

  const startRestore = async (snapshot) => {
    setError(null);
    setBusyId(snapshot.id);
    setBusyAction("restore");
    try {
      const diff = await computeDiff(snapshot.manifest || []);
      setConfirm({ kind: "restore", snapshot, diff });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const confirmRestore = async () => {
    if (!confirm?.snapshot) return;
    setBusyAction("restore");
    setBusyId(confirm.snapshot.id);
    setError(null);
    try {
      await restoreSnapshot(confirm.snapshot.id);
      toast.success(`Restored · ${confirm.snapshot.note_count} notes`);
      setConfirm(null);
      await afterRestore();
      onOpenChange(false);
    } catch (err) {
      setError(err.message || "Restore failed");
      toast.error(err.message || "Restore failed");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const backupThenRestore = async () => {
    if (!confirm?.snapshot) return;
    setBusyAction("restore");
    setBusyId(confirm.snapshot.id);
    setError(null);
    try {
      const label = (labelDraft || "").trim();
      if (label) setDeviceLabel(label);
      await backupSnapshot();
      toast.success("This device backed up · restoring…");
      await restoreSnapshot(confirm.snapshot.id);
      toast.success(`Restored · ${confirm.snapshot.note_count} notes`);
      setConfirm(null);
      await afterRestore();
      onOpenChange(false);
    } catch (err) {
      setError(err.message || "Operation failed");
      toast.error(err.message || "Operation failed");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const startDelete = (snapshot) => {
    setError(null);
    setConfirm({ kind: "delete", snapshot });
  };

  const confirmDelete = async () => {
    if (!confirm?.snapshot) return;
    setBusyAction("delete");
    setBusyId(confirm.snapshot.id);
    try {
      await deleteSnapshot(confirm.snapshot.id);
      toast.success("Backup deleted");
      setConfirm(null);
      await refresh();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const togglePin = async (snapshot) => {
    setBusyAction("pin");
    setBusyId(snapshot.id);
    try {
      await setSnapshotPinned(snapshot.id, !snapshot.pinned);
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const renameDevice = async (snapshot, label) => {
    if (!label.trim()) return;
    setBusyAction("rename");
    setBusyId(snapshot.id);
    try {
      await renameSnapshotDevice(snapshot.id, label.trim());
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const saveLabel = () => {
    const trimmed = labelDraft.trim();
    setDeviceLabel(trimmed);
    if (trimmed) toast.success(`This device is "${trimmed}"`);
  };

  const restoreCount = confirm?.diff
    ? confirm.diff.added.length + confirm.diff.updatedNewer.length + confirm.diff.updatedOlder.length + confirm.diff.removed.length
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-surface p-0 sm:p-0 sm:rounded-none [&>button.absolute]:hidden">
        {/* Header bar */}
        <div className="flex h-[calc(4rem_+_env(safe-area-inset-top))] shrink-0 items-center px-3 pt-[env(safe-area-inset-top)] sm:px-6">
          <button
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            <Icon name="arrow_back" className="text-sm" />
            Back
          </button>
          <DialogTitle className="sr-only">Backup &amp; Restore</DialogTitle>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <DialogDescription className="sr-only">
            {authed
              ? "Manage encrypted backups of this device."
              : "Sign in to enable encrypted backups."}
          </DialogDescription>

          {!authed ? (
            <div className="mx-auto flex w-full max-w-md flex-col px-6 py-12 md:py-16">
              <div className="mb-6 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-container/30 text-vault-primary">
                  <Icon name="lock" className="text-2xl" />
                </div>
                <h2 className="text-xl font-semibold text-on-surface">
                  Set up backup
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Sign in or create an account to keep an encrypted backup of this device.
                </p>
              </div>
              <InlineAuth onSignedIn={handleSignedIn} />
            </div>
          ) : (
            <div className="mx-auto grid w-full max-w-5xl gap-6 px-6 py-8 md:grid-cols-[320px_1fr] md:px-10 md:py-10">
              {/* Sidebar — this device + actions */}
              <aside className="space-y-4 md:sticky md:top-6 md:self-start">
                <section className="rounded-2xl border border-outline-variant/20 bg-surface-container/60 p-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                    This device
                  </p>
                  <input
                    type="text"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onBlur={saveLabel}
                    placeholder="e.g. MacBook"
                    className="mt-2 w-full rounded-lg border border-outline-variant/30 bg-surface px-3 py-2 text-base font-semibold text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
                  />
                  <button
                    onClick={handleBackup}
                    disabled={busyAction === "backup"}
                    className={cn(
                      "mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-4 py-2.5 text-sm font-semibold text-on-primary-fixed shadow-sm transition-all hover:scale-[1.01] active:scale-[0.98]",
                      busyAction === "backup" && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Icon name="cloud_upload" className="text-base" />
                    {busyAction === "backup" ? "Backing up…" : "Back up now"}
                  </button>
                  <div className="mt-4 flex items-center justify-between text-[11px] text-outline">
                    <span>
                      <span className="font-semibold text-on-surface-variant">
                        {usage.used}
                      </span>{" "}
                      / {limit} backups
                    </span>
                    {usage.pinned > 0 && (
                      <span className="flex items-center gap-1 text-vault-primary">
                        <Icon name="push_pin" className="text-[12px]" />
                        {usage.pinned} pinned
                      </span>
                    )}
                  </div>
                </section>

                <section className="rounded-2xl border border-outline-variant/20 bg-surface-container/60 p-5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                    Account
                  </p>
                  <p className="mt-1 truncate text-sm font-medium text-on-surface">
                    {getUserEmail() || "—"}
                  </p>
                  <button
                    onClick={handleSignOut}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-outline-variant/30 bg-surface px-3 py-2 text-xs font-semibold text-error transition-colors hover:bg-error/10"
                  >
                    <Icon name="logout" className="text-sm" />
                    Sign out
                  </button>
                  <p className="mt-3 text-[11px] leading-snug text-outline">
                    Signing out only forgets the token — your local notes are untouched.
                  </p>
                </section>
              </aside>

              {/* Main column — snapshot list */}
              <div className="space-y-4">
                <header className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                    Backups
                  </h3>
                  <button
                    onClick={refresh}
                    title="Refresh list"
                    className="flex min-h-[44px] items-center gap-1 text-xs text-outline hover:text-on-surface md:min-h-0"
                  >
                    <Icon
                      name="refresh"
                      className={cn("text-sm", loading && "animate-spin")}
                    />
                    Refresh
                  </button>
                </header>

                {error && (
                  <div className="break-words rounded-xl bg-error/10 px-4 py-3 text-sm text-error">
                    {error}
                  </div>
                )}

                {loading && snapshots.length === 0 ? (
                  <div className="flex items-center justify-center rounded-2xl border border-dashed border-outline-variant/30 py-12 text-sm text-outline">
                    <Icon name="progress_activity" className="mr-2 animate-spin text-base" />
                    Loading backups…
                  </div>
                ) : snapshots.length === 0 ? (
                  <EmptyState onBackup={handleBackup} />
                ) : (
                  <ul className="space-y-2">
                    {snapshots.map((s) => (
                      <SnapshotRow
                        key={s.id}
                        snapshot={s}
                        isLast={s.id === lastId}
                        busy={busyId === s.id}
                        onRestore={() => startRestore(s)}
                        onDelete={() => startDelete(s)}
                        onTogglePin={() => togglePin(s)}
                        onRename={(label) => renameDevice(s, label)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>

      {/* ---- Restore confirm ---- */}
      <Dialog
        open={confirm?.kind === "restore"}
        onOpenChange={(v) => !v && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              This will replace everything on this device with the backup from{" "}
              <span className="font-medium">{confirm?.snapshot?.device_label}</span>{" "}
              · {formatTime(confirm?.snapshot?.created_at)}.
            </DialogDescription>
          </DialogHeader>
          {confirm?.diff && (
            <DiffSummary diff={confirm.diff} mode="restore" total={restoreCount} />
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              onClick={() => setConfirm(null)}
              className="rounded-md px-3 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              onClick={backupThenRestore}
              disabled={busyAction === "restore"}
              className="rounded-md bg-surface-container-high px-3 py-2 text-sm font-semibold text-vault-primary hover:bg-surface-container-highest disabled:opacity-50"
              title="Save this device's current state as a new backup before restoring"
            >
              Back up first
            </button>
            <button
              onClick={confirmRestore}
              disabled={busyAction === "restore"}
              className="rounded-md bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busyAction === "restore" ? "Restoring…" : "Restore"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- Backup confirm ---- */}
      <Dialog
        open={confirm?.kind === "backup"}
        onOpenChange={(v) => !v && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new backup?</DialogTitle>
            <DialogDescription>
              {confirm?.latest ? (
                <>
                  The most recent backup is from{" "}
                  <span className="font-medium">{confirm.latest.device_label}</span>{" "}
                  · {formatTime(confirm.latest.created_at)}. It will not be deleted —
                  this becomes a new entry in the list.
                </>
              ) : (
                <>This will be your first backup.</>
              )}
            </DialogDescription>
          </DialogHeader>
          {confirm?.diff && (
            <DiffSummary diff={confirm.diff} mode="backup" total={restoreCount} />
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              onClick={() => setConfirm(null)}
              className="rounded-md px-3 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              onClick={confirmBackup}
              disabled={busyAction === "backup"}
              className="rounded-md bg-vault-primary px-3 py-2 text-sm font-semibold text-on-primary-fixed hover:opacity-95 disabled:opacity-50"
            >
              {busyAction === "backup" ? "Backing up…" : "Back up"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- Delete confirm ---- */}
      <Dialog
        open={confirm?.kind === "delete"}
        onOpenChange={(v) => !v && setConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this backup?</DialogTitle>
            <DialogDescription>
              {confirm?.snapshot && (
                <>
                  Deletes the backup from{" "}
                  <span className="font-medium">{confirm.snapshot.device_label}</span>{" "}
                  · {formatTime(confirm.snapshot.created_at)} ·{" "}
                  {pluralize(confirm.snapshot.note_count, "note", "notes")}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              onClick={() => setConfirm(null)}
              className="rounded-md px-3 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={busyAction === "delete"}
              className="rounded-md bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busyAction === "delete" ? "Deleting…" : "Delete"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

function deviceIconFor(label) {
  const l = (label || "").toLowerCase();
  if (/iphone|phone|pixel|galaxy|android/.test(l)) return "smartphone";
  if (/ipad|tablet/.test(l)) return "tablet";
  if (/mac|imac|book/.test(l)) return "laptop_mac";
  if (/windows|pc|desktop/.test(l)) return "desktop_windows";
  if (/linux/.test(l)) return "computer";
  return "devices";
}

const SnapshotRow = ({ snapshot, isLast, busy, onRestore, onDelete, onTogglePin, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(snapshot.device_label);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <li
      className={cn(
        "group flex flex-col items-start gap-3 rounded-2xl border border-outline-variant/20 bg-surface-container/60 px-4 py-3 transition-all hover:border-outline-variant/50 hover:bg-surface-container sm:flex-row sm:items-center sm:gap-4",
        isLast && "border-vault-primary/40 bg-primary-container/10 ring-1 ring-vault-primary/20",
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-on-surface-variant",
          isLast && "bg-primary-container/30 text-vault-primary",
        )}
      >
        <Icon name={deviceIconFor(snapshot.device_label)} className="text-lg" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {editing ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => {
                onRename(labelDraft);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setLabelDraft(snapshot.device_label);
                  setEditing(false);
                }
              }}
              className="w-full min-w-0 rounded-md border border-vault-primary/40 bg-surface px-2 py-0.5 text-base font-semibold text-on-surface focus:outline-none sm:text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-left text-sm font-semibold text-on-surface hover:text-vault-primary"
              title="Click to rename"
            >
              {snapshot.device_label}
            </button>
          )}
          {isLast && (
            <span className="rounded-full bg-vault-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-vault-primary">
              This device
            </span>
          )}
          {snapshot.pinned && (
            <span className="flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-vault-primary">
              <Icon name="push_pin" className="text-[12px]" />
              Pinned
            </span>
          )}
          {snapshot.has_vault && (
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-vault-primary">
              Folders
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-outline">
          {formatTime(snapshot.created_at)} · {pluralize(snapshot.note_count, "note", "notes")}
          {snapshot.image_count > 0 && (
            <> · {pluralize(snapshot.image_count, "image", "images")}</>
          )}
        </p>
      </div>

      <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
        <button
          onClick={onRestore}
          disabled={busy}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border border-vault-primary/30 bg-surface px-3 py-1.5 text-xs font-semibold text-vault-primary transition-all hover:bg-primary-container/20 active:scale-95",
            busy && "cursor-not-allowed opacity-50",
          )}
        >
          <Icon name="restore" className="text-sm" />
          Restore
        </button>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-lg p-1.5 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface md:h-auto md:w-auto"
            title="More actions"
          >
            <Icon name="more_vert" className="text-base" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container shadow-xl">
              <MenuItem
                icon={snapshot.pinned ? "keep_off" : "push_pin"}
                label={snapshot.pinned ? "Unpin" : "Pin backup"}
                onClick={() => {
                  setMenuOpen(false);
                  onTogglePin();
                }}
              />
              <MenuItem
                icon="edit"
                label="Rename device"
                onClick={() => {
                  setMenuOpen(false);
                  setEditing(true);
                }}
              />
              <div className="my-1 border-t border-outline-variant/20" />
              <MenuItem
                icon="delete"
                label="Delete"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                tone="error"
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

const MenuItem = ({ icon, label, onClick, tone }) => (
  <button
    onClick={onClick}
    className={cn(
      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-container-high",
      tone === "error" ? "text-error" : "text-on-surface",
    )}
  >
    <Icon name={icon} className="text-base text-outline" />
    {label}
  </button>
);

const EmptyState = ({ onBackup }) => (
  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-outline-variant/40 bg-surface-container/40 px-6 py-16 text-center">
    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-container/30 text-vault-primary">
      <Icon name="cloud_upload" className="text-3xl" />
    </div>
    <h3 className="text-base font-semibold text-on-surface">No backups yet</h3>
    <p className="mt-1 max-w-xs text-sm text-on-surface-variant">
      Create the first encrypted backup of this device. You can restore from
      any past backup later.
    </p>
    <button
      onClick={onBackup}
      className="mt-5 flex items-center gap-2 rounded-lg bg-vault-primary px-4 py-2 text-sm font-semibold text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95"
    >
      <Icon name="cloud_upload" className="text-sm" />
      Back up now
    </button>
  </div>
);

const DiffSummary = ({ diff, mode, total }) => {
  const { added, removed, updatedNewer, updatedOlder } = diff;
  const lines = [];
  if (mode === "restore") {
    if (added.length) lines.push(`+ Add ${pluralize(added.length, "note", "notes")} not on this device`);
    if (updatedNewer.length) lines.push(`~ Update ${pluralize(updatedNewer.length, "note", "notes")} (newer in backup)`);
    if (updatedOlder.length) lines.push(`↓ Replace ${pluralize(updatedOlder.length, "note", "notes")} where this device is newer`);
    if (removed.length) lines.push(`− Remove ${pluralize(removed.length, "local note", "local notes")} not in backup`);
    if (!total) lines.push("This backup is identical to your local state.");
  } else {
    if (added.length) lines.push(`↺ Restore ${pluralize(added.length, "note", "notes")} present in latest backup but missing locally (will be removed from cloud)`);
    if (removed.length) lines.push(`+ Save ${pluralize(removed.length, "new note", "new notes")} to cloud`);
    if (updatedNewer.length) lines.push(`↑ Replace ${pluralize(updatedNewer.length, "note", "notes")} where backup is newer than local`);
    if (updatedOlder.length) lines.push(`↑ Update ${pluralize(updatedOlder.length, "note", "notes")} on cloud (this device is newer)`);
    if (!total) lines.push("No changes since the last backup.");
  }
  return (
    <ul className="space-y-1 rounded-md border border-outline-variant/30 bg-surface-container p-3 text-xs text-on-surface-variant">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
};

const InlineAuth = ({ onSignedIn }) => {
  const [mode, setMode] = useState("login"); // "login" | "register" | "forgot" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [loading, setLoading] = useState(false);

  const switchMode = (m) => {
    setMode(m);
    setError(null);
    setSuccess(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (mode === "login" || mode === "register") {
      if (!email || !password) return setError("Email and password are required.");
      if (mode === "register" && password.length < 8)
        return setError("Password must be at least 8 characters.");
      if (mode === "register" && password !== confirmPassword)
        return setError("Passwords don't match.");

      setLoading(true);
      try {
        const data =
          mode === "login"
            ? await api.login(email, password)
            : await api.register(email, password);
        setAuth(data.token, data.userId, email);
        toast.success(mode === "login" ? "Signed in" : "Account created");
        await onSignedIn?.();
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === "forgot") {
      if (!email) return setError("Enter your email.");
      setLoading(true);
      try {
        const data = await api.forgotPassword(email);
        setSuccess(data.message);
        if (data.reset_token) {
          setResetToken(data.reset_token);
          switchMode("reset");
          setSuccess("Reset token auto-filled (dev mode). Enter your new password.");
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === "reset") {
      if (!resetToken) return setError("Reset token is required.");
      if (newPassword.length < 8) return setError("Password must be at least 8 characters.");
      if (newPassword !== confirmNewPassword) return setError("Passwords don't match.");
      setLoading(true);
      try {
        const data = await api.resetPassword(resetToken, newPassword);
        setSuccess(data.message);
        setTimeout(() => switchMode("login"), 1200);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  };

  const inputClass =
    "w-full rounded-lg border border-outline-variant/30 bg-surface px-3 py-2.5 text-base text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none sm:text-sm";

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-outline-variant/20 bg-surface-container/60 p-5"
    >
      {(mode === "login" || mode === "register" || mode === "forgot") && (
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            className={inputClass}
          />
        </div>
      )}

      {(mode === "login" || mode === "register") && (
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={inputClass}
          />
        </div>
      )}

      {mode === "register" && (
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            Confirm password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="••••••••"
            className={inputClass}
          />
        </div>
      )}

      {mode === "reset" && (
        <>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
              Reset token
            </label>
            <input
              type="text"
              value={resetToken}
              onChange={(e) => setResetToken(e.target.value)}
              placeholder="Paste your reset token"
              autoFocus
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
              Confirm new password
            </label>
            <input
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
            />
          </div>
        </>
      )}

      {error && (
        <p className="rounded-md bg-error/10 px-3 py-2 text-xs text-error">{error}</p>
      )}
      {success && (
        <p className="rounded-md bg-vault-primary/10 px-3 py-2 text-xs text-vault-primary">
          {success}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-3 py-2.5 text-sm font-semibold text-on-primary-fixed shadow-sm transition-all hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading && <Icon name="progress_activity" className="animate-spin text-sm" />}
        {mode === "login"
          ? "Sign in"
          : mode === "register"
            ? "Create backup account"
            : mode === "forgot"
              ? "Send reset link"
              : "Reset password"}
      </button>

      <div className="flex items-center justify-between text-[11px]">
        {(mode === "login" || mode === "register") && (
          <button
            type="button"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
            className="text-vault-primary hover:underline"
          >
            {mode === "login"
              ? "Don't have an account? Register"
              : "Already have an account? Sign in"}
          </button>
        )}
        {mode === "login" && (
          <button
            type="button"
            onClick={() => switchMode("forgot")}
            className="text-outline hover:text-on-surface-variant"
          >
            Forgot password?
          </button>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <button
            type="button"
            onClick={() => switchMode("login")}
            className="text-vault-primary hover:underline"
          >
            Back to sign in
          </button>
        )}
      </div>
    </form>
  );
};

export default BackupPanel;
