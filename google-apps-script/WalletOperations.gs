function doGet() {
  return jsonResponse({ success: true, service: "wallet-operations" });
}

function doPost(event) {
  let lock;
  try {
    if (!event?.postData?.contents) {
      throw new Error("Request body is missing.");
    }
    const payload = JSON.parse(event.postData.contents);
    const signature = payload.signature;
    delete payload.signature;

    if (!isValidSignature(payload, signature)) {
      return jsonResponse({ success: false, error: "Unauthorized operation." });
    }

    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) {
      return jsonResponse({
        success: false,
        code: "WALLET_BUSY",
        error: "Wallet operations are busy. Please try again.",
      });
    }

    const result =
      payload.action === "approve_top_up" ? approveTopUp(payload) : null;
    if (!result) {
      return jsonResponse({
        success: false,
        error: "Unsupported wallet operation.",
      });
    }
    return jsonResponse({ success: true, ...result });
  } catch (error) {
    return jsonResponse({
      success: false,
      code: error.code || "WALLET_OPERATION_FAILED",
      error: error.message || "Wallet operation failed.",
    });
  } finally {
    if (lock?.hasLock()) lock.releaseLock();
  }
}

function isValidSignature(payload, signature) {
  const secret = PropertiesService.getScriptProperties().getProperty(
    "WALLET_SHEETS_OPERATIONS_SECRET"
  );
  if (!secret || !signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const body = JSON.stringify(payload);
  const digest = Utilities.computeHmacSha256Signature(body, secret);
  const expected = digest
    .map((byte) => (byte + 256).toString(16).slice(-2))
    .join("");
  return constantTimeEqual(expected, signature.toLowerCase());
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function getSpreadsheet() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty("GOOGLE_SHEET_ID");
  const sheetName = properties.getProperty("GOOGLE_SHEET_NAME") || "Sheet1";
  if (!spreadsheetId) throw new Error("Google Sheet ID is not configured.");
  return {
    spreadsheet: SpreadsheetApp.openById(spreadsheetId),
    sheetName,
  };
}

function getWalletSheet(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error("The wallet account sheet was not found.");
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((value) => String(value).trim().toLowerCase());
  const usernameColumn = headers.indexOf("username");
  const walletColumn = headers.indexOf("wallet");
  if (usernameColumn === -1 || walletColumn === -1) {
    throw new Error("The wallet sheet is missing required headers.");
  }
  return { sheet, values, usernameColumn, walletColumn };
}

function findWalletRow(walletData, username) {
  const rowIndex = walletData.values.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[walletData.usernameColumn] || "")
        .trim()
        .toLowerCase() === username.toLowerCase()
  );
  if (rowIndex === -1) throw new Error("Wallet account was not found.");
  const balance = Number(walletData.values[rowIndex][walletData.walletColumn] || 0);
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("Wallet balance is invalid.");
  }
  return { rowNumber: rowIndex + 1, balance };
}

function approveTopUp(payload) {
  if (
    typeof payload.requestId !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.expectedFingerprint !== "string"
  ) {
    throw new Error("Top-up approval details are invalid.");
  }

  const { spreadsheet, sheetName } = getSpreadsheet();
  const walletData = getWalletSheet(spreadsheet, sheetName);
  const transactionsSheet = spreadsheet.getSheetByName("Wallet Transactions");
  if (!transactionsSheet) throw new Error("Wallet transaction sheet is missing.");
  const rows = transactionsSheet.getDataRange().getValues();
  const rowIndex = rows.findIndex(
    (row, index) => index > 0 && String(row[0] || "") === payload.requestId
  );
  if (rowIndex === -1) throw new Error("Wallet request was not found.");

  const row = rows[rowIndex];
  if (
    String(row[1] || "").trim().toLowerCase() !==
      payload.username.toLowerCase() ||
    String(row[2] || "") !== "top_up_request"
  ) {
    throw new Error("Wallet request does not match the account.");
  }
  if (String(row[5] || "") !== "pending") {
    const error = new Error("Wallet request is no longer pending.");
    error.code = "REQUEST_ALREADY_PROCESSED";
    throw error;
  }

  const amount = Number(row[4]);
  const details = JSON.parse(String(row[3] || "{}"));
  const fingerprintInput = JSON.stringify({
    amount,
    paymentMethod: details.paymentMethod || "",
    mobileNumber: details.mobileNumber || "",
    whatsappNumber: details.whatsappNumber || "",
  });
  const fingerprint = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    fingerprintInput,
    Utilities.Charset.UTF_8
  )
    .map((byte) => (byte + 256).toString(16).slice(-2))
    .join("");
  if (fingerprint !== payload.expectedFingerprint) {
    const error = new Error("Wallet request details have changed.");
    error.code = "REQUEST_CHANGED";
    throw error;
  }

  const wallet = findWalletRow(walletData, payload.username);
  const newBalance = Math.round((wallet.balance + amount) * 100) / 100;
  applyAtomicSheetUpdates(spreadsheet.getId(), [
    updateCellRequest(
      walletData.sheet.getSheetId(),
      wallet.rowNumber,
      walletData.walletColumn + 1,
      newBalance
    ),
    updateCellRequest(transactionsSheet.getSheetId(), rowIndex + 1, 6, "approved"),
  ]);

  return { balance: newBalance, amount };
}

function updateCellRequest(sheetId, rowNumber, columnNumber, value) {
  const userEnteredValue =
    typeof value === "number" ? { numberValue: value } : { stringValue: value };
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: columnNumber - 1,
        endColumnIndex: columnNumber,
      },
      rows: [{ values: [{ userEnteredValue }] }],
      fields: "userEnteredValue",
    },
  };
}

function appendRowRequest(sheetId, values) {
  return {
    appendCells: {
      sheetId,
      rows: [
        {
          values: values.map((value) => ({
            userEnteredValue:
              typeof value === "number"
                ? { numberValue: value }
                : { stringValue: value },
          })),
        },
      ],
      fields: "userEnteredValue",
    },
  };
}

function applyAtomicSheetUpdates(spreadsheetId, requests) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}:batchUpdate`;
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    payload: JSON.stringify({ requests }),
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `Atomic wallet update failed (${statusCode}): ${response.getContentText()}`
    );
  }
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON
  );
}
