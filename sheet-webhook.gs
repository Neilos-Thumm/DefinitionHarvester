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

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 2).setValues(toAppend);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ added, skipped, total: sheet.getLastRow() - 1 })
  ).setMimeType(ContentService.MimeType.JSON);
}
