// Runs in the popup. The popup belongs to the window you opened it from,
// so "currentWindow" is always the window you're looking at.

const runBtn = document.getElementById("run");
const saveBtn = document.getElementById("save");
const exportSheetBtn = document.getElementById("exportSheet");
const sheetUrlInput = document.getElementById("sheetUrl");
const addAnkiBtn = document.getElementById("addAnki");
const ankiDeckInput = document.getElementById("ankiDeck");
const exportBothBtn = document.getElementById("exportBoth");
const wakeBox = document.getElementById("wake");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

let rows = [];

chrome.storage.local.get(["sheetUrl", "ankiDeck"], (v) => {
  if (v.sheetUrl) sheetUrlInput.value = v.sheetUrl;
  if (v.ankiDeck) ankiDeckInput.value = v.ankiDeck;
});
sheetUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ sheetUrl: sheetUrlInput.value.trim() });
});
ankiDeckInput.addEventListener("change", () => {
  chrome.storage.local.set({ ankiDeck: ankiDeckInput.value.trim() });
});

// ---------------------------------------------------------------------------
// Injected into every frame of a tab. Deliberately dumb: it grabs the two raw
// strings we might want and hands them back. All parsing happens in the popup,
// where it's easy to fix without touching page code.
// ---------------------------------------------------------------------------
function grabFrame() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // 1. Whatever text the user manually selected in this frame. A selection survives as long
  //    as the document isn't reloaded, so tabs you highlighted are readable.
  let selection = "";
  try {
    selection = clean(window.getSelection()?.toString());
  } catch (e) {}

  // 2. The AI Overview block, scoped to its own container so we never pick up
  //    an organic result snippet from further down the page.
  let overview = "";
  let overviewContainer = null;
  const label = [...document.querySelectorAll("h1, h2, div, span")].find(
    (el) => clean(el.innerText) === "AI Overview"
  );
  if (label) {
    let node = label.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const t = clean(node.innerText);
      if (t.length > 120) {
        overviewContainer = node;
        overview = t.slice(0, 2500);
        break;
      }
      node = node.parentElement;
    }
  }

  // 3. The actual blue-highlighted phrase Google renders inside the AI
  //    Overview — a <mark> element, not a text selection. This is the
  //    ground truth definition; grab it verbatim instead of reconstructing
  //    it from the surrounding prose.
  let mark = "";
  if (overviewContainer) {
    const marks = [...overviewContainer.querySelectorAll("mark")];
    mark = clean(marks.map((m) => m.innerText).join(" "));
  }

  // Classic dictionary card, if Google served one instead of an overview.
  let card = "";
  const dfn = document.querySelector('[data-dobid="dfn"]');
  if (dfn) card = clean(dfn.innerText);

  return { selection, overview, mark, card };
}

// ---------------------------------------------------------------------------
// Parsing — popup side.
// ---------------------------------------------------------------------------
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wordFromUrl(url) {
  try {
    const q = new URL(url).searchParams.get("q") || "";
    return clean(q)
      .replace(/^(define|definition of|meaning of)\s+/i, "")
      .replace(/\s+(meaning|definition|define)$/i, "");
  } catch (e) {
    return "";
  }
}

function stripLabels(text) {
  let s = clean(text);
  for (let i = 0; i < 6; i++) {
    const n = s.replace(
      /^(?:AI Overview|View all|Show more|Sponsored|Generative AI is experimental)\s*/i,
      ""
    );
    if (n === s) break;
    s = n;
  }
  return s;
}

function tidy(raw, word) {
  let d = clean(raw).split(/\.(?:\s|$)/)[0]; // stop at the first sentence break
  d = d.replace(/:\s*[•‣▪*]\s*/g, ": ").replace(/\s*[•‣▪]\s*|\s+\*\s+/g, "; ");
  d = clean(d).replace(/[;,:]\s*$/, "").slice(0, 400);
  return d.length > 3 && d.toLowerCase() !== word.toLowerCase() ? d : "";
}

