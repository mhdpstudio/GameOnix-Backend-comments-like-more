import {
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { google } from "googleapis";
import nodemailer from "nodemailer";
import { getWalletBalanceByUsername } from "./sheets.js";

const SHEET_TITLE = "Wallet Accounts";
const HEADERS = [
  "username",
  "wallet_number",
  "pin_salt",
  "pin_hash",
  "pin_failed_attempts",
  "pin_locked_until",
  "reset_code_hash",
  "reset_expires_at",
  "reset_attempts",
  "reset_last_sent_at",
];
const PIN_LOCK_MS = 15 * 60 * 1000;
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_RESEND_DELAY_MS = 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const MAX_RESET_ATTEMPTS = 5;

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
  const hash = createHmac("sha256", secret)
    .update(username.toLowerCase())
    .digest("hex");
  return BigInt(`0x${hash}`).toString(36).toUpperCase().slice(0, 32);
}

function hashPin(pin, salt) {
  return scryptSync(pin, salt, 64).toString("hex");
}

function parseRow(row, index) {
  return {
    rowNumber: index + 2,
    username: String(row[0] || "").trim(),
    walletNumber: String(row[1] || "").trim(),
    pinSalt: String(row[2] || ""),
    pinHash: String(row[3] || ""),
    pinFailedAttempts: Number(row[4]) || 0,
    pinLockedUntil: Date.parse(String(row[5] || "")) || 0,
    resetCodeHash: String(row[6] || ""),
    resetExpiresAt: Date.parse(String(row[7] || "")) || 0,
    resetAttempts: Number(row[8]) || 0,
    resetLastSentAt: Date.parse(String(row[9] || "")) || 0,
  };
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
    range: `'${SHEET_TITLE}'!A1:J`,
  });
  if (!data.values?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_TITLE}'!A1:J1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return { api, spreadsheetId, sheetId: sheet.properties.sheetId, rows: [HEADERS] };
  }
  const currentHeaders = data.values[0].map((value) =>
    String(value).trim().toLowerCase()
  );
  if (HEADERS.some((header, index) => currentHeaders[index] !== header)) {
    throw new Error(`The ${SHEET_TITLE} sheet has unexpected headers.`);
  }
  return {
    api,
    spreadsheetId,
    sheetId: sheet.properties.sheetId,
    rows: data.values,
  };
}

async function findOrCreateAccount(username) {
  const context = await getAccountRows();
  const normalizedUsername = username.trim().toLowerCase();
  let index = context.rows.findIndex(
    (row, rowIndex) =>
      rowIndex > 0 &&
      String(row[0] || "").trim().toLowerCase() === normalizedUsername
  );
  if (index === -1) {
    const walletNumber = createWalletNumber(normalizedUsername);
    await context.api.spreadsheets.values.append({
      spreadsheetId: context.spreadsheetId,
      range: `'${SHEET_TITLE}'!A:J`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[normalizedUsername, walletNumber, "", "", 0, "", "", "", 0, ""]],
      },
    });
    context.rows = await getAccountRows().then((result) => result.rows);
    index = context.rows.findIndex(
      (row, rowIndex) =>
        rowIndex > 0 &&
        String(row[0] || "").trim().toLowerCase() === normalizedUsername
    );
  }
  if (index === -1) throw new Error("Wallet account could not be created.");
  return { ...context, account: parseRow(context.rows[index], index - 1) };
}

