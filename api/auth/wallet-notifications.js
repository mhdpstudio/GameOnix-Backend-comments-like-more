import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  deleteAllWalletNotifications,
  deleteWalletNotification,
  getWalletNotifications,
  markAllWalletNotificationsRead,
  markWalletNotificationRead,
} from "../../lib/wallet-notifications.js";
import { getWalletTransactions } from "../../lib/wallet-ledger.js";

function enrichLegacyNotificationDetails(notifications, transactions) {
  return notifications.map((notification) => {
    if (
      notification.details ||
      (!/top.?up/i.test(notification.title) &&
        notification.type !== "top_up_request")
    ) {
      return notification;
    }

    const amountMatch = notification.message.match(
      /EGP\s*([\d,]+(?:\.\d{1,2})?)/i
    );
    const amount = amountMatch
      ? Number(amountMatch[1].replace(/,/g, ""))
      : NaN;
    if (!Number.isFinite(amount)) return notification;

    const methodMatch = notification.message.match(
      /\bvia\s+(.+?)(?:\s+was\b|[.!?]|$)/i
    );
    const paymentMethod = methodMatch?.[1]?.trim();
    const title = notification.title.toLowerCase();
    const terminalStatus = title.includes("approv")
      ? "approved"
      : title.includes("cancel")
        ? "cancelled"
        : null;

    const candidates = transactions.filter((transaction) => {
      if (
        transaction.type !== "top_up_request" ||
        Math.round(transaction.amount * 100) !== Math.round(amount * 100) ||
        (terminalStatus &&
          transaction.status.toLowerCase() !== terminalStatus)
      ) {
        return false;
      }

      try {
        const details = JSON.parse(transaction.description);
        return (
          details &&
          typeof details === "object" &&
          (!paymentMethod ||
            String(details.paymentMethod || "").toLowerCase() ===
              paymentMethod.toLowerCase())
        );
      } catch {
        return false;
      }
    });

    if (candidates.length !== 1) return notification;

    const transaction = candidates[0];
    const details = JSON.parse(transaction.description);
    return {
      ...notification,
      details: {
        requestId: transaction.id,
        amount: transaction.amount,
        email: details.email || "Not provided",
        paymentMethod: details.paymentMethod || "Not provided",
        mobileNumber: details.mobileNumber || "Not provided",
        whatsappNumber: details.whatsappNumber || "Not provided",
        currentBalance: details.currentBalance,
        status: transaction.status.toLowerCase(),
      },
    };
  });
}

function getRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function getNotificationAdmins() {
  return new Set(
    String(process.env.GAMEONIX_NOTIFICATION_ADMIN_USERNAMES || "")
      .split(",")
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean)
  );
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  try {
    if (req.method === "DELETE") {
      const { notificationId, deleteAll } = getRequestBody(req);
      if (deleteAll === true) {
        const deletedCount = await deleteAllWalletNotifications(username);
        return res.status(200).json({ success: true, deletedCount });
      }

      if (typeof notificationId !== "string" || !notificationId.trim()) {
        return res.status(400).json({
          error: "A valid notification ID is required.",
        });
      }

      const deleted = await deleteWalletNotification(
        username,
        notificationId.trim()
      );
      if (!deleted) {
        return res.status(404).json({ error: "Notification was not found." });
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === "GET") {
      let notifications = await getWalletNotifications(username);
      if (
        notifications.some(
          (notification) =>
            !notification.details && /top.?up/i.test(notification.title)
        )
      ) {
        const transactions = await getWalletTransactions(username);
        notifications = enrichLegacyNotificationDetails(
          notifications,
          transactions
        );
      }
      return res.status(200).json({
        notifications,
        canSend: getNotificationAdmins().has(username.toLowerCase()),
        unreadCount: notifications.filter(
          (notification) => !notification.readAt
        ).length,
      });
    }

    const body = getRequestBody(req);
    if (body.action === "send") {
      if (!getNotificationAdmins().has(username.toLowerCase())) {
        return res.status(403).json({ error: "Admin access is required." });
      }

      const recipientUsername =
        typeof body.username === "string" ? body.username.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      const imageData =
        typeof body.imageData === "string" ? body.imageData : "";
      const hasInvalidImageData =
        body.imageData !== undefined &&
        body.imageData !== null &&
        typeof body.imageData !== "string";

      if (
        !recipientUsername ||
        recipientUsername.length > 64 ||
        !/^[a-zA-Z0-9._-]+$/.test(recipientUsername) ||
        !title ||
        title.length > 100 ||
        !message ||
        message.length > 2000 ||
        hasInvalidImageData ||
        (imageData &&
          (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) ||
            imageData.length > 44000))
      ) {
        return res.status(400).json({
          error: "Enter a valid recipient, title, message, and image.",
        });
      }

      const notification = await createWalletNotification({
        username: recipientUsername,
        title,
        message,
        type: "direct_message",
        details: imageData ? { imageData } : null,
      });
      return res.status(201).json({ success: true, notification });
    }

    const { notificationId, markAll } = body;
    if (markAll === true) {
      await markAllWalletNotificationsRead(username);
      return res.status(200).json({ success: true });
    }

    if (typeof notificationId !== "string" || !notificationId.trim()) {
      return res.status(400).json({
        error: "A valid notification ID is required.",
      });
    }

    const result = await markWalletNotificationRead(
      username,
      notificationId.trim()
    );
    if (!result) {
      return res.status(404).json({ error: "Notification was not found." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Wallet notifications request failed:", error);
    return res.status(500).json({
      error: "Unable to load or update your notifications.",
    });
  }
}
