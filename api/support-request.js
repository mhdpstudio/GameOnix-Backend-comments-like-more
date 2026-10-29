import jwt from "jsonwebtoken";
import { requireUser } from "../lib/auth.js";
import { setCors } from "../lib/http.js";
import { getWalletBalanceByUsername } from "../lib/sheets.js";
import {
  createWalletNotification,
  deleteWalletNotification,
} from "../lib/wallet-notifications.js";
import { sendSupportRequestEmail } from "../lib/wallet-mailer.js";

const TOPIC_LABELS = {
  order: "Order or purchase",
  "gift-card": "Gift card code",
  wallet: "Wallet top-up",
  account: "Account access",
  other: "Something else",
};

const MAX_MESSAGE_LENGTH = 1500;
const MIN_MESSAGE_LENGTH = 10;

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

function cleanText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim().slice(0, maxLength)
    : "";
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;

  const body = getRequestBody(req);
  if (cleanText(body.website, 200)) {
    return res.status(200).json({ message: "Message received." });
  }

  const topic = cleanText(body.topic, 40);
  const orderId = cleanText(body.orderId, 60);
  const message = cleanText(body.message, MAX_MESSAGE_LENGTH);

  if (!Object.hasOwn(TOPIC_LABELS, topic)) {
    return res.status(400).json({ error: "Choose a valid topic." });
  }

  if (message.length < MIN_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Add at least ${MIN_MESSAGE_LENGTH} characters so we can help.`,
    });
  }

  const topicLabel = TOPIC_LABELS[topic];
  let notification;

  try {
    const account = await getWalletBalanceByUsername(username);
    const email = cleanText(account?.email, 254).toLowerCase();

    if (!email) {
      return res.status(400).json({
        error:
          "Add and verify an email address on your account before contacting support.",
      });
    }

    const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("Support replies are not configured.");
    }

    notification = await createWalletNotification({
      username,
      title: "Support message received",
      message: `Your ${TOPIC_LABELS[topic]} message was sent to the GameOnix team.${
        orderId ? ` Order ID ${orderId.slice(0, 8)}.` : ""
      }`,
      type: "support_request",
      details: {
        topic,
        topicLabel,
        orderId,
        email,
      },
    });

    const replyToken = jwt.sign(
      {
        purpose: "support-request-reply",
        notificationId: notification.id,
        username,
        email,
        topic,
        topicLabel,
        orderId,
        messagePreview: message.slice(0, 300),
      },
      secret,
      {
        algorithm: "HS256",
        expiresIn: "30d",
        issuer: "gameonix-community-api",
        audience: "gameonix-support-reply",
      }
    );

    await sendSupportRequestEmail({
      topic: topicLabel,
      orderId,
      message,
      username,
      email,
      replyUrl: `https://gameonixfav.vercel.app/api/support-request-reply?token=${encodeURIComponent(replyToken)}`,
    });

    return res.status(200).json({
      message: "Your message was sent to the GameOnix support team.",
    });
  } catch (error) {
    console.error("Support message failed:", error.message);

    if (notification) {
      try {
        await deleteWalletNotification(username, notification.id);
      } catch (cleanupError) {
        console.error(
          "Failed to clean up support notification:",
          cleanupError
        );
      }
    }

    return res.status(500).json({
      error: "Unable to send your message right now. Please try again later.",
    });
  }
}
