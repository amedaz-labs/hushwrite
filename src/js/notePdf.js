// Render a note straight into a real, text-based PDF (selectable text, not a
// rasterized image) using jsPDF's text API. Because we lay the document out
// line by line, pagination always falls between lines — a line is never split
// across two pages.

import { jsPDF } from "jspdf";
import { marked } from "marked";
import { getImage } from "./db";

const PT_TO_MM = 0.352778;
const PX_TO_MM = 25.4 / 96;

const COLORS = {
  text: [26, 26, 26],
  heading: [17, 17, 17],
  muted: [136, 136, 136],
  code: [197, 32, 72],
  codeBg: [243, 244, 246],
  quote: [90, 90, 90],
  quoteBar: [37, 99, 235],
  link: [37, 99, 235],
  rule: [225, 225, 225],
  tableHeadBg: [249, 250, 251],
  tableBorder: [209, 213, 219],
};

const HEADING_PT = { 1: 19, 2: 16, 3: 13.5, 4: 12, 5: 11, 6: 11 };

// Flatten inline markdown tokens into styled text "runs".
const inlineRuns = (tokens, base = {}) => {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "text":
        if (t.tokens) runs.push(...inlineRuns(t.tokens, base));
        else runs.push({ text: t.text, ...base });
        break;
      case "strong":
        runs.push(...inlineRuns(t.tokens, { ...base, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(t.tokens, { ...base, italic: true }));
        break;
      case "codespan":
        runs.push({ text: t.text, ...base, code: true });
        break;
      case "link":
        runs.push(...inlineRuns(t.tokens, { ...base, link: true }));
        break;
      case "br":
        runs.push({ br: true });
        break;
      case "image":
        runs.push({ image: true, href: t.href, alt: t.text });
        break;
      case "del":
        runs.push(...inlineRuns(t.tokens, base));
        break;
      case "escape":
        runs.push({ text: t.text, ...base });
        break;
      default:
        if (t.tokens) runs.push(...inlineRuns(t.tokens, base));
        else if (t.text != null) runs.push({ text: t.text, ...base });
    }
  }
  return runs;
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

// Resolve an image reference (idb:// / data: / remote) to { dataUrl, w, h, fmt }.
const loadImage = async (href) => {
  try {
    let dataUrl = href;
    if (href.startsWith("idb://")) {
      const rec = await getImage(href.slice("idb://".length));
      if (!rec?.blob) return null;
      dataUrl = await blobToDataUrl(rec.blob);
    }
    const dims = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () =>
        resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
    if (!dims) return null;
    const fmt = /^data:image\/(png|gif)/i.test(dataUrl) ? "PNG" : "JPEG";
    return { dataUrl, w: dims.w, h: dims.h, fmt };
  } catch {
    return null;
  }
};

export async function exportNotePdf({ title, markdown, fileName }) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = 210;
  const pageH = 297;
  const margin = 18;
  const contentW = pageW - margin * 2;
  const bottom = pageH - margin;
  const bodyPt = 11;

  let y = margin; // top of the next line to draw

  const newPage = () => {
    doc.addPage();
    y = margin;
  };
  const ensure = (h) => {
    if (y + h > bottom) newPage();
  };

  // Draw a flow of styled runs with word wrapping at the content width.
  const drawRich = (runs, opts = {}) => {
    const {
      size = bodyPt,
      indent = 0,
      lineFactor = 1.5,
      color = COLORS.text,
      bold = false,
    } = opts;
    const x0 = margin + indent;
    const maxX = pageW - margin;
    const lineH = size * PT_TO_MM * lineFactor;
    const ascent = size * PT_TO_MM * 0.78;

    const setStyle = (s) => {
      if (s.code) doc.setFont("courier", "normal");
      else {
        const b = s.bold || bold;
        doc.setFont(
          "helvetica",
          b && s.italic
            ? "bolditalic"
            : b
              ? "bold"
              : s.italic
                ? "italic"
                : "normal",
        );
      }
      doc.setFontSize(size);
      const c = s.link ? COLORS.link : s.code ? COLORS.code : color;
      doc.setTextColor(c[0], c[1], c[2]);
    };

    ensure(lineH);
    let curX = x0;
    let lineHasContent = false;

    for (const r of runs) {
      if (r.br) {
        y += lineH;
        curX = x0;
        lineHasContent = false;
        ensure(lineH);
        continue;
      }
      if (r.image || r.text == null) continue; // images handled at block level
      setStyle(r);
      const parts = r.text.split(/(\s+)/);
      for (const p of parts) {
        if (p === "") continue;
        const isSpace = /^\s+$/.test(p);
        if (isSpace && !lineHasContent) continue;
        const w = doc.getTextWidth(p);
        if (!isSpace && lineHasContent && curX + w > maxX) {
          y += lineH;
          curX = x0;
          lineHasContent = false;
          ensure(lineH);
        }
        doc.text(p, curX, y + ascent);
        curX += w;
        if (!isSpace) lineHasContent = true;
      }
    }
    y += lineH;
  };

  const drawImageBlock = async (href, alt) => {
    const data = await loadImage(href);
    if (!data) {
      drawRich([{ text: alt || "[image]", italic: true }], {
        color: COLORS.muted,
      });
      return;
    }
    let wmm = data.w * PX_TO_MM;
    let hmm = data.h * PX_TO_MM;
    if (wmm > contentW) {
      hmm *= contentW / wmm;
      wmm = contentW;
    }
    const maxH = pageH - margin * 2;
    if (hmm > maxH) {
      wmm *= maxH / hmm;
      hmm = maxH;
    }
    ensure(hmm);
    try {
      doc.addImage(data.dataUrl, data.fmt, margin, y, wmm, hmm);
    } catch {
      /* unsupported image — skip */
    }
    y += hmm + 3;
  };

  const drawCodeBlock = (code) => {
    const size = 9.5;
    const lineH = size * PT_TO_MM * 1.45;
    const padX = 3;
    const padY = 2.5;
    doc.setFont("courier", "normal");
    doc.setFontSize(size);
    const lines = [];
    for (const raw of code.replace(/\n$/, "").split("\n")) {
      const wrapped = doc.splitTextToSize(raw || " ", contentW - padX * 2);
      lines.push(...wrapped);
    }
    let i = 0;
    while (i < lines.length) {
      ensure(lineH + padY * 2);
      // How many lines fit on the rest of this page?
      const avail = Math.max(1, Math.floor((bottom - y - padY * 2) / lineH));
      const chunk = lines.slice(i, i + avail);
      const blockH = chunk.length * lineH + padY * 2;
      doc.setFillColor(...COLORS.codeBg);
      doc.roundedRect(margin, y, contentW, blockH, 1.5, 1.5, "F");
      doc.setFont("courier", "normal");
      doc.setFontSize(size);
      doc.setTextColor(40, 40, 40);
      let ly = y + padY + size * PT_TO_MM * 0.8;
      for (const ln of chunk) {
        doc.text(ln, margin + padX, ly);
        ly += lineH;
      }
      y += blockH;
      i += chunk.length;
      if (i < lines.length) y += 0; // continues on next page
    }
    y += 2;
  };

  const drawHr = () => {
    ensure(4);
    doc.setDrawColor(...COLORS.rule);
    doc.setLineWidth(0.2);
    doc.line(margin, y + 1, pageW - margin, y + 1);
    y += 4;
  };

  const drawTable = (token) => {
    const cols = token.header.length;
    if (!cols) return;
    const colW = contentW / cols;
    const size = 10;
    const lineH = size * PT_TO_MM * 1.35;
    const padX = 2;
    const padY = 1.5;

    const renderRow = (cells, isHeader) => {
      doc.setFont("helvetica", isHeader ? "bold" : "normal");
      doc.setFontSize(size);
      const wrapped = cells.map((c) =>
        doc.splitTextToSize((c?.text ?? "").trim() || " ", colW - padX * 2),
      );
      const rowLines = Math.max(...wrapped.map((w) => w.length));
      const rowH = rowLines * lineH + padY * 2;
      ensure(rowH);
      if (isHeader) {
        doc.setFillColor(...COLORS.tableHeadBg);
        doc.rect(margin, y, contentW, rowH, "F");
      }
      doc.setDrawColor(...COLORS.tableBorder);
      doc.setLineWidth(0.1);
      doc.setTextColor(...COLORS.text);
      for (let c = 0; c < cols; c++) {
        const cx = margin + c * colW;
        doc.rect(cx, y, colW, rowH);
        let ty = y + padY + size * PT_TO_MM * 0.8;
        for (const ln of wrapped[c]) {
          doc.text(ln, cx + padX, ty);
          ty += lineH;
        }
      }
      y += rowH;
    };

    renderRow(token.header, true);
    for (const row of token.rows) renderRow(row, false);
    y += 3;
  };

  // ---- Header: title + meta ----
  drawRich([{ text: title || "Untitled" }], {
    size: 22,
    lineFactor: 1.2,
    color: COLORS.heading,
    bold: true,
  });
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  drawRich([{ text: `Exported from HushWrite · ${date}` }], {
    size: 9,
    color: COLORS.muted,
  });
  y += 1;
  drawHr();
  y += 1;

  // ---- Body ----
  const drawList = (token, indent) => {
    let idx = token.start || 1;
    for (const item of token.items) {
      const marker = token.ordered ? `${idx}.` : "•";
      const markerX = margin + indent;
      const textIndent = indent + 6;

      // Split item into its inline content and any nested block tokens.
      const inline = [];
      const nested = [];
      for (const child of item.tokens || []) {
        if (child.type === "list") nested.push(child);
        else if (child.type === "text")
          inline.push(...inlineRuns(child.tokens || [{ type: "text", text: child.text }]));
        else if (child.tokens) inline.push(...inlineRuns(child.tokens));
      }

      const lineH = bodyPt * PT_TO_MM * 1.5;
      ensure(lineH);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(bodyPt);
      doc.setTextColor(...COLORS.text);
      if (item.task) {
        doc.text(item.checked ? "[x]" : "[ ]", markerX, y + bodyPt * PT_TO_MM * 0.78);
        drawRich(inline, { indent: textIndent + 3 });
      } else {
        doc.text(marker, markerX, y + bodyPt * PT_TO_MM * 0.78);
        drawRich(inline, { indent: textIndent });
      }
      for (const n of nested) drawList(n, indent + 6);
      idx++;
    }
    y += 1;
  };

  const drawBlocks = (tokens, indent = 0, quote = false) => {
    for (const tok of tokens) {
      switch (tok.type) {
        case "space":
          y += bodyPt * PT_TO_MM * 0.5;
          break;
        case "heading":
          y += 2;
          drawRich(inlineRuns(tok.tokens, { bold: true }), {
            size: HEADING_PT[tok.depth] || bodyPt,
            lineFactor: 1.3,
            color: COLORS.heading,
            indent,
            bold: true,
          });
          y += 1;
          break;
        case "paragraph":
          drawRich(inlineRuns(tok.tokens), {
            indent,
            color: quote ? COLORS.quote : COLORS.text,
          });
          y += 1;
          break;
        case "blockquote": {
          const startY = y;
          const startPage = doc.getNumberOfPages();
          drawBlocks(tok.tokens, indent + 4, true);
          // Only draw the accent bar when the quote stayed on one page —
          // otherwise the coordinates would span across page boundaries.
          if (doc.getNumberOfPages() === startPage && y > startY) {
            doc.setDrawColor(...COLORS.quoteBar);
            doc.setLineWidth(0.8);
            doc.line(margin + indent, startY, margin + indent, y - 2);
          }
          break;
        }
        case "list":
          drawList(tok, indent);
          break;
        case "code":
          drawCodeBlock(tok.text || "");
          break;
        case "hr":
          drawHr();
          break;
        case "table":
          drawTable(tok);
          break;
        default:
          if (tok.tokens) drawBlocks(tok.tokens, indent, quote);
          else if (tok.text) drawRich([{ text: tok.text }], { indent });
      }
    }
  };

  // marked's lexer gives block tokens; images need async loading, so handle
  // standalone-image paragraphs separately while walking the tree.
  const tokens = marked.lexer(markdown || "");
  for (const tok of tokens) {
    if (
      tok.type === "paragraph" &&
      tok.tokens?.length === 1 &&
      tok.tokens[0].type === "image"
    ) {
      await drawImageBlock(tok.tokens[0].href, tok.tokens[0].text);
      y += 1;
    } else {
      drawBlocks([tok]);
    }
  }

  doc.save(`${fileName || "note"}.pdf`);
}
