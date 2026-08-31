import { useCallback, useEffect, useRef } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { MilkdownProvider, Milkdown, useEditor, useInstance } from "@milkdown/react";
import { replaceAll } from "@milkdown/kit/utils";
import { v4 as uuid4 } from "uuid";
import { saveImage, getImage } from "@/js/db";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame-dark.css";

const EditorInner = ({ markdown, onChange, lockEpoch = 0 }) => {
  const onChangeRef = useRef(onChange);
  const externalMdRef = useRef(markdown);
  const blobCache = useRef(new Map());
  onChangeRef.current = onChange;

  // Resolve idb:// URLs to blob: URLs, used by both proxyDomURL and the
  // MutationObserver fallback.
  const resolveIdbUrl = useCallback(async (url) => {
    if (!url?.startsWith("idb://")) return url;
    const uuid = url.slice(6);
    if (blobCache.current.has(uuid)) return blobCache.current.get(uuid);
    try {
      const record = await getImage(uuid);
      if (record?.blob) {
        const blobUrl = URL.createObjectURL(record.blob);
        blobCache.current.set(uuid, blobUrl);
        return blobUrl;
      }
    } catch { /* not found */ }
    return url;
  }, []);

  const resolveIdbImages = useCallback((root) => {
    if (!root) return;
    root.querySelectorAll("img").forEach(async (img) => {
      const src = img.getAttribute("src");
      if (!src?.startsWith("idb://") || img.dataset.idbResolved) return;
      const resolved = await resolveIdbUrl(src);
      if (resolved !== src) {
        img.src = resolved;
        img.dataset.idbResolved = "true";
      }
    });
  }, [resolveIdbUrl]);

  // Eagerly load every idb:// image referenced in the markdown into the blob
  // cache. Crepe's proxyDomURL is invoked synchronously when a node is rendered;
  // a cache miss there falls back to returning the raw idb:// URL (which the
  // browser cannot fetch). Pre-warming the cache when the markdown prop changes
  // — including after the editor remounts on login transitions — guarantees the
  // sync lookup hits and the <img> renders without flashing a broken state.
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
        if (cancelled || blobCache.current.has(uuid)) continue;
        try {
          const record = await getImage(uuid);
          if (cancelled) return;
          if (record?.blob) {
            blobCache.current.set(uuid, URL.createObjectURL(record.blob));
          }
        } catch { /* not found */ }
      }
      if (!cancelled) {
        const container = document.querySelector(".milkdown-wrapper .milkdown");
        if (container) resolveIdbImages(container);
      }
    })();
    return () => { cancelled = true; };
  }, [markdown, resolveIdbImages]);

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
            const id = uuid4();
            await saveImage({ id, blob: file });
            return `idb://${id}`;
          },
          proxyDomURL: (url) => {
            if (!url?.startsWith("idb://")) return url;
            const uuid = url.slice(6);
            if (blobCache.current.has(uuid)) return blobCache.current.get(uuid);
            return resolveIdbUrl(url);
          },
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

  // Resolve idb:// images after mount and on DOM changes
  useEffect(() => {
    if (loading) return;
    const container = document.querySelector(".milkdown-wrapper .milkdown");
    if (!container) return;

    resolveIdbImages(container);

    const observer = new MutationObserver(() => resolveIdbImages(container));
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    return () => observer.disconnect();
  }, [loading, resolveIdbImages]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    const cache = blobCache.current;
    return () => {
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  // ...and on every lock. Unmount alone is not enough: locking does not unmount
  // this editor, it just blanks `markdown`. Every `blob:` URL minted for the
  // open note therefore stayed live and fetchable after an idle lock — paste one
  // into the address bar with the session locked and the image still loads.
  // Image bytes are stored unencrypted, so revoking is the only thing standing
  // between a locked session and its pictures.
  useEffect(() => {
    const cache = blobCache.current;
    cache.forEach((url) => URL.revokeObjectURL(url));
    cache.clear();
  }, [lockEpoch]);

  return <Milkdown />;
};

const MilkdownEditor = ({ markdown, onChange, lockEpoch }) => {
  return (
    <MilkdownProvider>
      <div className="milkdown-wrapper">
        <EditorInner
          markdown={markdown}
          onChange={onChange}
          lockEpoch={lockEpoch}
        />
      </div>
    </MilkdownProvider>
  );
};

export default MilkdownEditor;
