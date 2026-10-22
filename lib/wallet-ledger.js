import { google } from "googleapis";
import { createHash, randomUUID } from "node:crypto";

const SHEET_TITLE = "Wallet Transactions";
const HEADERS = [
  "transaction_id",
  "username",
  "type",
  "description",
  "amount",
  "status",
  "created_at",
];

function getTopUpRequestFingerprint(amount, description) {
  let details;
  try {
    details = JSON.parse(String(description || "{}"));
  } catch {
    throw new Error("The wallet request details are invalid.");
  }

  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: Number(amount),
        paymentMethod: details.paymentMethod || "",
        mobileNumber: details.mobileNumber || "",
        whatsappNumber: details.whatsappNumber || "",
      })
    )
    .digest("hex");
}

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!email || !privateKey || !spreadsheetId) {
    throw new Error("Google Sheets environment variables are missing.");
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return {
    api: google.sheets({ version: "v4", auth }),
    spreadsheetId,
  };
}

async function getOrCreateSheet(api, spreadsheetId) {
  const { data } = await api.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const existing = data.sheets?.find(
    (sheet) => sheet.properties?.title === SHEET_TITLE
  );

  if (existing) return existing.properties.sheetId;

  try {
    const result = await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
      },
    });
    return result.data.replies[0].addSheet.properties.sheetId;
  } catch (error) {
    const { data: latest } = await api.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    });
    const concurrentlyCreated = latest.sheets?.find(
      (sheet) => sheet.properties?.title === SHEET_TITLE
    );

    if (concurrentlyCreated) return concurrentlyCreated.properties.sheetId;
    throw error;
  }
}

async function ensureHeaders(api, spreadsheetId) {
  await getOrCreateSheet(api, spreadsheetId);
  const range = `'${SHEET_TITLE}'!A1:G1`;
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  if (!data.values?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return;
  }

  const headers = data.values[0].map((value) =>
    String(value).trim().toLowerCase()
  );
  if (HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error(`The ${SHEET_TITLE} sheet has unexpected headers.`);
  }
}

export async function getWalletTransactions(username) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:G`,
  });
  const rows = data.values || [];

  return rows
    .slice(1)
    .filter(
      (row) =>
        String(row[1] || "").trim().toLowerCase() === username.toLowerCase()
    )
    .map((row) => ({
      id: String(row[0] || ""),
      type: String(row[2] || ""),
      description: String(row[3] || ""),
      amount: Number(row[4]),
      status: String(row[5] || ""),
      createdAt: String(row[6] || ""),
    }))
    .filter((transaction) => Number.isFinite(transaction.amount))
    .reverse();
}

export async function createWalletTopUpRequest({
  username,
  email,
  currentBalance,
  amount,
  paymentMethod,
  mobileNumber,
  whatsappNumber,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const description = JSON.stringify({
    email,
    currentBalance,
    paymentMethod,
    mobileNumber,
    whatsappNumber,
  });

  await api.spreadsheets.values.append({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:G`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        id,
        username,
        "top_up_request",
        description,
        amount,
        "pending",
        createdAt,
      ]],
    },
  });

  return id;
}

export async function updateWalletTopUpRequest({
  id,
  username,
  email,
  currentBalance,
  amount,
  paymentMethod,
  mobileNumber,
  whatsappNumber,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:G`,
  });
  const rows = data.values || [];
  const index = rows.findIndex(
    (row, rowIndex) => rowIndex > 0 && String(row[0] || "") === id
  );

  if (index === -1) return null;

  const row = rows[index];
  if (
    String(row[1] || "").trim().toLowerCase() !== username.toLowerCase() ||
    row[2] !== "top_up_request"
  ) {
    return null;
  }
  if (row[5] !== "pending") {
    return { unavailable: true };
  }

  let previousDetails;
  try {
    const parsedDetails = JSON.parse(String(row[3] || "{}"));
    previousDetails =
      parsedDetails && typeof parsedDetails === "object"
        ? parsedDetails
        : {};
  } catch {
    throw new Error("The wallet request details are invalid.");
  }

  const transaction = {
    id,
    username,
    previousAmount: Number(row[4]),
    previousDetails,
    amount,
    details: {
      email,
      currentBalance,
      paymentMethod,
      mobileNumber,
      whatsappNumber,
    },
    status: "pending",
    createdAt: String(row[6] || ""),
  };

  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!D${index + 1}:E${index + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[JSON.stringify(transaction.details), amount]],
    },
  });

  return transaction;
}

export async function cancelWalletTopUpRequest({
  id,
  username,
  expectedFingerprint,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:G`,
  });
  const rows = data.values || [];
  const index = rows.findIndex(
    (row, rowIndex) => rowIndex > 0 && String(row[0] || "") === id
  );

  if (index === -1) return null;

  const row = rows[index];
  if (
    String(row[1] || "").trim().toLowerCase() !== username.toLowerCase() ||
    row[2] !== "top_up_request"
  ) {
    return null;
  }
  if (row[5] !== "pending") return { unavailable: true };
  if (
    expectedFingerprint &&
    getTopUpRequestFingerprint(row[4], row[3]) !== expectedFingerprint
  ) {
    return { changed: true };
  }

  let details;
  try {
    const parsedDetails = JSON.parse(String(row[3] || "{}"));
    details =
      parsedDetails && typeof parsedDetails === "object"
        ? parsedDetails
        : {};
  } catch {
    throw new Error("The wallet request details are invalid.");
  }

  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!F${index + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [["cancelled"]] },
  });

  return {
    id,
    username,
    amount: Number(row[4]),
    details,
  };
}

