import { google } from "googleapis";
import { randomUUID } from "node:crypto";

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

export async function cancelWalletTopUpRequest({ id, username }) {
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
