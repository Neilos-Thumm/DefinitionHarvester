// Bound script for the destination Google Sheet.
//
// Setup:
//   1. Open (or create) the target Sheet.
//   2. Extensions > Apps Script, delete the boilerplate, paste this file in.
//   3. Deploy > New deployment > type "Web app".
//      - Execute as: Me
//      - Who has access: Anyone with the link
//   4. Copy the resulting /exec URL into the extension's "Sheet destination" field.
//
// Anyone holding that URL can append rows to this sheet, so treat it like a
// password: don't post it publicly.

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const incoming = Array.isArray(body.rows) ? body.rows : [];

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(["word", "definition"]);

  const existing = new Set(
    sheet
      .getRange(1, 1, sheet.getLastRow(), 1)
      .getValues()
      .flat()
      .map((w) => String(w).trim().toLowerCase())
  );

  const toAppend = [];
  let added = 0;
  let skipped = 0;

  for (const row of incoming) {
    const word = String(row.word || "").trim();
    const definition = String(row.definition || "").trim();
    const key = word.toLowerCase();
    if (!word || !definition || existing.has(key)) {
      skipped++;
      continue;
    }
    existing.add(key);
    toAppend.push([word, definition]);
    added++;
  }

  // Optional separator row: "Book", "Book — Chapter", or with " — Part N"
  // appended if this same Book(+Chapter) has already been exported before.
  // Written to column B only (column A left blank), immediately before this
  // batch's own rows, styled dark red + bold on that single cell only.
  let separatorLabel = "";
  const sep = body.separator;
  const sepBook = sep && String(sep.book || "").trim();
  if (sepBook) {
    const sepChapter = String(sep.chapter || "").trim();
    const prefix = sepChapter ? `${sepBook} — ${sepChapter}` : sepBook;
    const colB = sheet.getLastRow() > 0
      ? sheet.getRange(1, 2, sheet.getLastRow(), 1).getValues().flat().map((v) => String(v).trim())
      : [];
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const partPattern = new RegExp(`^${escaped}(?: — Part \\d+)?$`);
    const priorParts = colB.filter((v) => partPattern.test(v)).length;

    separatorLabel = priorParts === 0 ? prefix : `${prefix} — Part ${priorParts + 1}`;
    sheet.getRange(sheet.getLastRow() + 1, 2, 1, 1)
      .setValue(separatorLabel)
      .setFontColor("#d43f3f")
      .setFontWeight("bold");
  }

  if (toAppend.length) {
    // Explicitly reset formatting — Sheets sometimes auto-extends the
    // separator row's red/bold styling into new rows written directly
    // below it, so word rows must clear that back to normal every time.
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 2)
      .setValues(toAppend)
      .setFontColor(null)
      .setFontWeight("normal");
  }

  return ContentService.createTextOutput(
    JSON.stringify({ added, skipped, total: sheet.getLastRow() - 1, separatorLabel })
  ).setMimeType(ContentService.MimeType.JSON);
}
