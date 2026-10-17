
import { google } from "googleapis";

const HEADERS = [
  "username",
  "password_hash",
  "email",
  "name",
  "created_at",
  "comments",
  "likes",
  "favorites",
  "theme",
  "avatar",
  "status",
  "verification_code_hash",
  "verification_expires_at",
  "pending_expires_at",
  "reset_password_code_hash",
  "reset_password_expires_at",
  "reset_password_attempts",
  "pending_email",
  "email_change_code_hash",
  "email_change_expires_at",
];

let sheetsClient;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

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

  sheetsClient = {
    api: google.sheets({ version: "v4", auth }),
    spreadsheetId,
  };

  return sheetsClient;
}

function getSheetName() {
  return process.env.GOOGLE_SHEET_NAME || "Sheet1";
}

function getRange() {
  const sheetName = getSheetName().replace(/'/g, "''");
  return `'${sheetName}'!A:T`;
}

async function readRows() {
  const { api, spreadsheetId } = getSheetsClient();

  const result = await api.spreadsheets.values.get({
    spreadsheetId,
    range: getRange(),
  });

  const rows = result.data.values || [];
  if (!rows.length) {
    throw new Error("The Google Sheet is empty; expected a header row.");
  }

  const headers = rows[0].map((header) => String(header).trim());
  const usernameColumn = headers.indexOf("username");
  const favoritesColumn = headers.indexOf("favorites");

  if (usernameColumn === -1 || favoritesColumn === -1) {
    throw new Error("The sheet must contain username and favorites headers.");
  }

  return { rows, usernameColumn, favoritesColumn };
}

function parseFavorites(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((slug) => typeof slug === "string"))]
      : [];
  } catch {
    return [];
  }
}

export async function getFavoritesByUsername(username) {
  const { rows, usernameColumn, favoritesColumn } = await readRows();

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").toLowerCase() === username.toLowerCase()
  );

  if (rowIndex === -1) return null;

  return {
    rowNumber: rowIndex + 1,
    favorites: parseFavorites(rows[rowIndex][favoritesColumn]),
  };
}

export async function saveFavoritesByUsername(username, favorites) {
  const { api, spreadsheetId } = getSheetsClient();
  const { rows, usernameColumn, favoritesColumn } = await readRows();

  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[usernameColumn] || "").toLowerCase() === username.toLowerCase()
  );

  if (rowIndex === -1) return false;

  const columnLetter = columnToLetter(favoritesColumn + 1);
  const sheetName = getSheetName().replace(/'/g, "''");
  const range = `'${sheetName}'!${columnLetter}${rowIndex + 1}`;

  await api.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [ [JSON.stringify([...new Set(favorites)])] ],
    },
  });

  return true;
}

function columnToLetter(column) {
  let result = "";

  while (column > 0) {
    const remainder = (column - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    column = Math.floor((column - 1) / 26);
  }

  return result;
}