function parseOverview(word, text) {
  const t = stripLabels(text);
  const w = escRe(word) + "(?:e?s)?";
  // Most specific first — the bare copula must come last, or
  // "is a verb that means X" would yield "a verb that means X".
  const patterns = [
    new RegExp("\\b" + w + "\\s+(?:is|are|was|were)\\s+(?:a|an)\\s+\\w+\\s+that\\s+means\\s+(.+)", "i"),
    /\bis\s+(?:a|an)\s+(?:term|word|phrase)\s+(?:used\s+)?(?:to\s+)?(?:describe|denote|refer\s+to)\s+(.+)/i,
    new RegExp("\\b" + w + "\\s+means\\s+(.+)", "i"),
    new RegExp("\\b" + w + "\\s+refers?\\s+to\\s+(.+)", "i"),
    new RegExp("\\b(?:a|an|the)?\\s*" + w + "\\s+(?:is|are|was|were)\\s+(.+)", "i"),
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (!m) continue;
    const d = tidy(m[1], word);
    if (d) return d;
  }
  return "";
}

// Merge the per-frame results into one answer. The blue AI Overview <mark>
// wins whenever it's present — it's the exact span Google is claiming as
// the definition, so there's nothing to parse or risk truncating.
function resolve(word, frames) {
  const mark = frames.map((f) => f?.mark).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (mark && mark.length >= 3) {
    return { definition: clean(mark).replace(/[;,:]\s*$/, ""), source: "ai-highlight" };
  }

  const sel = frames.map((f) => f?.selection).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (sel && sel.length >= 3 && sel.length <= 600) {
    return { definition: clean(sel).replace(/[;,:]\s*$/, ""), source: "highlight" };
  }

  const overview = frames.map((f) => f?.overview).filter(Boolean)[0];
  if (overview) {
    const d = parseOverview(word, overview);
    if (d) return { definition: d, source: "ai-overview" };
    return { definition: stripLabels(overview).slice(0, 400), source: "overview-unparsed" };
  }

  const card = frames.map((f) => f?.card).filter(Boolean)[0];
  if (card) return { definition: card.slice(0, 400), source: "dictionary-card" };

  return { definition: "", source: "not-found" };
}

// ---------------------------------------------------------------------------

const isGoogleSearch = (url = "") =>
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search\?/.test(url);

function line(text, cls) {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function harvest() {
  runBtn.disabled = true;
  saveBtn.disabled = true;
  exportSheetBtn.disabled = true;
  addAnkiBtn.disabled = true;
  exportBothBtn.disabled = true;
  logEl.textContent = "";
  rows = [];

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const targets = tabs.filter((t) => isGoogleSearch(t.url));

  if (!targets.length) {
    statusEl.textContent = "No Google search tabs in this window.";
    runBtn.disabled = false;
    return;
  }

  let hi = 0, parsed = 0, skipped = 0, missed = 0;

  for (const [i, tab] of targets.entries()) {
    statusEl.textContent = `Reading ${i + 1} of ${targets.length}...`;
    const word = wordFromUrl(tab.url);

    if (tab.discarded && !wakeBox.checked) {
      skipped++;
      line(`— asleep: ${word || tab.title.slice(0, 40)}`, "t-partial");
      continue;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: grabFrame,
      });
      const frames = results.map((r) => r?.result).filter(Boolean);
      const { definition, source } = resolve(word, frames);

      if (definition) {
        rows.push({ word, definition, source, url: tab.url });
        if (source === "ai-highlight" || source === "highlight") { hi++; line(`${word} — ${definition.slice(0, 40)}`, "t-ok"); }
        else if (source === "ai-overview") { parsed++; line(`${word} ~ ${definition.slice(0, 40)}`, "t-ok"); }
        else { parsed++; line(`? ${word} — ${definition.slice(0, 36)}`, "t-partial"); }
      } else {
        missed++;
        rows.push({ word, definition: "", source, url: tab.url });
        line(`✗ ${word || tab.title.slice(0, 30)}`, "t-miss");
      }
    } catch (e) {
      missed++;
      rows.push({ word, definition: "", source: "blocked", url: tab.url });
      line(`✗ blocked: ${word || tab.title.slice(0, 32)}`, "t-miss");
    }

    await sleep(wakeBox.checked ? 700 : 60);
  }

  const parts = [`${hi} highlighted`];
  if (parsed) parts.push(`${parsed} parsed`);
  if (missed) parts.push(`${missed} missed`);
  if (skipped) parts.push(`${skipped} asleep`);
  statusEl.textContent = parts.join(", ") + ".";
  runBtn.disabled = false;
  saveBtn.disabled = rows.length === 0;
  exportSheetBtn.disabled = rows.length === 0;
  addAnkiBtn.disabled = rows.length === 0;
  exportBothBtn.disabled = rows.length === 0;
}

