import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme.jsx";
import { getUserEmail, api } from "@/js/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import AISettingsDialog from "./AISettingsDialog";

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

const ProfileDropdown = ({ onLogout, onChangePassword, onAbout, onAISettings, onSignIn, isLocalOnly = false }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const email = getUserEmail();

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Account"
        className="flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface active:scale-95 md:h-auto md:w-auto md:p-2"
      >
        <Icon name="account_circle" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(14rem,calc(100vw_-_1.5rem))] overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container shadow-xl">
          {isLocalOnly ? (
            <div className="border-b border-outline-variant/20 px-4 py-3">
              <p className="text-xs font-medium text-on-surface-variant">Local only</p>
              <p className="truncate text-sm font-semibold text-on-surface">No account · not synced</p>
            </div>
          ) : email && (
            <div className="border-b border-outline-variant/20 px-4 py-3">
              <p className="text-xs font-medium text-on-surface-variant">Signed in as</p>
              <p className="truncate text-sm font-semibold text-on-surface">{email}</p>
            </div>
          )}
          <div className="py-1">
            {!isLocalOnly && (
              <button
                onClick={() => { setOpen(false); onChangePassword(); }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high"
              >
                <Icon name="lock_reset" className="text-[20px] text-outline" />
                Change Password
              </button>
            )}
            <button
              onClick={() => { setOpen(false); onAISettings(); }}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high"
            >
              <Icon name="auto_awesome" className="text-[20px] text-outline" />
              AI Settings
            </button>
            <button
              onClick={() => { setOpen(false); onAbout(); }}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high"
            >
              <Icon name="info" className="text-[20px] text-outline" />
              About
            </button>
            <div className="my-1 border-t border-outline-variant/20" />
            {isLocalOnly ? (
              <button
                onClick={() => { setOpen(false); onSignIn?.(); }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium text-vault-primary transition-colors hover:bg-primary-container/20"
              >
                <Icon name="login" className="text-[20px]" />
                Sign In
              </button>
            ) : (
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-error transition-colors hover:bg-error/10"
              >
                <Icon name="logout" className="text-[20px]" />
                Sign Out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const ChangePasswordDialog = ({ open, onOpenChange }) => {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!currentPassword || !newPassword) {
      setError("All fields are required.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const data = await api.changePassword(currentPassword, newPassword);
      setSuccess(data.message);
      setTimeout(() => {
        reset();
        onOpenChange(false);
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>Enter your current password and choose a new one.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-on-surface-variant">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-on-surface-variant">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-on-surface-variant">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          </div>
          {error && (
            <p className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</p>
          )}
          {success && (
            <p className="rounded-lg bg-vault-primary/10 px-3 py-2 text-xs text-vault-primary">{success}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-vault-primary px-4 py-2.5 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Icon name="progress_activity" className="animate-spin text-sm" />
            ) : (
              <Icon name="lock_reset" className="text-sm" />
            )}
            Change Password
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const AboutPage = ({ open, onClose }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-surface">
      <div className="flex h-16 items-center justify-between px-6">
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high"
        >
          <Icon name="arrow_back" className="text-sm" />
          Back
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-20">
        <img
          src="/panda-192.png"
          alt="Hushwrite"
          className="mb-6 h-24 w-24 rounded-full object-cover shadow-lg"
        />
        <h1 className="mb-2 text-3xl font-bold tracking-tight text-vault-primary">Hushwrite</h1>
        <p className="mb-8 text-sm text-outline">Privacy-first encrypted notes</p>
        <div className="max-w-md space-y-4 text-center text-sm leading-relaxed text-on-surface">
          <p>
            Hushwrite is an offline-first, encrypted notes app that keeps your thoughts private.
            All notes are encrypted with AES-GCM using a key derived from your passphrase — your
            data never leaves your device in plaintext.
          </p>
          <p>
            Put notes in a folder and one passphrase unlocks all of them; a note kept on its own
            carries its own. Folder <em>names</em> are stored unencrypted so you can tell them
            apart while they're locked — what's inside never is.
          </p>
          <p>
            With optional cloud sync, you can access your encrypted notes across devices while
            maintaining full end-to-end encryption. The server never sees your note content.
          </p>
        </div>
        <div className="mt-10 border-t border-outline-variant/20 pt-6">
          <p className="text-xs text-outline">
            Made by <span className="font-semibold text-vault-primary">Elissa Tenn</span>, intern at{" "}
            <span className="font-semibold text-vault-primary">Amedaz</span> in Zahle, Lebanon.
          </p>
        </div>
      </div>
    </div>
  );
};

const CloudBadge = ({ state, latest, onClick }) => {
  const map = {
    "no-account": {
      icon: "cloud_off",
      label: "Local only",
      tooltip: "Sign in to set up backup",
      tone: "muted",
    },
    "no-snapshots": {
      icon: "cloud_upload",
      label: "Set up backup",
      tooltip: "No backups yet — create your first one",
      tone: "primary",
    },
    "up-to-date": {
      icon: "cloud_done",
      label: "Up to date",
      tooltip: "Local matches the latest backup",
      tone: "success",
    },
    "needs-backup": {
      icon: "cloud_upload",
      label: "Changes not backed up",
      tooltip: "You have local edits since the last backup",
      tone: "primary",
    },
    "newer-available": {
      icon: "cloud_download",
      label: latest?.device_label
        ? `Newer backup · ${latest.device_label}`
        : "Newer backup available",
      tooltip: "Another device pushed a newer backup",
      tone: "primary",
    },
    diverged: {
      icon: "cloud_sync",
      label: "Action needed",
      tooltip: "This device has unsaved changes and another device pushed a newer backup. Open Backup to choose what to keep.",
      tone: "warn",
    },
    error: {
      icon: "cloud_off",
      label: "Backup unavailable",
      tooltip: "Couldn't reach the backup server",
      tone: "muted",
    },
    loading: {
      icon: "progress_activity",
      label: "Checking…",
      tooltip: "Checking backup status",
      tone: "muted",
    },
  };
  const entry = map[state] || map.loading;
  const toneClass = {
    muted: "border-outline-variant/30 bg-surface-container text-on-surface-variant",
    primary: "border-vault-primary/40 bg-primary-container/15 text-vault-primary",
    success: "border-vault-primary/30 bg-primary-container/10 text-vault-primary",
    warn: "border-error/40 bg-error/10 text-error",
  }[entry.tone];

  return (
    <button
      onClick={onClick}
      title={entry.tooltip}
      className={cn(
        "flex min-h-[44px] min-w-0 shrink items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-semibold transition-all hover:scale-[1.02] active:scale-95 sm:px-3 md:min-h-0",
        toneClass,
      )}
    >
      <Icon
        name={entry.icon}
        className={cn("text-sm", state === "loading" && "animate-spin")}
      />
      <span className="hidden truncate lg:inline">{entry.label}</span>
    </button>
  );
};

const TopNav = ({ isUnlocked, onLock, cloudState = "loading", cloudLatest = null, onOpenBackup, isLocalOnly = false, onLogout, onSignIn, onToggleNotes, notesOpen = false }) => {
  const { theme, toggleTheme } = useTheme();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-50 flex h-[calc(4rem_+_env(safe-area-inset-top))] w-full items-center justify-between gap-2 bg-surface px-3 pt-[env(safe-area-inset-top)] sm:px-6">
        <div className="flex min-w-0 items-center gap-3 md:gap-8">
          <button
            onClick={onToggleNotes}
            aria-label={notesOpen ? "Close notes" : "Open notes"}
            aria-expanded={notesOpen}
            className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface active:scale-95 md:hidden"
          >
            <Icon name={notesOpen ? "close" : "menu"} />
          </button>
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/panda-192.png"
              alt=""
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
            <div className="flex min-w-0 flex-col justify-center">
              <span className="truncate text-xl font-semibold leading-none tracking-tighter text-on-surface">
                Hushwrite
              </span>
              <span
                className={cn(
                  "mt-1 hidden truncate text-[10px] uppercase tracking-widest sm:block",
                  isUnlocked ? "text-vault-primary/60" : "text-outline",
                )}
              >
                {isUnlocked ? "Secure session" : "Locked"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-4">
          <CloudBadge
            state={isLocalOnly ? "no-account" : cloudState}
            latest={cloudLatest}
            onClick={isLocalOnly ? onSignIn : onOpenBackup}
          />
          <button
            onClick={onLock}
            disabled={!isUnlocked}
            className={cn(
"flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg bg-surface-container-high px-3 py-1.5 text-sm font-medium text-vault-primary transition-all hover:bg-surface-container-highest active:scale-95 md:min-h-0",
              !isUnlocked && "cursor-not-allowed opacity-50",
            )}
          >
            <Icon name={isUnlocked ? "lock_open" : "lock"} className="text-sm" />
            <span className="hidden sm:inline">
              {isUnlocked ? "Lock Session" : "Locked"}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0 sm:gap-2">
            <button
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-outline transition-colors hover:text-on-surface active:scale-95 md:h-auto md:w-auto md:p-2"
            >
              <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} />
            </button>
            {onLogout && (
              <ProfileDropdown
                onLogout={onLogout}
                onChangePassword={() => setChangePasswordOpen(true)}
                onAbout={() => setAboutOpen(true)}
                onAISettings={() => setAiSettingsOpen(true)}
                onSignIn={onSignIn}
                isLocalOnly={isLocalOnly}
              />
            )}
          </div>
        </div>
      </header>
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
      <AboutPage open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <AISettingsDialog open={aiSettingsOpen} onOpenChange={setAiSettingsOpen} />
    </>
  );
};

export default TopNav;