export async function approveWalletTopUpRequest({
  id,
  username,
  expectedFingerprint,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const mainSheetName = process.env.GOOGLE_SHEET_NAME || "Sheet1";
  const escapedMainSheetName = mainSheetName.replace(/'/g, "''");
  const [walletSheet, ledgerSheet, spreadsheetInfo] = await Promise.all([
    api.spreadsheets.values.get({
      spreadsheetId,
      range: `'${escapedMainSheetName}'!A:U`,
    }),
    api.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SHEET_TITLE}'!A:G`,
    }),
    api.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    }),
  ]);
  const walletRows = walletSheet.data.values || [];
  const ledgerRows = ledgerSheet.data.values || [];
  const walletHeaders = (walletRows[0] || []).map((value) =>
    String(value).trim().toLowerCase()
  );
  const walletColumn = walletHeaders.indexOf("wallet");
  const emailChangeExpiresColumn = walletHeaders.indexOf(
    "email_change_expires_at"
  );

  if (walletColumn !== 20 || emailChangeExpiresColumn !== 19) {
    throw new Error(
      "Google Sheet must have a wallet header in column U, immediately after email_change_expires_at."
    );
  }

  const ledgerIndex = ledgerRows.findIndex(
    (row, rowIndex) => rowIndex > 0 && String(row[0] || "") === id
  );
  if (ledgerIndex === -1) return null;

  const ledgerRow = ledgerRows[ledgerIndex];
  if (
    String(ledgerRow[1] || "").trim().toLowerCase() !== username.toLowerCase() ||
    ledgerRow[2] !== "top_up_request"
  ) {
    return null;
  }
  if (ledgerRow[5] !== "pending") {
    return { unavailable: true, status: String(ledgerRow[5] || "") };
  }
  if (
    expectedFingerprint &&
    getTopUpRequestFingerprint(ledgerRow[4], ledgerRow[3]) !==
      expectedFingerprint
  ) {
    return { changed: true };
  }

  let details;
  try {
    const parsedDetails = JSON.parse(String(ledgerRow[3] || "{}"));
    details =
      parsedDetails && typeof parsedDetails === "object"
        ? parsedDetails
        : {};
  } catch {
    throw new Error("The wallet request details are invalid.");
  }

  const amount = Number(ledgerRow[4]);
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
    throw new Error("The wallet request amount is invalid.");
  }

  const usernameColumn = walletHeaders.indexOf("username");
  if (usernameColumn === -1) {
    throw new Error("Google Sheet must contain a username header.");
  }
  const walletRowIndex = walletRows.findIndex(
    (row, rowIndex) =>
      rowIndex > 0 &&
      String(row[usernameColumn] || "").trim().toLowerCase() ===
        username.toLowerCase()
  );
  if (walletRowIndex === -1) return null;

  const walletSheetId = spreadsheetInfo.data.sheets?.find(
    (sheet) => sheet.properties?.title === mainSheetName
  )?.properties?.sheetId;
  const ledgerSheetId = spreadsheetInfo.data.sheets?.find(
    (sheet) => sheet.properties?.title === SHEET_TITLE
  )?.properties?.sheetId;
  if (walletSheetId === undefined || ledgerSheetId === undefined) {
    throw new Error("The wallet account or transaction sheet was not found.");
  }

  const currentBalance = Number(walletRows[walletRowIndex][walletColumn] || 0);
  if (!Number.isFinite(currentBalance) || currentBalance < 0) {
    throw new Error("The current wallet balance is invalid.");
  }
  const newBalance = Math.round((currentBalance + amount) * 100) / 100;

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            range: {
              sheetId: walletSheetId,
              startRowIndex: walletRowIndex,
              endRowIndex: walletRowIndex + 1,
              startColumnIndex: walletColumn,
              endColumnIndex: walletColumn + 1,
            },
            rows: [{ values: [{ userEnteredValue: { numberValue: newBalance } }] }],
            fields: "userEnteredValue",
          },
        },
        {
          updateCells: {
            range: {
              sheetId: ledgerSheetId,
              startRowIndex: ledgerIndex,
              endRowIndex: ledgerIndex + 1,
              startColumnIndex: 5,
              endColumnIndex: 6,
            },
            rows: [{ values: [{ userEnteredValue: { stringValue: "approved" } }] }],
            fields: "userEnteredValue",
          },
        },
      ],
    },
  });

  return {
    id,
    username,
    amount,
    balance: newBalance,
    details,
  };
}

export async function updateWalletTransactionStatus(id, status) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureHeaders(api, spreadsheetId);

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:F`,
  });
  const rows = data.values || [];
  const index = rows.findIndex(
    (row, rowIndex) => rowIndex > 0 && row[0] === id
  );

  if (index === -1) {
    throw new Error("Wallet request was not found in the transaction sheet.");
  }

  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!F${index + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}
