const HEADERS = [
  'timestamp', 'title', 'original_message', 'link', 'summary', 'user_note', 'type', 'deadline', 'tags', 'shared_by_name', 'shared_by_username', 'action', '_record_key',
];
const LEGACY_HEADERS = [
  'timestamp', 'title', 'original_message', 'link', 'summary', 'user_note', 'type', 'deadline', 'tags', 'shared_by_name', 'shared_by_username', '_record_key',
];
const STATUS_HEADERS = ['updated_at', 'job_id', 'url_hash', 'source_url', 'status', 'attempt_count', 'provider', 'message', 'main_row_number'];
const FAILURE_HEADERS = ['failure_key', 'recorded_at', 'job_id', 'url_hash', 'source_url', 'attempt_number', 'code', 'message', 'retryable', 'provider_status'];
const TYPE_OPTIONS = ['grant', 'competition', 'article', 'event', 'tool', 'report', 'opportunity', 'other'];

function doPost(e) {
  try {
    const envelope = JSON.parse(e?.postData?.contents || '{}');
    const properties = PropertiesService.getScriptProperties();
    const secret = (properties.getProperty('BRIDGE_SHARED_SECRET') || '').trim();
    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    const tabName = properties.getProperty('SHEET_TAB') || 'Links';
    const statusTabName = properties.getProperty('STATUS_TAB') || 'Status';
    const failuresTabName = properties.getProperty('FAILURES_TAB') || 'Failures';
    if (!secret || !spreadsheetId) return json_({ ok: false, error: 'bridge_not_configured', debug_code: 'missing_properties' });
    const verification = verifyEnvelope_(envelope, secret);
    if (!verification.ok) return json_({ ok: false, error: 'unauthorized', debug_code: verification.reason });

    const payload = JSON.parse(envelope.payload_json);
    if (!payload || typeof payload.kind !== 'string' || !Array.isArray(payload.row)) return json_({ ok: false, error: 'invalid_payload' });

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (payload.kind === 'main') return saveMain_(spreadsheet, tabName, payload);
    if (payload.kind === 'status') return upsertStatus_(spreadsheet, statusTabName, payload);
    if (payload.kind === 'failure') return saveFailure_(spreadsheet, failuresTabName, payload);
    return json_({ ok: false, error: 'unknown_kind' });
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    return json_({ ok: false, error: 'bridge_failed' });
  }
}

function saveMain_(spreadsheet, tabName, payload) {
  if (typeof payload.urlHash !== 'string' || payload.row.length !== HEADERS.length) return json_({ ok: false, error: 'invalid_main_payload' });
  const sheet = getMainSheet_(spreadsheet, tabName);
  migrateMainSchema_(sheet);
  ensureHeader_(sheet, HEADERS);
  formatMainSheet_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 13, lastRow - 1, 1).getValues();
    for (let index = 0; index < keys.length; index += 1) if (String(keys[index][0]) === payload.urlHash) return json_({ ok: true, status: 'already_saved', rowNumber: index + 2 });
  }
  sheet.appendRow(payload.row);
  formatMainSheet_(sheet);
  return json_({ ok: true, status: 'saved', rowNumber: sheet.getLastRow() });
}

function upsertStatus_(spreadsheet, tabName, payload) {
  if (typeof payload.key !== 'string' || payload.row.length !== STATUS_HEADERS.length) return json_({ ok: false, error: 'invalid_status_payload' });
  const sheet = getOrCreateSheet_(spreadsheet, tabName);
  ensureHeader_(sheet, STATUS_HEADERS);
  formatSupportSheet_(sheet, STATUS_HEADERS);
  const existing = findValueRow_(sheet, 2, payload.key);
  if (existing) sheet.getRange(existing, 1, 1, STATUS_HEADERS.length).setValues([payload.row]);
  else { sheet.appendRow(payload.row); return json_({ ok: true, status: 'saved', rowNumber: sheet.getLastRow() }); }
  return json_({ ok: true, status: 'updated', rowNumber: existing });
}

function saveFailure_(spreadsheet, tabName, payload) {
  if (typeof payload.key !== 'string' || payload.row.length !== FAILURE_HEADERS.length) return json_({ ok: false, error: 'invalid_failure_payload' });
  const sheet = getOrCreateSheet_(spreadsheet, tabName);
  ensureHeader_(sheet, FAILURE_HEADERS);
  formatSupportSheet_(sheet, FAILURE_HEADERS);
  const existing = findValueRow_(sheet, 1, payload.key);
  if (existing) return json_({ ok: true, status: 'already_saved', rowNumber: existing });
  sheet.appendRow(payload.row);
  return json_({ ok: true, status: 'saved', rowNumber: sheet.getLastRow() });
}

