// Guide → premium HTML. ONE renderer, shared by the in-app preview, the PDF (print
// of the same document) and the published page (stored as body_html), so a guide
// looks identical everywhere. On top of plain Markdown it understands a small design
// system the model writes directly into the body:
//
//   :::requirements Was brauchst du?      ← the "what you need" opener box
//   - **ChatGPT Plus** (mind. 20 €/Monat)
//   :::
//   :::tip | :::example | :::note | :::warning   [optional title]
//   ...content (markdown)...
//   :::
//   ```prompt                             ← a copy-paste prompt card
//   <the prompt text>
//   ```

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PH = ""; // private-use sentinel for extracted code blocks (never in real text)

const CALLOUTS = {
  requirements: { icon: "🧰", title: "Was brauchst du?", cls: "req" },
  tip: { icon: "💡", title: "Tipp", cls: "tip" },
  example: { icon: "✦", title: "Beispiel", cls: "ex" },
  note: { icon: "ℹ️", title: "Hinweis", cls: "note" },
  warning: { icon: "⚠️", title: "Achtung", cls: "warn" },
};

function inline(t) {
  return esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderBlock(b, ctx) {
  if (!b) return "";
  if (b.lang === "prompt") {
    const copy = ctx.copy ? '<button class="cw-copy" onclick="cwCopy(this)">Kopieren</button>' : "";
    return '<div class="cw-prompt"><div class="cw-prompt-h"><span>PROMPT</span>' + copy + '</div><pre class="cw-prompt-b">' + esc(b.code) + "</pre></div>";
  }
  return "<pre><code>" + esc(b.code) + "</code></pre>";
}

function renderCallout(type, title, innerHtml) {
  const c = CALLOUTS[type];
  const heading = (title || c.title).trim();
  return '<div class="cw-cal cw-' + c.cls + '"><div class="cw-cal-h"><span class="cw-cal-i">' + c.icon + "</span>" + esc(heading) + '</div><div class="cw-cal-b">' + innerHtml + "</div></div>";
}

function renderStep(n, title, innerHtml) {
  const t = String(title || "").trim();
  return '<div class="cw-step"><span class="cw-step-n">' + n + "</span>" + (t ? '<div class="cw-step-t">' + esc(t) + "</div>" : "") + '<div class="cw-step-b">' + innerHtml + "</div></div>";
}

// Walk an array of lines (sharing the already-extracted code blocks) → HTML.
// topLevel=false inside a step/callout, so the lead (oversized intro) style is only
// ever applied to the guide's own opening paragraph.
function renderLines(lines, blocks, ctx, topLevel = true) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const ph = t.match(new RegExp("^" + PH + "(\\d+)" + PH + "$"));
    if (ph) { closeList(); out.push(renderBlock(blocks[+ph[1]], ctx)); continue; }
    const cm = t.match(/^:::\s*([a-zA-Z]+)\s*(.*)$/);
    const isBox = (w) => w === "step" || !!CALLOUTS[w];
    if (cm && isBox(cm[1].toLowerCase())) {
      closeList();
      const type = cm[1].toLowerCase(), inner = [];
      let title = (cm[2] || "").trim().replace(/^['"]|['"]$/g, "");
      let depth = 1;
      i++;
      for (; i < lines.length; i++) {
        const lt = lines[i].trim();
        if (lt === ":::") { if (--depth === 0) break; inner.push(lines[i]); continue; }
        const om = lt.match(/^:::\s*([a-zA-Z]+)/);
        if (om && isBox(om[1].toLowerCase())) depth++;
        inner.push(lines[i]);
      }
      if (type === "step") {
        // Steps auto-number, so a title that's just "1"/"1." is noise. And if the model
        // put the real title as a leading heading inside the step, promote it.
        if (/^\d+[.)]?$/.test(title)) title = "";
        if (!title) {
          let k = 0; while (k < inner.length && !inner[k].trim()) k++;
          const hm = k < inner.length ? inner[k].trim().match(/^#{1,4}\s+(.*)$/) : null;
          if (hm) { title = hm[1].trim(); inner.splice(0, k + 1); }
        }
      }
      const innerHtml = renderLines(inner, blocks, ctx, false);
      out.push(type === "step" ? renderStep(++ctx.stepNo, title, innerHtml) : renderCallout(type, title, innerHtml));
      continue;
    }
    if (!t) { closeList(); continue; }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { closeList(); if (m[1].length >= 2) ctx.seenH2 = true; out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); continue; }
    if ((m = t.match(/^>\s?(.*)$/))) { closeList(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); continue; }
    if ((m = t.match(/^[-*]\s+(.*)$/))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    closeList();
    const lead = topLevel && !ctx.seenLead && !ctx.seenH2;
    if (lead) ctx.seenLead = true;
    out.push("<p" + (lead ? ' class="lead"' : "") + ">" + inline(t) + "</p>");
  }
  closeList();
  return out.join("\n");
}

/** Markdown (+ design system) → inner HTML. Strips a leading H1 (the doc/fragment
 *  renders the title separately). Pass { copy:true } to include copy buttons on
 *  prompt cards (needs the cwCopy() helper, present in renderGuideDoc). */
export function mdToGuideHtml(md, { copy = false } = {}) {
  md = String(md || "").replace(/^﻿/, "").replace(/^\s*#\s+.*(?:\r?\n)+/, "");
  const blocks = [];
  md = md.replace(/```([a-zA-Z0-9_-]*)\r?\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push({ lang: (lang || "").toLowerCase(), code: code.replace(/\n$/, "") });
    return PH + (blocks.length - 1) + PH;
  });
  return renderLines(md.split(/\r?\n/), blocks, { copy, seenLead: false, seenH2: false, stepNo: 0 });
}

// The design system, scoped under .cw-guide so a fragment is safe to drop into any page.
export const GUIDE_CSS = `
.cw-guide{--ink:#1b1b1f;--muted:#5b5b66;--faint:#8a8a95;--line:#e9e7f0;--brand:#5b50e6;--brand-soft:#efedfd;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);line-height:1.72;font-size:16.5px;-webkit-font-smoothing:antialiased}
.cw-guide *{box-sizing:border-box}
.cw-guide .cw-kicker{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin-bottom:.2em}
.cw-guide h1{font-size:2.15rem;line-height:1.12;letter-spacing:-.03em;font-weight:820;margin:.15em 0 .45em}
.cw-guide h2{font-size:1.42rem;letter-spacing:-.02em;font-weight:760;margin:2.1em 0 .55em;padding-top:.75em;border-top:1px solid var(--line)}
.cw-guide h3{font-size:1.12rem;font-weight:720;margin:1.55em 0 .35em}
.cw-guide h4{font-size:1rem;font-weight:700;margin:1.2em 0 .3em;color:var(--muted)}
.cw-guide h1,.cw-guide h2,.cw-guide h3{text-wrap:balance}
.cw-guide p{margin:.75em 0}
.cw-guide p.lead{font-size:1.16rem;line-height:1.6;color:var(--muted);margin:.1em 0 1.15em}
.cw-guide a{color:var(--brand);text-decoration:none;border-bottom:1px solid var(--brand-soft)}
.cw-guide a:hover{border-bottom-color:var(--brand)}
.cw-guide strong{font-weight:700}
.cw-guide ul,.cw-guide ol{padding-left:1.3em;margin:.7em 0}
.cw-guide li{margin:.32em 0}
.cw-guide ul li::marker{color:var(--brand)}
.cw-guide code{background:#f3f2f8;border:1px solid #eae8f2;padding:.05em .38em;border-radius:5px;font-size:.86em;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace}
.cw-guide pre{background:#f6f5fb;border:1px solid var(--line);padding:14px 16px;border-radius:11px;overflow-x:auto;font-size:.85rem;line-height:1.55;margin:1em 0}
.cw-guide pre code{background:none;border:none;padding:0;font-size:1em}
.cw-guide blockquote{margin:1em 0;padding:.35em 0 .35em 1.1em;border-left:3px solid var(--line);color:var(--muted);font-style:italic}
.cw-guide .cw-cal{margin:1.3em 0;border:1px solid var(--c-bd);background:var(--c-bg);border-left:4px solid var(--c-ac);border-radius:13px;padding:15px 18px 5px}
.cw-guide .cw-cal-h{display:flex;align-items:center;gap:.5em;font-weight:750;font-size:.98rem;color:var(--c-tx);letter-spacing:-.01em;margin-bottom:.15em}
.cw-guide .cw-cal-i{font-size:1.05em;line-height:1}
.cw-guide .cw-cal-b>*:first-child{margin-top:.15em}
.cw-guide .cw-cal-b>*:last-child{margin-bottom:.5em}
.cw-guide .cw-cal-b p{margin:.5em 0}
.cw-guide .cw-cal-b ul,.cw-guide .cw-cal-b ol{margin:.4em 0}
.cw-guide .cw-req{--c-bg:#ecfdf6;--c-bd:#c9f0dd;--c-ac:#10b981;--c-tx:#0b7a55}
.cw-guide .cw-tip{--c-bg:#fffaeb;--c-bd:#fbecc4;--c-ac:#f59e0b;--c-tx:#a56a09}
.cw-guide .cw-ex{--c-bg:#eef1ff;--c-bd:#d8ddfb;--c-ac:#6366f1;--c-tx:#4547c4}
.cw-guide .cw-note{--c-bg:#f6f8fb;--c-bd:#e4e9f0;--c-ac:#94a3b8;--c-tx:#556577}
.cw-guide .cw-warn{--c-bg:#fef3f2;--c-bd:#f8d7d3;--c-ac:#ef4444;--c-tx:#c23b32}
.cw-guide .cw-step{position:relative;margin:1.15em 0;padding:1px 0 6px 52px}
.cw-guide .cw-step::before{content:"";position:absolute;left:16px;top:36px;bottom:-1.15em;width:2px;background:var(--line)}
.cw-guide .cw-step:last-of-type::before{display:none}
.cw-guide .cw-step-n{position:absolute;left:0;top:2px;width:34px;height:34px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:750;font-size:15px;box-shadow:0 2px 6px rgba(91,80,230,.28)}
.cw-guide .cw-step-t{font-size:1.15rem;font-weight:730;letter-spacing:-.015em;margin:6px 0 .3em}
.cw-guide .cw-step-b>*:first-child{margin-top:.1em}
.cw-guide .cw-prompt{margin:1.3em 0;border-radius:12px;overflow:hidden;border:1px solid #23213a;background:#151424}
.cw-guide .cw-prompt-h{display:flex;align-items:center;justify-content:space-between;background:#1d1b30;color:#a9a4d6;font-size:11px;font-weight:700;letter-spacing:.13em;padding:9px 14px}
.cw-guide .cw-copy{background:#322f52;color:#d7d4f0;border:none;border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.02em;padding:5px 11px;cursor:pointer;font-family:inherit}
.cw-guide .cw-copy:hover{background:#403c66}
.cw-guide .cw-prompt-b{margin:0;padding:15px 16px;color:#e9e7fb;background:#151424;font-size:.85rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;overflow-x:auto}
@media print{
  .cw-guide{font-size:11.5pt;color:#000}
  .cw-guide .cw-copy{display:none}
  .cw-guide .cw-cal,.cw-guide .cw-prompt,.cw-guide .cw-step,.cw-guide pre{page-break-inside:avoid}
  .cw-guide h1,.cw-guide h2,.cw-guide h3{page-break-after:avoid}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
}`;

const COPY_JS = `function cwCopy(b){try{var p=b.closest('.cw-prompt').querySelector('.cw-prompt-b');navigator.clipboard.writeText(p.innerText);var o=b.textContent;b.textContent='Kopiert \\u2713';setTimeout(function(){b.textContent=o},1300);}catch(e){}}`;

/** Full standalone HTML document — used for the in-app Preview popup and the PDF. */
export function renderGuideDoc({ title = "Guide", body_md = "" } = {}) {
  const t = esc(title);
  const body = mdToGuideHtml(body_md, { copy: true });
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>
html{background:#faf9fc}
body{margin:0;padding:56px 24px 96px}
.cw-wrap{max-width:760px;margin:0 auto}
${GUIDE_CSS}
@media print{html,body{background:#fff}body{padding:0}}
</style></head><body><div class="cw-wrap"><article class="cw-guide"><div class="cw-kicker">Guide</div><h1>${t}</h1>${body}</article></div><script>${COPY_JS}</script></body></html>`;
}

/** Self-contained HTML fragment (carries its own scoped styles) — stored as body_html
 *  so the published page renders with the identical design. */
export function renderGuideFragment({ title = "Guide", body_md = "" } = {}) {
  const t = esc(title);
  const body = mdToGuideHtml(body_md, { copy: false });
  return `<style>${GUIDE_CSS}</style><article class="cw-guide"><div class="cw-kicker">Guide</div><h1>${t}</h1>${body}</article>`;
}
