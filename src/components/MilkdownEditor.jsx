import { useCallback, useEffect, useRef } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { MilkdownProvider, Milkdown, useEditor, useInstance } from "@milkdown/react";
import { replaceAll } from "@milkdown/kit/utils";
import { peekImageUrl, putImage, revokeImageUrls } from "@/js/imageStore";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame-dark.css";

const EditorInner = ({ markdown, onChange, resolveImage, lockEpoch = 0 }) => {
  const onChangeRef = useRef(onChange);
  const externalMdRef = useRef(markdown);
  // Crepe is constructed once and captures its config, so the resolver has to
  // be reachable through a ref rather than a closed-over prop. Synced in an
  // effect (not during render) — and declared before every effect that reads
  // it, since effects run in declaration order within a commit.
  const resolveImageRef = useRef(resolveImage);
  onChangeRef.current = onChange;

  useEffect(() => {
    resolveImageRef.current = resolveImage;
  }, [resolveImage]);

  // Resolve an `idb://` URL to a `blob:` URL. The cache lives in `imageStore`
  // (byte-capped, shared with export/PDF), not here, so a lock can drop every
  // decrypted image in one call.
  //
  // On failure this returns the ORIGINAL `idb://` URL, not a placeholder: the
  // browser can't fetch that scheme, so the image simply doesn't render. What
  // the user actually sees depends on the node type, and neither is a broken-
  // image glyph (Crepe writes an empty `alt`, so there's nothing to fall back
  // to): an `image-block` collapses to the blank 100px box its CSS floor
  // guarantees, while an `image-inline` has no floor and collapses to nothing
  // at all. Weak signals, but honest ones, and the same behaviour as the
  // pre-encryption code. The load-bearing notice is the toast `persistNote`
  // raises for an image it could not claim.
  const resolveIdbUrl = useCallback(async (url) => {
    const id = url.slice(6);
    const hit = peekImageUrl(id);
    if (hit) return hit;
    try {
      return (await resolveImageRef.current?.(id)) || url;
    } catch {
      return url;
    }
  }, []);

  // Pre-warm the shared cache for every idb:// image in the markdown so the
  // first `proxyDomURL` call is a synchronous hit and the image appears without
  // a flash. Purely an optimization — correctness is `proxyDomURL`'s Promise
  // path. This effect re-runs on every keystroke (`markdown` is a dep), which
  // is only affordable because `loadImageUrl` de-dupes in-flight decrypts;
  // without that, each keypress during the cold window re-decrypts the whole
  // image.
  useEffect(() => {
    if (!markdown) return;
    const ids = new Set();
    for (const m of markdown.matchAll(/idb:\/\/([0-9a-f-]+)/gi)) {
      ids.add(m[1]);
    }
    if (ids.size === 0) return;
    let cancelled = false;
    (async () => {
      for (const uuid of ids) {
        if (cancelled) return;
        if (peekImageUrl(uuid)) continue;
        await resolveIdbUrl(`idb://${uuid}`);
      }
    })();
    return () => { cancelled = true; };
  }, [markdown, resolveIdbUrl]);

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: externalMdRef.current || "",
      features: {
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.ImageBlock]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.Table]: true,
        [CrepeFeature.Cursor]: true,
        [CrepeFeature.Latex]: false,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: "Start writing your note...",
        },
        [CrepeFeature.ImageBlock]: {
          onUpload: async (file) => {
            // No key argument: the editor doesn't hold one, and a brand-new
            // draft may not have one yet. `putImage` parks the content key in
            // its session registry and the note's first save wraps it.
            const { id } = await putImage(file);
            return `idb://${id}`;
          },
          // A Promise return is supported: Crepe's image NodeView does
          // `const proxiedURL = proxyDomURL(...)` and, when it isn't a string,
          // `proxiedURL.then(url => { src.value = url })` — see `bindAttrs` in
          // @milkdown/components/lib/image-{block,inline}/index.js. So hand it
          // the promise and let Vue own the binding.
          //
          // Do NOT return a synchronous placeholder and patch `img.src` from a
          // MutationObserver instead. `bindAttrs` re-runs on every NodeView
          // update (caption edit, resize, selection), so a DOM patch made
          // behind Vue's back is overwritten by the stale `src.value` on the
          // next update — and any "already resolved" flag on the element then
          // blocks the re-resolve permanently.
          proxyDomURL: (url) =>
            url?.startsWith("idb://") ? resolveIdbUrl(url) : url,
        },
      },
    });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md, prev) => {
        if (md !== prev) {
          externalMdRef.current = md;
          onChangeRef.current(md);
        }
      });
    });

    return crepe;
  }, []);

  // Get the editor instance for programmatic updates
  const [loading, getInstance] = useInstance();

  // Sync external markdown changes (note switch, import)
  useEffect(() => {
    if (loading) return;
    if (markdown === externalMdRef.current) return;
    externalMdRef.current = markdown;
    const editor = getInstance();
    if (editor) {
      try {
        editor.action(replaceAll(markdown || ""));
      } catch {
        // Editor not ready
      }
    }
  }, [markdown, loading, getInstance]);

  // Cleanup blob URLs on unmount. URLs only — the session content keys are the
  // note session's to drop, not this component's (see `revokeImageUrls`).
  useEffect(() => {
    return () => revokeImageUrls();
  }, []);

  // ...and on every lock. Unmount alone is not enough: locking does not unmount
  // this editor, it just blanks `markdown`. Every `blob:` URL minted for the
  // open note therefore stayed live and fetchable after an idle lock — paste one
  // into the address bar with the session locked and the image still loads.
  // Revoking is the only thing that actually takes the pictures away, for the
  // encrypted records AND for the legacy plaintext ones that are still around.
  //
  // URLs ONLY — never `revokeAllImageUrls`. `lockEpoch` is GLOBAL: locking one
  // folder from its row menu bumps it (see `lockFolder` in lib/folders.jsx),
  // and a root note's session deliberately survives that, since the
  // folder-teardown effect in `useNoteSession` returns early when the session
  // has no folder. Clearing the session CEK registry from here would therefore
  // destroy the content keys of images the *open, unrelated* note has pasted
  // but not yet saved — every later autosave would fail and the next lock would
  // discard the buffer. The session clears its own keys, after flushing.
  const lockEpochSeen = useRef(lockEpoch);
  useEffect(() => {
    if (lockEpochSeen.current === lockEpoch) return;
    lockEpochSeen.current = lockEpoch;
    revokeImageUrls();
  }, [lockEpoch]);

  return <Milkdown />;
};

const MilkdownEditor = ({ markdown, onChange, resolveImage, lockEpoch }) => {
  return (
    <MilkdownProvider>
      <div className="milkdown-wrapper">
        <EditorInner
          markdown={markdown}
          onChange={onChange}
          resolveImage={resolveImage}
          lockEpoch={lockEpoch}
        />
      </div>
    </MilkdownProvider>
  );
};

export default MilkdownEditor;
