import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { useAI } from "@/hooks/useAI";
import {
  AlignLeft,
  ArrowRight,
  CircleStop,
  Settings,
  ShieldCheck,
  Sparkles,
  Type,
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

const ACTIONS = [
  {
    id: "title",
    label: "Generate title",
    icon: Type,
    needsTitleSetter: true,
  },
  {
    id: "improve",
    label: "Improve writing",
    icon: Sparkles,
    replacesBody: true,
  },
  {
    id: "summarize",
    label: "Summarize note",
    icon: AlignLeft,
    appendsBody: true,
  },
  {
    id: "continue",
    label: "Continue writing",
    icon: ArrowRight,
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
  const [busy, setBusy] = useState(false);
  const [folderConsent, setFolderConsent] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const abortRef = useRef(null);

  if (!ai.supported || !ai.enabled) return null;

  const triggerAction = (action) => {
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
    <>
      {/* Owned here so it can never outlive the control it separates — this
          component returns null when AI is unsupported or switched off. */}
      <span
        aria-hidden="true"
        className="hidden h-[18px] w-px shrink-0 bg-outline-variant/50 sm:block"
      />
      {busy ? (
        <button
          onClick={cancelRunning}
          title="Stop AI"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-vault-primary transition-colors hover:bg-error/10 hover:text-error"
        >
          <CircleStop className="h-[18px] w-[18px] animate-pulse" strokeWidth={1.7} />
          Stop
        </button>
      ) : (
        <Menu>
          <MenuTrigger asChild>
            <button
              // `aria-disabled`, not `disabled`: a real `disabled` button is
              // removed from the tab order and drops its tooltip, so the one
              // place that explains WHY it's unavailable becomes unreachable.
              // Radix's composed handlers bail when the child prevents the
              // default, which is what keeps the menu from opening.
              aria-disabled={disabled || undefined}
              onPointerDown={(e) => disabled && e.preventDefault()}
              onKeyDown={(e) => {
                if (!disabled) return;
                if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
                  e.preventDefault();
                }
              }}
              title={disabled ? "Accept or discard pending AI change first" : "AI assist"}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[12.5px] font-medium transition-colors",
                disabled && "cursor-not-allowed opacity-40",
                isReady
                  ? "text-vault-primary hover:bg-vault-primary/15"
                  : "text-outline hover:bg-surface-container hover:text-on-surface",
              )}
            >
              <Sparkles
                className={cn("h-[15px] w-[15px]", isLoading && "animate-pulse")}
                strokeWidth={1.7}
              />
              AI
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>
              {isReady
                ? "On-device AI · model ready"
                : isLoading
                  ? `On-device AI · loading ${Math.round((ai.progress || 0) * 100)}%`
                  : "On-device AI · nothing leaves the device"}
            </MenuLabel>
            {ACTIONS.map((a) => (
              <MenuItem
                key={a.id}
                disabled={isLoading}
                onSelect={() => triggerAction(a)}
              >
                <a.icon className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
                {a.label}
              </MenuItem>
            ))}
            {onOpenSettings && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={onOpenSettings}>
                  <Settings className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
                  AI settings
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      )}

      <Dialog
        open={!!pendingAction}
        onOpenChange={(v) => { if (!v) handleConsentCancel(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-vault-primary" strokeWidth={1.7} />
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
              <Sparkles className="h-4 w-4" strokeWidth={1.7} />
              Allow for this session
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AIActionsMenu;