function toCSV(data) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["word", "definition"].map(q).join(",");
  const body = data
    .filter((r) => r.definition)
    .map((r) => [r.word, r.definition].map(q).join(","));
  // BOM keeps accented characters intact when Excel opens it.
  return "\uFEFF" + [head, ...body].join("\r\n");
}

function save() {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `definitions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// POSTs to an Apps Script web app bound to the destination sheet (see
// sheet-webhook.gs). The script owns dedup — it reads column A, skips any
// word already there, and appends only what's new, so repeated exports
// across sessions accumulate into one clean master list. Returns a status
// string on success, throws on failure — callers decide how to show that.
async function pushToSheet() {
  const url = sheetUrlInput.value.trim();
  if (!url) throw new Error("set an Apps Script Web App URL under “Sheet destination” first");

  const payload = rows.filter((r) => r.definition).map((r) => ({ word: r.word, definition: r.definition }));

  const res = await fetch(url, {
    method: "POST",
    // text/plain avoids a CORS preflight, which Apps Script web apps don't handle.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ rows: payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return `Sheet: ${data.added} added, ${data.skipped} duplicate${data.skipped === 1 ? "" : "s"} skipped.`;
}

// Talks to AnkiConnect (localhost:8765) — a local add-on that must already be
// running inside an open Anki window. Duplicate notes (same Front field, same
// deck) are skipped automatically, so re-running this on the whole growing
// list each session is safe.
async function ankiCall(action, params) {
  const res = await fetch("http://127.0.0.1:8765", {
    method: "POST",
    body: JSON.stringify({ action, version: 6, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function pushToAnki() {
  const deckName = ankiDeckInput.value.trim() || "Default";

  const notes = rows
    .filter((r) => r.definition)
    .map((r) => ({
      deckName,
      modelName: "Basic (and reversed card)",
      fields: { Front: r.word, Back: r.definition },
      options: { allowDuplicate: false, duplicateScope: "deck" },
      tags: ["definition-harvester"],
    }));

  await ankiCall("createDeck", { deck: deckName });
  const result = await ankiCall("addNotes", { notes });
  const added = result.filter((id) => id !== null).length;
  const skipped = result.length - added;
  return `Anki: ${added} added, ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.`;
}

async function exportToSheet() {
  exportSheetBtn.disabled = true;
  statusEl.textContent = "Exporting to Sheet...";
  try {
    statusEl.textContent = await pushToSheet();
  } catch (e) {
    statusEl.textContent = "Sheet export failed: " + e.message;
  }
  exportSheetBtn.disabled = rows.length === 0;
}

async function addToAnki() {
  addAnkiBtn.disabled = true;
  statusEl.textContent = "Adding to Anki...";
  try {
    statusEl.textContent = await pushToAnki();
  } catch (e) {
    statusEl.textContent = "Anki add failed — is Anki open with AnkiConnect installed? (" + e.message + ")";
  }
  addAnkiBtn.disabled = rows.length === 0;
}

async function exportBoth() {
  exportSheetBtn.disabled = true;
  addAnkiBtn.disabled = true;
  exportBothBtn.disabled = true;
  statusEl.textContent = "Exporting to Sheet and Anki...";

  const [sheet, anki] = await Promise.allSettled([pushToSheet(), pushToAnki()]);
  const messages = [
    sheet.status === "fulfilled" ? sheet.value : "Sheet failed: " + sheet.reason.message,
    anki.status === "fulfilled" ? anki.value : "Anki failed: " + anki.reason.message,
  ];
  statusEl.textContent = messages.join(" ");

  exportSheetBtn.disabled = rows.length === 0;
  addAnkiBtn.disabled = rows.length === 0;
  exportBothBtn.disabled = rows.length === 0;
}

runBtn.addEventListener("click", harvest);
saveBtn.addEventListener("click", save);
exportSheetBtn.addEventListener("click", exportToSheet);
addAnkiBtn.addEventListener("click", addToAnki);
exportBothBtn.addEventListener("click", exportBoth);
