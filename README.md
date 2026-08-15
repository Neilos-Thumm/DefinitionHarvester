# Definition Harvester

A Chrome extension that scans every Google search tab open in the current window, pulls the word and its AI Overview definition out of each one, and lets you send the results to a CSV file, a Google Sheet, and/or Anki.

## How it works

For each Google search tab in the window, it extracts a definition using the first of these that succeeds:

1. **The blue `<mark>` highlight** inside the AI Overview — the exact phrase Google's AI Overview highlights as its source-backed answer. Grabbed verbatim, not reconstructed.
2. **Manually selected text** on the page, if you highlighted something yourself and the tab hasn't reloaded since.
3. **A regex parse** of the full AI Overview text (for the cases where Google doesn't render a highlight at all).
4. **A classic dictionary card**, if Google served one instead of an AI Overview.

Tabs that are asleep (discarded by Chrome to save memory) are skipped by default, since reading them would require reloading the tab and losing anything selected — check "Wake sleeping tabs" to reload them anyway.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config: permissions, which sites it can run on |
| `popup.html` / `popup.js` | The popup UI and all extraction/export logic |
| `sheet-webhook.gs` | Apps Script code you paste into your Google Sheet (see setup below) |


## Requirements

| Always needed | Only for Google Sheets export | Only for Anki export |
|---|---|---|
| Google Chrome (or another Chromium-based browser — Edge, Brave, etc.) | A Google account | The [Anki](https://apps.ankiweb.net/) desktop app, installed and running |
| A Google account (to run searches with AI Overviews) | — | The [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on, installed inside Anki |

No Node.js, no build step, no package manager — the extension is loaded straight from source (see [Install](#1-install-the-extension) below), and there's nothing to `npm install`.

---

## 1. Install the extension

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**, and select this folder (`Parse_repo`).
4. The extension icon appears in your toolbar. Pin it if you want it visible.

That's it for base functionality — **Harvest this window** and **Save CSV** work immediately with no further setup.

> Only `google.com` and `google.com.au` search tabs are recognized (see `host_permissions` in `manifest.json`). If you search on a different Google country domain, add a matching entry there and reload the extension.

---

## 2. Basic usage

1. Open one Google search tab per word you looked up.
2. Click the extension icon → **Harvest this window**.
3. Watch the log: green = confident match, yellow = a shakier fallback match, red = missed/blocked.
4. **Save CSV** downloads a two-column `word,definition` file for whatever you just harvested.

Every subsequent step below (Sheet / Anki export) reuses the same harvested list — harvest once, then push it wherever you want.

---

## 3. Configure Google Sheets export (optional)

This uses a small Google Apps Script "web app" bound to your own Sheet — the extension POSTs new words to it, and the script handles dedup on the Sheet side. No Google Cloud project or OAuth setup required.

1. **Create or open the Google Sheet** you want as your master word list.
2. In the Sheet, go to **Extensions → Apps Script**.
3. Delete whatever boilerplate code is there, and paste in the full contents of `sheet-webhook.gs` from this repo.
4. Click **Deploy → New deployment**.
5. Click the gear icon next to "Select type" and choose **Web app**.
6. Set:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone with the link`
7. Click **Deploy**, and authorize the script when prompted (it's your own script, running under your own account).
8. Copy the resulting URL — it ends in `/exec`.
9. In the extension popup, open the **Sheet destination** section and paste that URL into the field. It saves automatically.

⚠️ **Treat that URL like a password.** Anyone who has it can append rows to your sheet. Don't post it publicly.

Click **Export to Sheet** any time after a harvest. The script reads column A, skips anything already there (case-insensitive), and appends only new words — so re-exporting your full running list every session is always safe.

---

## 4. Configure Anki export (optional)

This uses **AnkiConnect**, a local add-on for the Anki desktop app that opens a small HTTP API on your machine (`127.0.0.1:8765`). The extension talks to it directly — no CSV step needed.

1. **Install AnkiConnect:**
   - In Anki: **Tools → Add-ons → Get Add-ons...**
   - Paste in the code: `2055492159`
   - Click OK, then **restart Anki**.
2. **Find your extension's ID:**
   - Go to `chrome://extensions`, make sure Developer mode is on.
   - Find "Definition Harvester" — copy the ID shown under it (a long lowercase string).
3. **Allow the extension to talk to AnkiConnect:**
   - In Anki: **Tools → Add-ons**, select **AnkiConnect**, click **Config**.
   - Find the `webCorsOriginList` array and add your extension's origin as a new entry, keeping whatever's already there:
     ```json
     "webCorsOriginList": [
       "http://localhost",
       "chrome-extension://YOUR_EXTENSION_ID_HERE"
     ]
     ```
   - Save, and restart Anki again.
4. **Set your deck name:**
   - In the extension popup, open the **Anki deck** section and type the exact name of an existing deck (e.g. `Vocabulary`).
   - **If you leave this blank, it does not use "whichever deck you have"** — it goes to a deck literally named `Default` (which Anki creates automatically), creating a second, separate deck if your real deck is named something else. Always fill this in if you have more than one deck.

**Anki must be open** (with AnkiConnect loaded) whenever you click **Add to Anki**.

Cards are added using the built-in **Basic (and reversed card)** note type — Front = word, Back = definition — so each word produces two cards (word→definition and definition→word). Duplicates are skipped automatically: AnkiConnect checks the Front field against existing notes in the target deck, so re-running this on your full running list is always safe.

---

## 5. "Do Both"

Runs the Sheet export and the Anki add at the same time and reports both results in one line, e.g.:

```
Sheet: 4 added, 1 duplicate skipped. Anki: 3 added, 2 duplicates skipped.
```

If one destination fails (e.g. Anki isn't open, or the Sheet URL is missing), the other still completes — you get a separate error only for the one that failed.

---

## 6. Getting your words into Anki without AnkiConnect

If you'd rather not set up AnkiConnect, the Sheet can still get you there manually:

1. In the Sheet: **File → Download → Comma Separated Values (.csv)**.
2. In Anki: **File → Import**, pick that file, map the two columns to Front/Back, Import.

Anki remembers the field mapping after the first time, and dedupes by the Front field by default — so re-downloading and re-importing your whole growing sheet each time is safe, no need to track "what's new" yourself.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A row's definition looks like a whole paragraph, or has a `?` in the log | No `<mark>` highlight was found and no `overview-unparsed` fallback matched a clean sentence — the raw AI Overview text is used, unparsed |
| "Anki add failed... is Anki open with AnkiConnect installed?" | Anki isn't running, AnkiConnect isn't installed, or your extension's origin isn't in `webCorsOriginList` (step 3 above) |
| Words land in an unexpected "Default" deck in Anki | The **Anki deck** field was left blank — see step 4 above |
| "Sheet export failed: HTTP 401/403" or similar | The Apps Script deployment's "Who has access" isn't set to "Anyone with the link", or the URL was copied wrong (must end in `/exec`, not `/dev`) |
| A tab is skipped with "— asleep" | Chrome discarded that tab to save memory; check **Wake sleeping tabs** to reload and read it (this loses any manual text selection on that tab) |

## Tech stack

- **Extension**: Chrome Extension **Manifest V3** — vanilla HTML/CSS/JavaScript, no framework, no bundler. UI lives entirely in `popup.html` + `popup.js`.
- **Chrome APIs used**: `chrome.tabs` (finding Google search tabs in the window), `chrome.scripting` (injecting the extraction function into each tab), `chrome.storage.local` (persisting your Sheet URL / Anki deck name between popup sessions).
- **Sheets integration**: [Google Apps Script](https://www.google.com/script/start/) (`sheet-webhook.gs`), deployed as a Web App that the extension talks to over plain `fetch`/JSON — no Google Cloud project, no OAuth client, no external libraries.
- **Anki integration**: [AnkiConnect](https://foosoft.net/projects/anki-connect/)'s local JSON-RPC-over-HTTP API (`127.0.0.1:8765`), called directly from the popup with `fetch`.
- **Dependencies**: none. No `package.json`, no third-party JS libraries anywhere in the extension itself.

