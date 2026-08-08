/**
 * Full-screen preview for images and PDFs. Everything else downloads directly —
 * filesPanel.js asks canPreview() and falls back to registry.save().
 *
 * The object URL is minted from a fresh Blob whose MIME type THIS module
 * chooses, never the type string a peer sent with the file: bytes claiming
 * application/pdf that are really HTML render as a broken PDF, not as a
 * same-origin document with script. Only image/* and application/pdf can ever
 * reach the viewer.
 *
 * The PDF iframe needs `frame-src blob:` in the CSP — app.html and _headers
 * both, since the two intersect.
 */

import * as registry from "../../files/registry.js";
import { formatSize } from "../../files/thumbs.js";
import * as modal from "../primitives/modal.js";
import { esc, lazyStyle } from "../primitives/dom.js";

/* Loaded on first open: sessions that never preview never fetch it. */
const ensureStyles = () => lazyStyle("preview.css");

const mime = f => f.blob?.type || f.type || "";
const isImage = f => mime(f).startsWith("image/");
const isPdf = f => mime(f) === "application/pdf" || /\.pdf$/i.test(f.name);

export const canPreview = f => !!f?.blob && (isImage(f) || isPdf(f));

/** Open the viewer for a file we hold. Returns false if it cannot be shown. */
export function openPreview(id) {
  const f = registry.get(id);
  if (!canPreview(f)) return false;
  ensureStyles();

  const type = isImage(f) ? mime(f) : "application/pdf";
  const url = URL.createObjectURL(new Blob([f.blob], { type }));

  const { el } = modal.show({
    className: "preview",
    labelledBy: "previewName",
    onClose: () => URL.revokeObjectURL(url),
    html: `
      <div class="preview-bar">
        <div class="preview-name" id="previewName">${esc(f.name)}
          <span class="preview-size">${esc(formatSize(f.size))}</span>
        </div>
        <button class="btn" type="button" data-save>Download</button>
        <button class="preview-x" type="button" data-modal-dismiss
                title="Close" aria-label="Close the preview">×</button>
      </div>
      <div class="preview-body">${isImage(f)
        ? `<img class="preview-img" src="${esc(url)}" alt="${esc(f.name)}">`
        : `<iframe class="preview-doc" src="${esc(url)}" title="${esc(f.name)}"></iframe>`}
      </div>`,
  });

  el.addEventListener("click", e => {
    if (e.target.closest("[data-save]")) registry.save(id);
  });
  return true;
}
