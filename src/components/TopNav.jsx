import { useState } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme.jsx";
import { getUserEmail, api } from "@/js/api";
import {
  ArrowLeft,
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Info,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  LogIn,
  LogOut,
  Menu as MenuIcon,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  User,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import AISettingsDialog from "./AISettingsDialog";

// `getUserEmail()` is empty for a local-only profile, so initials aren't always
// possible — fall back to a glyph rather than an empty circle.
const initialsFor = (email) => {
  if (!email) return null;
  const name = email.split("@")[0] || "";
  const parts = name.split(/[._\-+]/).filter(Boolean);
  const letters = (parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "");
  return letters.toUpperCase() || null;
};

const ProfileDropdown = ({ onLogout, onChangePassword, onAbout, onAISettings, onSignIn, isLocalOnly = false }) => {
  const email = getUserEmail();
  const initials = isLocalOnly ? null : initialsFor(email);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          title={isLocalOnly ? "Local only — no account" : email || "Account"}
          aria-label="Account"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-outline-variant/60 bg-surface-container-high text-[11px] font-bold tracking-wide text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
        >
          {initials || <User className="h-4 w-4" strokeWidth={1.7} />}
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>
          {isLocalOnly
            ? "Local only · not synced"
            : email
              ? `Signed in as ${email}`
              : "Account"}
        </MenuLabel>
        {!isLocalOnly && (
          <MenuItem onSelect={onChangePassword}>
            <KeyRound className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
            Change password
          </MenuItem>
        )}
        <MenuItem onSelect={onAISettings}>
          <Sparkles className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
          AI settings
        </MenuItem>
        <MenuItem onSelect={onAbout}>
          <Info className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
          About
        </MenuItem>
        <MenuSeparator />
        {isLocalOnly ? (
          <MenuItem onSelect={() => onSignIn?.()} className="text-vault-primary">
            <LogIn className="mt-px h-4 w-4 shrink-0" strokeWidth={1.7} />
            Sign in
          </MenuItem>
        ) : (
          <MenuItem destructive onSelect={onLogout}>
            <LogOut className="mt-px h-4 w-4 shrink-0" strokeWidth={1.7} />
            Sign out
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
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
              className="w-full rounded-lg border border-outline/85 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-on-surface-variant">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-outline/85 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-on-surface-variant">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-outline/85 bg-surface-container px-3 py-2.5 text-sm text-on-surface placeholder-outline focus:border-vault-primary/60 focus:outline-none"
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
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.7} />
            ) : (
              <KeyRound className="h-4 w-4" strokeWidth={1.7} />
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
    // `fixed inset-0` starts at the physical top of the screen, so without the
    // inset the Back button sits under the status bar on a notched iPhone in
    // standalone PWA mode.
    <div className="fixed inset-0 z-[100] flex flex-col bg-surface pt-[env(safe-area-inset-top)]">
      <div className="flex h-16 items-center justify-between px-6">
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.7} />
          Back
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-20">
        <img
          src="/logo.svg"
          alt="Hushwrite"
          className="mb-6 h-24 w-24 rounded-[22%] shadow-lg"
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
        <div className="mt-10 border-t border-outline-variant/45 pt-6">
          <p className="text-xs text-outline">
            Made by <span className="font-semibold text-vault-primary">Elissa Tenn</span>, intern at{" "}
            <span className="font-semibold text-vault-primary">Amedaz</span> in Zahle, Lebanon.
          </p>
        </div>
      </div>
    </div>
  );
};

// All eight states are load-bearing — `diverged` and `newer-available` in
// particular are the two that actually need the user's attention, so this does
// not collapse into a three-state chip.
const CloudBadge = ({ state, latest, onClick }) => {
  const map = {
    "no-account": {
      icon: CloudOff,
      label: "Local only",
      tooltip: "Sign in to set up backup",
      tone: "muted",
    },
    "no-snapshots": {
      icon: CloudUpload,
      label: "Set up backup",
      tooltip: "No backups yet — create your first one",
      tone: "primary",
    },
    "up-to-date": {
      icon: CloudCheck,
      label: "Up to date",
      tooltip: "Local matches the latest backup",
      tone: "ok",
    },
    "needs-backup": {
      icon: CloudUpload,
      label: "Changes not backed up",
      tooltip: "You have local edits since the last backup",
      tone: "primary",
    },
    "newer-available": {
      icon: CloudDownload,
      label: latest?.device_label
        ? `Newer backup · ${latest.device_label}`
        : "Newer backup available",
      tooltip: "Another device pushed a newer backup",
      tone: "primary",
    },
    diverged: {
      icon: RefreshCw,
      label: "Action needed",
      tooltip: "This device has unsaved changes and another device pushed a newer backup. Open Backup to choose what to keep.",
      tone: "warn",
    },
    error: {
      icon: CloudOff,
      label: "Backup unavailable",
      tooltip: "Couldn't reach the backup server",
      tone: "muted",
    },
    loading: {
      icon: Loader2,
      label: "Checking…",
      tooltip: "Checking backup status",
      tone: "muted",
    },
  };
  const entry = map[state] || map.loading;
  const Glyph = entry.icon || Cloud;
  const toneClass = {
    muted: "text-outline hover:bg-surface-container hover:text-on-surface",
    primary: "text-vault-primary hover:bg-vault-primary/15",
    ok: "text-ok hover:bg-ok/15",
    warn: "bg-warn/15 text-warn hover:bg-warn/25",
  }[entry.tone];

  return (
    <button
      onClick={onClick}
      title={entry.tooltip}
      className={cn(
        "flex h-9 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors md:h-8",
        toneClass,
      )}
    >
      <Glyph
        className={cn("h-[18px] w-[18px] shrink-0", state === "loading" && "animate-spin")}
        strokeWidth={1.7}
      />
      <span className="hidden truncate lg:inline">{entry.label}</span>
    </button>
  );
};

