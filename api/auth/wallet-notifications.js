import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  getWalletNotifications,
  markAllWalletNotificationsRead,
  markWalletNotificationRead,
} from "../../lib/wallet-notifications.js";

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

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;

  try {
    if (req.method === "GET") {
      const notifications = await getWalletNotifications(username);
      return res.status(200).json({
        notifications,
        unreadCount: notifications.filter(
          (notification) => !notification.readAt
        ).length,
      });
    }

    const { notificationId, markAll } = getRequestBody(req);
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
