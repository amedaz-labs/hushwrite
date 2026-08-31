import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye } from "lucide-react";

const LINE_HEIGHT_PX = 22.75; // 13px font * 1.75 leading

// Milkdown serializes empty paragraphs as literal `<br />` lines in the
// markdown source. Showing those in a plain textarea looks like garbage to
// the user — strip them down to actual blank lines so the right pane mirrors
// what the editor visually shows.
const cleanMarkdown = (md) =>
  (md || "").replace(/^\s*<br\s*\/?>\s*$/gim, "");

const Preview = ({
  markdown,
  onChange,
  scrollRef,
  onScrollSync,
  onCursorLineChange,
}) => {
  // While the user is typing here we use a local-controlled value so
  // Milkdown's re-serialization (which often appends "\n" or normalizes
  // spacing) doesn't bounce back through the markdown prop and jump the
  // caret. When the textarea isn't focused we render directly from the
  // markdown prop, which keeps it in sync with note switches and edits
  // made on the Milkdown side.
  const cleaned = cleanMarkdown(markdown);
  const [local, setLocal] = useState(cleaned);
  const [focused, setFocused] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const textareaRef = useRef(null);

  // Notify parent when cursor lands on a new line so the editor pane can
  // scroll its corresponding block into view.
  useEffect(() => {
    if (!focused) return;
    onCursorLineChange?.(cursorLine);
  }, [cursorLine, focused, onCursorLineChange]);

  const value = focused ? local : cleaned;

  const totalLines = useMemo(() => {
    const text = value || "";
    return text ? text.split("\n").length : 1;
  }, [value]);

  const updateCursorLine = () => {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setCursorLine(before.split("\n").length);
  };

  // Keep the highlight strip aligned with the textarea's scroll position.
  const highlightRef = useRef(null);
  useLayoutEffect(() => {
    if (!focused) return;
    const el = textareaRef.current;
    const hl = highlightRef.current;
    if (!el || !hl) return;
    const top = (cursorLine - 1) * LINE_HEIGHT_PX - el.scrollTop;
    hl.style.transform = `translateY(${top}px)`;
  }, [cursorLine, focused, value]);

  const handleScroll = (e) => {
    onScrollSync?.(e.currentTarget);
    if (highlightRef.current && textareaRef.current) {
      const top =
        (cursorLine - 1) * LINE_HEIGHT_PX - textareaRef.current.scrollTop;
      highlightRef.current.style.transform = `translateY(${top}px)`;
    }
  };

  const setRefs = (node) => {
    textareaRef.current = node;
    if (typeof scrollRef === "function") scrollRef(node);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            Markdown
          </h3>
        </div>
        <span className="text-[10px] font-medium tabular-nums tracking-wider text-muted-foreground/80">
          LINE {cursorLine} / {totalLines}
        </span>
      </div>
      <div className="relative flex-1 overflow-hidden">
        {focused && (
          <div
            ref={highlightRef}
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 top-5 h-[22.75px] bg-vault-primary/10 transition-transform duration-75"
          />
        )}
        <textarea
          ref={setRefs}
          value={value}
          onScroll={handleScroll}
          onChange={(e) => {
            const v = e.target.value;
            setLocal(v);
            onChange?.(v);
            updateCursorLine();
          }}
          onKeyUp={updateCursorLine}
          onClick={updateCursorLine}
          onSelect={updateCursorLine}
          onFocus={() => {
            setLocal(cleanMarkdown(markdown));
            setFocused(true);
            requestAnimationFrame(updateCursorLine);
          }}
          onBlur={() => setFocused(false)}
          spellCheck={false}
          placeholder="Start writing to see the markdown source"
          // No `focus:outline-none` here: this textarea and the title input were
          // the only two focusable controls in the app with no focus indicator
          // whatsoever. The UA ring is fine.
          className="scrollbar-thin relative h-full w-full resize-none overflow-y-auto bg-transparent px-6 py-5 font-mono text-base leading-[22.75px] text-foreground md:text-[13px] placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
};

export default Preview;