// The single canonical lock indicator. `isUnlocked` alone is the wrong input —
// it only reports the editor session, not folder keys — so folder count is
// folded in. No countdown: the session clock and the folder clock reset on
// different events, and one number cannot honestly represent both.
const SessionPill = ({ unlocked, onLock }) => (
  // `aria-disabled` rather than `disabled`: the title is the ONLY place the
  // 15-minute auto-lock rule is written down, and a `disabled` button is
  // unreachable by keyboard, so that sentence would be too.
  <button
    type="button"
    onClick={unlocked ? onLock : undefined}
    aria-disabled={!unlocked}
    title={
      unlocked
        ? "Lock everything now · auto-locks after 15 min idle"
        : "Nothing is unlocked · sessions auto-lock after 15 min idle"
    }
    className={cn(
      "flex h-9 shrink-0 items-center gap-2 rounded-full pl-2.5 pr-3 text-xs font-semibold transition-colors md:h-8",
      unlocked
        ? "bg-vault-primary/15 text-vault-primary hover:bg-vault-primary/25"
        : "cursor-default bg-surface-container text-on-surface-variant",
    )}
  >
    {unlocked ? (
      <LockOpen className="h-[15px] w-[15px]" strokeWidth={1.9} />
    ) : (
      <Lock className="h-[15px] w-[15px] text-outline" strokeWidth={1.9} />
    )}
    <span>{unlocked ? "Unlocked" : "Locked"}</span>
    {/* The 15-minute rule was disclosed ONLY through `title`, which is
        hover-only — unreachable by keyboard and by touch. Folded into the
        accessible name instead, where it is announced with the state. */}
    <span className="sr-only">
      {unlocked
        ? ". Activate to lock everything now. Auto-locks after 15 minutes idle."
        : ". Nothing is unlocked. Sessions auto-lock after 15 minutes idle."}
    </span>
  </button>
);

const TopNav = ({ isUnlocked, unlockedFolderCount = 0, onLock, cloudState = "loading", cloudLatest = null, onOpenBackup, isLocalOnly = false, onLogout, onSignIn, onToggleNotes, notesOpen = false }) => {
  const { theme, toggleTheme } = useTheme();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const anythingUnlocked = !!isUnlocked || unlockedFolderCount > 0;

  return (
    <>
      {/* One row. The safe-area padding stays — a notched iOS device puts the
          status bar exactly where this header would otherwise sit. */}
      <header className="sticky top-0 z-50 flex h-[calc(3.5rem_+_env(safe-area-inset-top))] w-full items-center gap-2 border-b border-outline-variant/55 bg-surface px-2 pt-[env(safe-area-inset-top)] sm:px-4">
        <button
          onClick={onToggleNotes}
          aria-label={notesOpen ? "Close notes" : "Open notes"}
          aria-expanded={notesOpen}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container hover:text-on-surface md:hidden"
        >
          {notesOpen ? (
            <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
          ) : (
            <MenuIcon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          )}
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <img
            src="/logo.svg"
            alt=""
            className="h-6 w-6 shrink-0"
          />
          <span className="truncate text-[14.5px] font-semibold tracking-tight text-on-surface">
            Hushwrite
          </span>
        </div>

        <span className="flex-1" />

        <div className="flex min-w-0 shrink items-center gap-1">
          <CloudBadge
            state={isLocalOnly ? "no-account" : cloudState}
            latest={cloudLatest}
            onClick={isLocalOnly ? onSignIn : onOpenBackup}
          />
          <SessionPill unlocked={anythingUnlocked} onLock={onLock} />
          <span className="mx-1 hidden h-5 w-px bg-outline-variant/50 sm:block" />
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container hover:text-on-surface md:h-8 md:w-8"
          >
            {theme === "dark" ? (
              <Sun className="h-[18px] w-[18px]" strokeWidth={1.7} />
            ) : (
              <Moon className="h-[18px] w-[18px]" strokeWidth={1.7} />
            )}
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
      </header>
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
      <AboutPage open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <AISettingsDialog open={aiSettingsOpen} onOpenChange={setAiSettingsOpen} />
    </>
  );
};

export default TopNav;
