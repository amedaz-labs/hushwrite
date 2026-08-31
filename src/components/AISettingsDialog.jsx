import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { useAI } from "@/hooks/useAI";
import { AI_MODEL_LABEL, AI_MODEL_SIZE_LABEL } from "@/js/ai";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CloudDownload,
  Cpu,
  Download,
  Info,
  Lock,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";

// Lucide replacements for this panel's former Material Symbols. Sized at 1em
// so the existing `text-*` classes keep driving the glyph size exactly as the
// icon font did.
const GLYPHS = {
  arrow_back: ArrowLeft,
  auto_awesome: Sparkles,
  error: CircleAlert,
  download: Download,
  pause_circle: CirclePause,
  delete: Trash2,
  bolt: Zap,
  lock: Lock,
  memory: Cpu,
  check_circle: CircleCheck,
  info: Info,
  cloud_download: CloudDownload,
};

const Icon = ({ name, className }) => {
  const Glyph = GLYPHS[name];
  if (!Glyph) {
    // Returning null silently is how six of these names shipped rendering
    // nothing at all. Fail loudly in dev; degrade quietly in prod.
    if (import.meta.env.DEV) {
      console.warn(
        `[AISettingsDialog] no lucide glyph mapped for icon "${name}"`,
      );
    }
    return null;
  }
  return (
    <Glyph
      aria-hidden="true"
      strokeWidth={1.7}
      className={cn("inline-block h-[1em] w-[1em] shrink-0", className)}
    />
  );
};

