import { randomUUID } from "node:crypto";
import { google } from "googleapis";

const SHEET_TITLE = "Wallet Notifications";
const HEADERS = [
  "notification_id",
  "username",
  "title",
  "message",
  "type",
  "read_at",
  "created_at",
  "details_json",
];
const LEGACY_HEADERS = HEADERS.slice(0, -1);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

async function getNotificationSheet(api, spreadsheetId) {
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

async function ensureNotificationSheet(api, spreadsheetId) {
  const sheetId = await getNotificationSheet(api, spreadsheetId);
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A1:H1`,
  });

  if (!data.values?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_TITLE}'!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return sheetId;
  }

  const headers = data.values[0].map((value) =>
    String(value).trim().toLowerCase()
  );
  if (LEGACY_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error(`The ${SHEET_TITLE} sheet has unexpected headers.`);
  }

  if (!headers[HEADERS.length - 1]) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_TITLE}'!H1`,
      valueInputOption: "RAW",
      requestBody: { values: [[HEADERS[HEADERS.length - 1]]] },
    });
  } else if (headers[HEADERS.length - 1] !== HEADERS[HEADERS.length - 1]) {
    throw new Error(`The ${SHEET_TITLE} sheet has unexpected headers.`);
  }

  return sheetId;
}

async function readNotificationRows(api, spreadsheetId) {
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:H`,
  });
  return data.values || [];
}

async function deleteExpiredNotifications(api, spreadsheetId, sheetId, rows) {
  const cutoff = Date.now() - RETENTION_MS;
  const expiredIndexes = [];

  rows.slice(1).forEach((row, index) => {
    const createdAt = Date.parse(String(row[6] || ""));
    if (!Number.isFinite(createdAt) || createdAt <= cutoff) {
      expiredIndexes.push(index + 1);
    }
  });

  if (!expiredIndexes.length) return;

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: expiredIndexes
        .reverse()
        .map((rowIndex) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        })),
    },
  });
}

export async function createWalletNotification({
  username,
  title,
  message,
  type = "wallet",
  details = null,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureNotificationSheet(api, spreadsheetId);

  const notification = {
    id: randomUUID(),
    username,
    title,
    message,
    type,
    details,
    readAt: "",
    createdAt: new Date().toISOString(),
  };

  await api.spreadsheets.values.append({
    spreadsheetId,
    range: `'${SHEET_TITLE}'!A:H`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        notification.id,
        notification.username,
        notification.title,
        notification.message,
        notification.type,
        notification.readAt,
        notification.createdAt,
        notification.details ? JSON.stringify(notification.details) : "",
      ]],
    },
  });

  return notification;
}

export async function updatePendingWalletRequestNotification({
  username,
  requestId,
  title,
  message,
  details,
}) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureNotificationSheet(api, spreadsheetId);
  const rows = await readNotificationRows(api, spreadsheetId);
  const rowIndex = rows.findIndex((row, index) => {
    if (
      index === 0 ||
      String(row[1] || "").trim().toLowerCase() !== username.toLowerCase() ||
      String(row[4] || "") !== "top_up_request"
    ) {
      return false;
    }

    try {
      const existingDetails = row[7] ? JSON.parse(String(row[7])) : null;
      return (
        existingDetails?.requestId === requestId &&
        existingDetails?.status === "pending"
      );
    } catch (error) {
      console.error("Wallet notification details are invalid:", error);
      return false;
    }
  });

  if (rowIndex === -1) return false;

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: `'${SHEET_TITLE}'!C${rowIndex + 1}:D${rowIndex + 1}`,
          values: [[title, message]],
        },
        {
          range: `'${SHEET_TITLE}'!H${rowIndex + 1}`,
          values: [[JSON.stringify(details)]],
        },
      ],
    },
  });

  return true;
}

export async function getWalletNotifications(username) {
  const { api, spreadsheetId } = getSheetsClient();
  const sheetId = await ensureNotificationSheet(api, spreadsheetId);
  const rows = await readNotificationRows(api, spreadsheetId);
  await deleteExpiredNotifications(api, spreadsheetId, sheetId, rows);

  return rows
    .slice(1)
    .filter(
      (row) => {
        const createdAt = Date.parse(String(row[6] || ""));
        return (
          String(row[1] || "").trim().toLowerCase() === username.toLowerCase() &&
          Number.isFinite(createdAt) &&
          createdAt > Date.now() - RETENTION_MS
        );
      }
    )
    .map((row) => {
      let details = null;
      try {
        details = row[7] ? JSON.parse(String(row[7])) : null;
      } catch {
        console.error("Wallet notification details are invalid.");
      }

      return {
        id: String(row[0] || ""),
        title: String(row[2] || ""),
        message: String(row[3] || ""),
        type: String(row[4] || "wallet"),
        details:
          details && typeof details === "object" && !Array.isArray(details)
            ? details
            : null,
        readAt: String(row[5] || ""),
        createdAt: String(row[6] || ""),
      };
    })
    .reverse();
}

async function setNotificationsReadAt(username, notificationId) {
  const { api, spreadsheetId } = getSheetsClient();
  await ensureNotificationSheet(api, spreadsheetId);
  const rows = await readNotificationRows(api, spreadsheetId);
  const matchingIndexes = rows
    .slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(
      ({ row }) =>
        String(row[1] || "").trim().toLowerCase() === username.toLowerCase() &&
        (!notificationId || String(row[0] || "") === notificationId) &&
        !String(row[5] || "").trim()
    );

  if (notificationId && !matchingIndexes.length) {
    const existsForUser = rows.some(
      (row, index) =>
        index > 0 &&
        String(row[0] || "") === notificationId &&
        String(row[1] || "").trim().toLowerCase() === username.toLowerCase()
    );
    return existsForUser ? true : null;
  }

  if (!matchingIndexes.length) return true;

  const readAt = new Date().toISOString();
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: matchingIndexes.map(({ rowNumber }) => ({
        range: `'${SHEET_TITLE}'!F${rowNumber}`,
        values: [[readAt]],
      })),
    },
  });

  return true;
}

export function markWalletNotificationRead(username, notificationId) {
  return setNotificationsReadAt(username, notificationId);
}

export function markAllWalletNotificationsRead(username) {
  return setNotificationsReadAt(username, "");
}

export async function deleteWalletNotification(username, notificationId) {
  const { api, spreadsheetId } = getSheetsClient();
  const sheetId = await ensureNotificationSheet(api, spreadsheetId);
  const rows = await readNotificationRows(api, spreadsheetId);
  const rowIndex = rows.findIndex(
    (row, index) =>
      index > 0 &&
      String(row[0] || "") === notificationId &&
      String(row[1] || "").trim().toLowerCase() === username.toLowerCase()
  );

  if (rowIndex === -1) return false;

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    },
  });

  return true;
}

export async function deleteAllWalletNotifications(username) {
  const { api, spreadsheetId } = getSheetsClient();
  const sheetId = await ensureNotificationSheet(api, spreadsheetId);
  const rows = await readNotificationRows(api, spreadsheetId);
  const rowIndexes = rows
    .slice(1)
    .map((row, index) => ({ row, rowIndex: index + 1 }))
    .filter(
      ({ row }) =>
        String(row[1] || "").trim().toLowerCase() === username.toLowerCase()
    )
    .map(({ rowIndex }) => rowIndex)
    .reverse();

  if (!rowIndexes.length) return 0;

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: rowIndexes.map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      })),
    },
  });

  return rowIndexes.length;
}