function getOrCreateSheet_(spreadsheet, tabName) {
  return spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
}

function getMainSheet_(spreadsheet, requestedName) {
  const existing = spreadsheet.getSheetByName(requestedName);
  // Keep a legacy Sheet1 intact if it has the previous wide schema. The new
  // compact view is written to Links until the user explicitly switches tabs.
  if (requestedName === 'Sheet1' && existing && !headerMatches_(existing, HEADERS)) return getOrCreateSheet_(spreadsheet, 'Links');
  return existing || spreadsheet.insertSheet(requestedName);
}

function migrateMainSchema_(sheet) {
  if (headerMatches_(sheet, LEGACY_HEADERS)) {
    sheet.insertColumnBefore(12);
    sheet.getRange(1, 12).setValue('action');
  }
}

function findValueRow_(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (let index = 0; index < values.length; index += 1) if (String(values[index][0]) === value) return index + 2;
  return null;
}

function ensureHeader_(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  let matches = true;
  for (let index = 0; index < headers.length; index += 1) if (current[index] !== headers[index]) matches = false;
  if (!matches) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function headerMatches_(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  for (let index = 0; index < headers.length; index += 1) if (current[index] !== headers[index]) return false;
  return true;
}

function formatMainSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.hideColumns(13);
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f4e78').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 30);
  sheet.setColumnWidths(1, 12, 150);
  [2, 3, 5, 6, 9].forEach((column) => sheet.getRange(1, column, Math.max(sheet.getLastRow(), 1), 1).setWrap(true));
  sheet.setColumnWidth(2, 230);
  sheet.setColumnWidth(3, 320);
  sheet.setColumnWidth(4, 260);
  sheet.setColumnWidth(5, 420);
  sheet.setColumnWidth(6, 260);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 140);
  sheet.setColumnWidth(9, 240);
  sheet.setColumnWidth(10, 180);
  sheet.setColumnWidth(11, 160);
  sheet.setColumnWidth(12, 110);
  const archiveName = PropertiesService.getScriptProperties().getProperty('ARCHIVE_TAB') || 'Archive';
  const actionOptions = sheet.getName() === archiveName ? ['Keep', 'Save edits', 'Restore', 'Delete'] : ['Keep', 'Save edits', 'Archive', 'Delete'];
  const actionRule = SpreadsheetApp.newDataValidation().requireValueInList(actionOptions, true).setAllowInvalid(false).build();
  sheet.getRange(2, 12, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(actionRule);
  const typeRule = SpreadsheetApp.newDataValidation().requireValueInList(TYPE_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, 7, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(typeRule);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 12).createFilter();
}

function formatSupportSheet_(sheet, headers) {
  sheet.setFrozenRows(1);
  const header = sheet.getRange(1, 1, 1, headers.length);
  header.setFontWeight('bold').setFontColor('#ffffff').setBackground('#5b6573').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 28);
  sheet.setColumnWidths(1, headers.length, 150);
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(headers.length, 280);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), headers.length).createFilter();
}