const AISettingsDialog = ({ open, onOpenChange }) => {
  const ai = useAI();
  const [downloaded, setDownloaded] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const has = await ai.isModelDownloaded();
      if (!cancelled) setDownloaded(has);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ai, ai.status]);

  if (!open) return null;

  const close = () => onOpenChange?.(false);
  const isLoading = ai.status === "loading";
  const isReady = ai.status === "ready";
  const pct = Math.round((ai.progress || 0) * 100);

  const handleEnable = async () => {
    if (!ai.supported) {
      toast.error("WebGPU not available — try Chrome, Edge, or Safari 18+.");
      return;
    }
    ai.setEnabled(true);
    try {
      await ai.ensureLoaded();
      toast.success("AI model ready");
    } catch (err) {
      if (err?.name !== "AbortError") {
        toast.error(err?.message || "Failed to load AI model");
      }
    }
  };

  const handleDisable = () => setPendingConfirm("disable");
  const handleRemove = () => setPendingConfirm("remove");

  const confirmDisable = async () => {
    setPendingConfirm(null);
    ai.setEnabled(false);
    await ai.unload();
    toast("AI disabled — model still cached");
  };

  const confirmRemove = async () => {
    setPendingConfirm(null);
    ai.setEnabled(false);
    await ai.removeModelCache();
    setDownloaded(false);
    toast.success("AI model removed");
  };

  const closeConfirm = () => setPendingConfirm(null);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-surface">
      <div className="flex h-16 items-center justify-between px-6">
        <button
          onClick={close}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high"
        >
          <Icon name="arrow_back" className="text-sm" />
          Back
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center px-6 pb-20">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-container/20 ring-1 ring-vault-primary/30">
          <Icon name="auto_awesome" className="text-3xl text-vault-primary" />
        </div>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-vault-primary">
          On-device AI
        </h1>
        <p className="mt-2 text-sm text-outline">
          Optional writing assistant — runs entirely in your browser
        </p>

        <div className="mt-10 w-full max-w-xl space-y-6">
          {!ai.supported && (
            <div className="rounded-xl border border-error/30 bg-error/5 p-4 text-sm text-error">
              <div className="flex items-start gap-3">
                <Icon name="error" className="mt-0.5 text-base" />
                <div>
                  <p className="font-semibold">WebGPU not available</p>
                  <p className="mt-1 text-xs opacity-80">
                    This feature needs WebGPU. Try Chrome, Edge, or Safari 18+
                    on a modern device.
                  </p>
                </div>
              </div>
            </div>
          )}

          {ai.supported && (
            <>
              <div className="rounded-xl bg-surface-container-low p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-base font-semibold text-on-surface">
                    {AI_MODEL_LABEL}
                  </span>
                  <span className="rounded-full bg-primary-container/20 px-2.5 py-0.5 text-[11px] font-semibold text-vault-primary">
                    {AI_MODEL_SIZE_LABEL}
                  </span>
                </div>
                <ul className="space-y-2 text-sm text-on-surface-variant">
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="bolt"
                      className="mt-0.5 text-base text-vault-primary"
                    />
                    One-time download, then works offline forever
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="lock"
                      className="mt-0.5 text-base text-vault-primary"
                    />
                    Plaintext never leaves your device
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="memory"
                      className="mt-0.5 text-base text-vault-primary"
                    />
                    Runs on your GPU via WebGPU
                  </li>
                </ul>
              </div>

              {ai.error && (
                <div className="rounded-xl bg-error/10 p-4 text-sm text-error">
                  {ai.error}
                </div>
              )}

              {isLoading && (
                <div className="space-y-2 rounded-xl bg-surface-container-low p-5">
                  <div className="flex items-center justify-between text-sm text-on-surface">
                    <span className="truncate">
                      {(ai.progressText || "Downloading model…")
                        .replace(/\s*\d+%\s*completed,?\s*/i, " ")
                        .replace(/(\d+\s*secs?\s*elapsed)\b[\s\S]*$/i, "$1")
                        .replace(/\s+/g, " ")
                        .trim() || "Downloading model…"}
                    </span>
                    <span className="font-mono text-xs text-vault-primary">
                      {pct}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-container-high">
                    <div
                      className="h-full rounded-full bg-vault-primary transition-all duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="pt-1 text-xs text-outline">
                    First load downloads ~1.8 GB. Keep this tab open.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {!isReady && !isLoading && (
                  <button
                    onClick={handleEnable}
                    className="flex items-center gap-2 rounded-lg bg-vault-primary px-5 py-2.5 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95"
                  >
                    <Icon name="download" className="text-sm" />
                    {downloaded ? "Load model" : "Enable & download"}
                  </button>
                )}
                {isReady && (
                  <button
                    onClick={handleDisable}
                    className="flex items-center gap-2 rounded-lg bg-surface-container-high px-5 py-2.5 text-sm font-medium text-on-surface transition-all hover:bg-surface-container-highest active:scale-95"
                  >
                    <Icon name="pause_circle" className="text-sm" />
                    Disable AI
                  </button>
                )}
                {(downloaded || isReady) && (
                  <button
                    onClick={handleRemove}
                    className="flex items-center gap-2 rounded-lg border border-error/30 px-5 py-2.5 text-sm font-medium text-error transition-all hover:bg-error/10 active:scale-95"
                  >
                    <Icon name="delete" className="text-sm" />
                    Remove cached model
                  </button>
                )}
              </div>

              <p className="text-xs text-outline">
                Model quality is small-model-tier — best for grammar, titles,
                and short rewrites. Not Claude-grade, but private.
              </p>
            </>
          )}
        </div>
      </div>

      {pendingConfirm && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
          onClick={closeConfirm}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-outline-variant/70 bg-surface-container p-5 shadow-2xl sm:p-7"
          >
            {pendingConfirm === "disable" ? (
              <>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-container/20 ring-1 ring-vault-primary/30">
                  <Icon name="pause_circle" className="text-2xl text-vault-primary" />
                </div>
                <h2 className="text-xl font-bold tracking-tight text-on-surface">
                  Disable AI?
                </h2>
                <p className="mt-1.5 text-sm text-on-surface-variant">
                  The AI engine will stop running on your device. Re-enabling
                  later is fast — the model stays cached.
                </p>
                <ul className="mt-5 space-y-2.5 rounded-xl bg-surface-container-low p-4 text-xs text-on-surface-variant">
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="check_circle"
                      className="mt-0.5 text-sm text-vault-primary"
                    />
                    GPU memory is released
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="check_circle"
                      className="mt-0.5 text-sm text-vault-primary"
                    />
                    The 1.8 GB model stays on your device
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="check_circle"
                      className="mt-0.5 text-sm text-vault-primary"
                    />
                    Re-enabling takes a few seconds, no redownload
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="check_circle"
                      className="mt-0.5 text-sm text-vault-primary"
                    />
                    The AI button hides from the editor toolbar
                  </li>
                </ul>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <button
                    onClick={closeConfirm}
                    className="rounded-lg bg-surface-container-high px-5 py-2.5 text-sm font-semibold text-on-surface transition-all hover:bg-surface-container-highest active:scale-95"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDisable}
                    className="flex items-center gap-2 rounded-lg bg-vault-primary px-5 py-2.5 text-sm font-semibold text-on-primary-fixed shadow-lg shadow-vault-primary/20 transition-all hover:scale-[1.02] active:scale-95"
                  >
                    <Icon name="pause_circle" className="text-base" />
                    Disable AI
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-error/15 ring-1 ring-error/30">
                  <Icon name="delete" className="text-2xl text-error" />
                </div>
                <h2 className="text-xl font-bold tracking-tight text-on-surface">
                  Remove cached model?
                </h2>
                <p className="mt-1.5 text-sm text-on-surface-variant">
                  The full 1.8 GB model will be deleted from this device.
                  Re-enabling AI later requires a complete redownload.
                </p>
                <ul className="mt-5 space-y-2.5 rounded-xl bg-error/5 p-4 text-xs text-on-surface-variant">
                  <li className="flex items-start gap-2.5">
                    <Icon name="delete" className="mt-0.5 text-sm text-error" />
                    All AI weight files removed (~1.8 GB freed)
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon name="delete" className="mt-0.5 text-sm text-error" />
                    GPU memory released, AI engine torn down
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="info"
                      className="mt-0.5 text-sm text-on-surface-variant"
                    />
                    Your notes, vault, and account are not affected
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Icon
                      name="cloud_download"
                      className="mt-0.5 text-sm text-on-surface-variant"
                    />
                    Next enable downloads the full ~1.8 GB again
                  </li>
                </ul>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <button
                    onClick={closeConfirm}
                    className="rounded-lg bg-surface-container-high px-5 py-2.5 text-sm font-semibold text-on-surface transition-all hover:bg-surface-container-highest active:scale-95"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRemove}
                    className="flex items-center gap-2 rounded-lg bg-vault-primary px-5 py-2.5 text-sm font-semibold text-on-primary-fixed shadow-lg shadow-vault-primary/20 transition-all hover:scale-[1.02] active:scale-95"
                  >
                    <Icon name="delete" className="text-base" />
                    Remove model
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AISettingsDialog;
