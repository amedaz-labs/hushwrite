import {
  Download,
  FileText,
  FolderInput,
  Info,
  KeyRound,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuItemText,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";

/**
 * The overflow menu for one note. Stateless — the export dialogs it drives are
 * owned by the caller via `useNoteExports()` (`@/hooks/useNoteExports`).
 *
 * `getContent` resolves the note's plaintext lazily — the editor already holds
 * it in memory, the sidebar has to decrypt with the folder key first. Export is
 * only ever offered when `canExport` says the caller can actually produce that
 * plaintext, which is what keeps it impossible while locked.
 *
 * The optional handlers (`onInfo`, `onMove`, `onChangePassphrase`, `onDelete`)
 * each render an item only when supplied, so a caller that cannot service one
 * simply omits it rather than showing a dead entry.
 */
const NoteActionsMenu = ({
  trigger,
  getContent,
  noteExports,
  canExport = false,
  exportDisabledReason,
  onInfo,
  onMove,
  onChangePassphrase,
  onDelete,
  deleteLabel = "Delete note",
  align = "end",
  onOpenChange,
}) => {
  const exportsDisabled = !canExport || noteExports.exporting;
  const exportHint = (enabledHint) =>
    exportDisabledReason && !canExport ? exportDisabledReason : enabledHint;

  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent align={align}>
        {onInfo && (
          <MenuItem onSelect={onInfo}>
            <Info className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
            Note info
          </MenuItem>
        )}
        {onMove && (
          <MenuItem onSelect={onMove}>
            <FolderInput className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
            Move to folder…
          </MenuItem>
        )}
        {onChangePassphrase && (
          <MenuItem onSelect={onChangePassphrase}>
            <KeyRound className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
            Change passphrase…
          </MenuItem>
        )}
        {(onInfo || onMove || onChangePassphrase) && <MenuSeparator />}

        <MenuLabel>Export</MenuLabel>
        <MenuItem
          disabled={exportsDisabled}
          onSelect={() => noteExports.exportMarkdown(getContent)}
        >
          <FileText className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
          <MenuItemText
            label="Markdown (.md)"
            hint={exportHint("Not encrypted — leaves HushWrite's protection")}
          />
        </MenuItem>
        <MenuItem
          disabled={exportsDisabled}
          onSelect={() => noteExports.openPdfDialog(getContent)}
        >
          <Download className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
          <MenuItemText
            label="PDF…"
            hint={exportHint("Not encrypted — leaves HushWrite's protection")}
          />
        </MenuItem>
        <MenuItem
          disabled={exportsDisabled}
          onSelect={() => noteExports.openHwriteDialog(getContent)}
        >
          <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-outline" strokeWidth={1.7} />
          <MenuItemText
            label="Encrypted (.hwrite)"
            hint={exportHint("Stays encrypted with a passphrase you choose")}
          />
        </MenuItem>

        {onDelete && (
          <>
            <MenuSeparator />
            <MenuItem destructive onSelect={onDelete}>
              <Trash2 className="mt-px h-4 w-4 shrink-0" strokeWidth={1.7} />
              {deleteLabel}
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
};

export default NoteActionsMenu;
