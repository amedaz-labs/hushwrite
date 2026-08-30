import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { useAI } from "@/hooks/useAI";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const Icon = ({ name, className }) => (
  <span className={cn("material-symbols-outlined", className)}>{name}</span>
);

const ACTIONS = [
  {
    id: "title",
    label: "Generate title",
    icon: "title",
    needsTitleSetter: true,
  },
  {
    id: "improve",
    label: "Improve writing",
    icon: "auto_fix_high",
    replacesBody: true,
  },
  {
    id: "summarize",
    label: "Summarize note",
    icon: "summarize",
    appendsBody: true,
  },
  {
    id: "continue",
    label: "Continue writing",
    icon: "arrow_forward",
    appendsBody: true,
  },
];

const AIActionsMenu = ({
  markdown,
  setMarkdown,
  title = "",
  setTitle,
  folderNote = false,
  onOpenSettings,
  onSnapshot,
  disabled = false,
}) => {
  const ai = useAI();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [folderConsent, setFolderConsent] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const ref = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!ai.supported || !ai.enabled) return null;

  const triggerAction = (action) => {
    setOpen(false);
    if (folderNote && !folderConsent) {
      setPendingAction(action);
      return;
    }
    void executeAction(action);
  };

  const handleConsent = () => {
    setFolderConsent(true);
    const action = pendingAction;
    setPendingAction(null);
    if (action) void executeAction(action);
  };

  const handleConsentCancel = () => {
    setPendingAction(null);
  };

  const executeAction = async (action) => {
    const body = (markdown || "").trim();
    if (!body && action.id !== "continue") {
      toast.error("Note is empty");
      return;
    }

    onSnapshot?.({
      markdown: markdown || "",
      title: title || "",
      label: action.label,
    });

    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const toastId = toast.loading(
      ai.status === "ready" ? `Running ${action.label.toLowerCase()}…` : "Loading model…",
    );

    try {
      let streamed = "";
      const baseLen = (markdown || "").length;

      const result = await ai.complete({
        task: action.id,
        content: markdown || "",
        signal: ctrl.signal,
        onToken: (_delta, full) => {
          streamed = full;
          if (action.replacesBody) {
            setMarkdown(streamed);
          } else if (action.appendsBody) {
            const sep = baseLen && !markdown.endsWith("\n\n") ? "\n\n" : "";
            const heading =
              action.id === "summarize" ? "## Summary\n\n" : "";
            setMarkdown((markdown || "") + sep + heading + streamed);
          }
        },
      });

      if (action.needsTitleSetter) {
        const cleaned = result
          .split("\n")[0]
          .replace(/^\s*(?:title|note title)\s*[:\-–]\s*/i, "")
          .replace(/^["'`*_]+|["'`*_]+$/g, "")
          .replace(/[.!?,;:]+$/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(" ");
        setTitle(cleaned);
        toast.success("Title generated", { id: toastId });
      } else {
        toast.success(`${action.label} complete`, { id: toastId });
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        toast("Cancelled", { id: toastId });
      } else {
        toast.error(err?.message || "AI failed", { id: toastId });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const cancelRunning = () => {
    abortRef.current?.abort();
  };

  const isReady = ai.status === "ready";
  const isLoading = ai.status === "loading";

  return (
    <div className="relative" ref={ref}>
      {busy ? (
        <button
          onClick={cancelRunning}
          title="Stop AI"
          className="flex items-center gap-1.5 rounded p-1.5 text-vault-primary transition-all hover:bg-error-container/30 hover:text-error"
        >
          <Icon name="stop_circle" className="animate-pulse text-xl" />
          <span className="text-[11px] font-medium">Stop</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title={disabled ? "Accept or discard pending AI change first" : "AI assist"}
          className={cn(
            "flex h-11 w-11 items-center justify-center gap-1.5 rounded p-1.5 transition-all hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:w-auto",
            isReady
              ? "text-vault-primary"
              : "text-outline hover:text-on-surface",
          )}
        >
          <Icon
            name="auto_awesome"
            className={cn("text-xl", isLoading && "animate-pulse")}
          />
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(14rem,calc(100vw_-_1.5rem))] overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container shadow-xl md:left-auto md:right-0">
          <div className="border-b border-outline-variant/20 px-4 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-vault-primary">
              On-device AI
            </p>
            <p className="text-xs text-on-surface-variant">
              {isReady
                ? "Model ready"
                : isLoading
                  ? `Loading… ${Math.round((ai.progress || 0) * 100)}%`
                  : "Click an action to load"}
            </p>
          </div>
          <div className="py-1">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                onClick={() => triggerAction(a)}
                disabled={isLoading}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
              >
                <Icon name={a.icon} className="text-[18px] text-outline" />
                {a.label}
              </button>
            ))}
            {onOpenSettings && (
              <>
                <div className="my-1 border-t border-outline-variant/20" />
                <button
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high"
                >
                  <Icon name="settings" className="text-[18px] text-outline" />
                  AI settings
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={!!pendingAction}
        onOpenChange={(v) => { if (!v) handleConsentCancel(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="shield_lock" className="text-vault-primary" />
              Run AI on a folder note?
            </DialogTitle>
            <DialogDescription>
              Notes kept in an encrypted folder are treated as extra-sensitive.
              Plaintext stays on this device — the model runs locally — but you
              should explicitly consent before passing them to AI.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-surface-container-low p-3 text-xs text-on-surface-variant">
            This consent lasts for the current session only. It resets when you
            lock the folder or reload the app.
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleConsentCancel}
              className="rounded-lg bg-surface-container-high px-4 py-2 text-sm font-medium text-on-surface transition-all hover:bg-surface-container-highest active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={handleConsent}
              className="flex items-center gap-2 rounded-lg bg-vault-primary px-4 py-2 text-sm font-medium text-on-primary-fixed transition-all hover:scale-[1.02] active:scale-95"
            >
              <Icon name="auto_awesome" className="text-sm" />
              Allow for this session
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AIActionsMenu;