async function updateAccountRow(context, account, updates) {
  const values = [
    account.username,
    account.walletNumber,
    account.pinSalt,
    account.pinHash,
    account.pinFailedAttempts,
    account.pinLockedUntil ? new Date(account.pinLockedUntil).toISOString() : "",
    account.resetCodeHash,
    account.resetExpiresAt ? new Date(account.resetExpiresAt).toISOString() : "",
    account.resetAttempts,
    account.resetLastSentAt ? new Date(account.resetLastSentAt).toISOString() : "",
  ];
  for (const [key, value] of Object.entries(updates)) {
    const index = {
      username: 0,
      walletNumber: 1,
      pinSalt: 2,
      pinHash: 3,
      pinFailedAttempts: 4,
      pinLockedUntil: 5,
      resetCodeHash: 6,
      resetExpiresAt: 7,
      resetAttempts: 8,
      resetLastSentAt: 9,
    }[key];
    values[index] =
      key === "pinLockedUntil" || key === "resetExpiresAt" || key === "resetLastSentAt"
        ? value
          ? new Date(value).toISOString()
          : ""
        : value;
  }
  await context.api.spreadsheets.values.update({
    spreadsheetId: context.spreadsheetId,
    range: `'${SHEET_TITLE}'!A${account.rowNumber}:J${account.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

export async function getWalletAccountProfile(username) {
  const { account } = await findOrCreateAccount(username);
  return {
    walletNumber: account.walletNumber,
    pinConfigured: Boolean(account.pinHash),
  };
}

export async function getWalletRecipientByNumber(walletNumber) {
  if (typeof walletNumber !== "string" || !/^[A-Z0-9]{32}$/.test(walletNumber)) {
    return null;
  }
  const context = await getAccountRows();
  const account = context.rows
    .slice(1)
    .map(parseRow)
    .find((row) => row.walletNumber === walletNumber);
  if (!account) return null;
  const identity = await getWalletBalanceByUsername(account.username);
  if (!identity) return null;
  return {
    username: account.username,
    displayName: String(identity.name || account.username).split(/\s+/)[0],
  };
}

export async function setWalletPin(username, pin) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new Error("Your transaction PIN must contain exactly 6 digits.");
  }
  const context = await findOrCreateAccount(username);
  if (context.account.pinHash) {
    throw new Error("A transaction PIN is already set.");
  }
  const salt = randomBytes(16).toString("hex");
  await updateAccountRow(context, context.account, {
    pinSalt: salt,
    pinHash: hashPin(pin, salt),
    pinFailedAttempts: 0,
    pinLockedUntil: "",
  });
}

export async function verifyWalletPin(username, pin) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new Error("Enter a valid 6-digit transaction PIN.");
  }
  const context = await findOrCreateAccount(username);
  const account = context.account;
  if (!account.pinHash) {
    throw new Error("Set up your transaction PIN before transferring funds.");
  }
  if (account.pinLockedUntil > Date.now()) {
    throw new Error("Too many incorrect PIN attempts. Try again later.");
  }
  const expected = Buffer.from(account.pinHash, "hex");
  const actual = Buffer.from(hashPin(pin, account.pinSalt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = account.pinFailedAttempts + 1;
    await updateAccountRow(context, account, {
      pinFailedAttempts: attempts >= MAX_PIN_ATTEMPTS ? 0 : attempts,
      pinLockedUntil:
        attempts >= MAX_PIN_ATTEMPTS ? Date.now() + PIN_LOCK_MS : "",
    });
    throw new Error(
      attempts >= MAX_PIN_ATTEMPTS
        ? "Too many incorrect PIN attempts. Try again in 15 minutes."
        : "The transaction PIN is incorrect."
    );
  }
  if (account.pinFailedAttempts || account.pinLockedUntil) {
    await updateAccountRow(context, account, {
      pinFailedAttempts: 0,
      pinLockedUntil: "",
    });
  }
  return { walletNumber: account.walletNumber };
}

export async function sendWalletPinResetCode(username) {
  const context = await findOrCreateAccount(username);
  const account = context.account;
  const identity = await getWalletBalanceByUsername(username);
  const email = identity?.email;
  if (!email) throw new Error("No verified email is available for this account.");
  if (Date.now() - account.resetLastSentAt < RESET_RESEND_DELAY_MS) {
    throw new Error("Wait one minute before requesting another reset code.");
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error("Wallet email is not configured.");
  }
  const code = String(randomInt(100000, 1000000));
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret) throw new Error("Wallet PIN reset is not configured.");
  const resetCodeHash = createHmac("sha256", secret)
    .update(code)
    .digest("hex");
  await updateAccountRow(context, account, {
    resetCodeHash,
    resetExpiresAt: Date.now() + RESET_CODE_TTL_MS,
    resetAttempts: 0,
    resetLastSentAt: Date.now(),
  });

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from: `"GameOnix Wallet" <${smtpUser}>`,
    to: email,
    subject: "Reset your GameOnix transaction PIN",
    text: `Your GameOnix transaction PIN reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
  });
}

export async function resetWalletPin(username, code, pin) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new Error("Enter the 6-digit reset code.");
  }
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new Error("Your transaction PIN must contain exactly 6 digits.");
  }
  const context = await findOrCreateAccount(username);
  const account = context.account;
  if (!account.resetCodeHash || account.resetExpiresAt <= Date.now()) {
    throw new Error("The reset code is invalid or expired.");
  }
  if (account.resetAttempts >= MAX_RESET_ATTEMPTS) {
    throw new Error("Too many incorrect reset codes. Request a new code.");
  }
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret) throw new Error("Wallet PIN reset is not configured.");
  const codeHash = createHmac("sha256", secret).update(code).digest("hex");
  if (codeHash !== account.resetCodeHash) {
    await updateAccountRow(context, account, {
      resetAttempts: account.resetAttempts + 1,
    });
    throw new Error("The reset code is incorrect.");
  }
  const salt = randomBytes(16).toString("hex");
  await updateAccountRow(context, account, {
    pinSalt: salt,
    pinHash: hashPin(pin, salt),
    pinFailedAttempts: 0,
    pinLockedUntil: "",
    resetCodeHash: "",
    resetExpiresAt: "",
    resetAttempts: 0,
  });
}