function verifyEnvelope_(envelope, secret) {
  if (!envelope || typeof envelope.timestamp !== 'string' || typeof envelope.payload_json !== 'string' || typeof envelope.signature !== 'string') return { ok: false, reason: 'missing_fields' };
  const timestamp = Number(envelope.timestamp);
  if (!Number.isInteger(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return { ok: false, reason: 'timestamp_skew' };
  const bytes = Utilities.computeHmacSha256Signature(envelope.timestamp + '.' + envelope.payload_json, secret, Utilities.Charset.UTF_8);
  const expected = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  return constantTimeEqual_(expected, envelope.signature) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

function constantTimeEqual_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

// Run installSheetActionTrigger once from the Apps Script editor. The trigger
// lets the Sheet act as the safe delete/archive control surface.
function installSheetActionTrigger() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Set SPREADSHEET_ID before installing the trigger.');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const tabName = properties.getProperty('SHEET_TAB') || 'Links';
  const sheet = getMainSheet_(spreadsheet, tabName);
  migrateMainSchema_(sheet);
  ensureHeader_(sheet, HEADERS);
  formatMainSheet_(sheet);
  const archiveName = properties.getProperty('ARCHIVE_TAB') || 'Archive';
  const archive = spreadsheet.getSheetByName(archiveName);
  if (archive) {
    migrateMainSchema_(archive);
    ensureHeader_(archive, HEADERS);
    formatMainSheet_(archive);
  }
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'handleSheetActionEdit') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('handleSheetActionEdit').forSpreadsheet(spreadsheetId).onEdit().create();
}

function handleSheetActionEdit(e) {
  if (!e || !e.range || e.range.getRow() < 2 || e.range.getColumn() !== 12 || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
  const properties = PropertiesService.getScriptProperties();
  const spreadsheet = e.range.getSheet().getParent();
  const tabName = properties.getProperty('SHEET_TAB') || 'Links';
  const archiveName = properties.getProperty('ARCHIVE_TAB') || 'Archive';
  const currentTab = e.range.getSheet().getName();
  if (currentTab !== tabName && currentTab !== archiveName) return;
  const action = String(e.value || '').trim().toLowerCase();
  const allowedActions = currentTab === archiveName ? ['save edits', 'restore', 'delete'] : ['save edits', 'archive', 'delete'];
  if (!allowedActions.includes(action)) return;
  const rowNumber = e.range.getRow();
  const recordKey = String(e.range.getSheet().getRange(rowNumber, 13).getValue() || '').trim();
  const workerUrl = properties.getProperty('WORKER_ACTION_URL');
  const secret = (properties.getProperty('BRIDGE_SHARED_SECRET') || '').trim();
  let restoreAlreadyActive = false;
  if (!workerUrl || !secret || !/^[a-f0-9]{64}$/i.test(recordKey)) {
    e.range.setValue('Error');
    spreadsheet.toast('Missing Worker action settings or record key.');
    return;
  }
  try {
    const response = callWorkerAction_(workerUrl, secret, {
      action: action,
      recordKey: recordKey,
      requestedBy: Session.getEffectiveUser().getEmail() || 'sheet-user',
    });
    if (!response.ok) throw new Error(response.error || 'Worker rejected the action.');
    if (action === 'save edits') {
      const rowData = e.range.getSheet().getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
      const response = callWorkerAction_(workerUrl, secret, {
        action: 'save_edits',
        recordKey: recordKey,
        requestedBy: Session.getEffectiveUser().getEmail() || 'sheet-user',
        fields: {
          title: rowData[1],
          summary: rowData[4],
          userNote: rowData[5],
          type: rowData[6],
          deadline: rowData[7],
          tags: rowData[8],
        },
      });
      if (!response.ok) throw new Error(response.error || 'Worker rejected the edit.');
      e.range.setValue('');
      spreadsheet.toast('Edits saved to D1 JSON.');
      return;
    }
    if (action === 'archive') {
      const archive = getOrCreateSheet_(spreadsheet, archiveName);
      migrateMainSchema_(archive);
      ensureHeader_(archive, HEADERS);
      const rowData = e.range.getSheet().getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
      rowData[11] = '';
      archive.appendRow(rowData);
      formatMainSheet_(archive);
    } else if (action === 'restore') {
      const links = getMainSheet_(spreadsheet, tabName);
      migrateMainSchema_(links);
      ensureHeader_(links, HEADERS);
      const existingRow = findValueRow_(links, 13, recordKey);
      restoreAlreadyActive = Boolean(existingRow);
      if (!existingRow) {
        const rowData = e.range.getSheet().getRange(rowNumber, 1, 1, HEADERS.length).getValues()[0];
        rowData[11] = '';
        links.appendRow(rowData);
        formatMainSheet_(links);
      }
    }
    e.range.getSheet().deleteRow(rowNumber);
    spreadsheet.toast(action === 'archive' ? 'Archived successfully.' : action === 'restore' ? (restoreAlreadyActive ? 'Already active; removed duplicate archive row.' : 'Restored successfully.') : 'Deleted successfully.');
  } catch (error) {
    e.range.setValue('Error');
    spreadsheet.toast(`Action failed: ${error.message || error}`);
  }
}


function callWorkerAction_(workerUrl, secret, payload) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payloadJson = JSON.stringify(payload);
  const bytes = Utilities.computeHmacSha256Signature(timestamp + '.' + payloadJson, secret, Utilities.Charset.UTF_8);
  const signature = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  const response = UrlFetchApp.fetch(workerUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ timestamp: timestamp, payload_json: payloadJson, signature: signature }),
    muteHttpExceptions: true,
  });
  try { return JSON.parse(response.getContentText()); } catch { return { ok: false, error: 'invalid_worker_response' }; }
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
