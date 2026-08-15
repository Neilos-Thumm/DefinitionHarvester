// Runs in the popup. The popup belongs to the window you opened it from,
// so "currentWindow" is always the window you're looking at.

const runBtn = document.getElementById("run");
const saveBtn = document.getElementById("save");
const wakeBox = document.getElementById("wake");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

let rows = [];

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
}

function toCSV(data) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["word", "definition", "source", "url"].map(q).join(",");
  const body = data.map((r) => [r.word, r.definition, r.source, r.url].map(q).join(","));
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

runBtn.addEventListener("click", harvest);
saveBtn.addEventListener("click", save);
