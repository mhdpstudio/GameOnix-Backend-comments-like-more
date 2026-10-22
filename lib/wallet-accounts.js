import { createHmac } from "node:crypto";
import { google } from "googleapis";

const SHEET_TITLE = "Wallet Accounts";
const HEADERS = ["username", "wallet_number"];

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
  return { api: google.sheets({ version: "v4", auth }), spreadsheetId };
}

function createWalletNumber(username) {
  const secret =
    process.env.WALLET_NUMBER_SECRET || process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Wallet number generation is not configured.");
  }
  return BigInt(
    `0x${createHmac("sha256", secret)
      .update(username.toLowerCase())
      .digest("hex")}`
  )
    .toString(36)
    .toUpperCase()
    .slice(0, 32);
}

async function getAccountRows() {
  const { api, spreadsheetId } = getSheetsClient();
  const { data: sheetsData } = await api.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  let sheet = sheetsData.sheets?.find(
    (item) => item.properties?.title === SHEET_TITLE
  );
  if (!sheet) {
    try {
      const created = await api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
        },
      });
      sheet = {
        properties: {
          sheetId: created.data.replies[0].addSheet.properties.sheetId,
        },
      };
    } catch (error) {
      const { data: latest } = await api.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title))",
      });
      sheet = latest.sheets?.find(
        (item) => item.properties?.title === SHEET_TITLE
      );
      if (!sheet) throw error;
    }
  }

  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A1:B`,
  });
  if (!data.values?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_TITLE}'!A1:B1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return { api, spreadsheetId, rows: [HEADERS] };
  }

  const currentHeaders = data.values[0].map((value) =>
    String(value).trim().toLowerCase()
  );
  if (HEADERS.some((header, index) => currentHeaders[index] !== header)) {
    throw new Error(`The ${SHEET_TITLE} sheet has unexpected headers.`);
  }
  return { api, spreadsheetId, rows: data.values };
}

export async function getWalletAccountProfile(username) {
  const context = await getAccountRows();
  const normalizedUsername = username.trim().toLowerCase();
  let row = context.rows.slice(1).find(
    (entry) =>
      String(entry[0] || "").trim().toLowerCase() === normalizedUsername
  );

  if (!row) {
    const walletNumber = createWalletNumber(normalizedUsername);
    await context.api.spreadsheets.values.append({
      spreadsheetId: context.spreadsheetId,
      range: `'${SHEET_TITLE}'!A:B`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[normalizedUsername, walletNumber]] },
    });
    const updatedContext = await getAccountRows();
    row = updatedContext.rows.slice(1).find(
      (entry) =>
        String(entry[0] || "").trim().toLowerCase() === normalizedUsername
    );
  }

  if (!row || typeof row[1] !== "string" || !row[1].trim()) {
    throw new Error("Wallet account could not be created.");
  }
  return { walletNumber: row[1].trim() };
}
