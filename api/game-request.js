import jwt from "jsonwebtoken";
import { requireUser } from "../lib/auth.js";
import { setCors } from "../lib/http.js";
import { getWalletBalanceByUsername } from "../lib/sheets.js";
import {
  createWalletNotification,
  deleteWalletNotification,
} from "../lib/wallet-notifications.js";
import { sendGameRequestEmail } from "../lib/wallet-mailer.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLATFORMS = new Set([
  "PC",
  "PS Family",
  "Xbox",
  "Nintendo Switch",
  "Mobile",
  "Other",
]);

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
    return res.status(200).json({ message: "Request received." });
  }

  const gameTitle = cleanText(body.gameTitle, 120).replace(/\s+/g, " ");
  const platform = cleanText(body.platform, 40);
  const details = cleanText(body.details, 1000);

  if (!gameTitle) {
    return res.status(400).json({
      error: "A game title is required.",
    });
  }

  if (!platform || !PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: "Choose a valid platform.",
    });
  }

  let notification;
  try {
    const account = await getWalletBalanceByUsername(username);
    const email = cleanText(account?.email, 254).toLowerCase();
    if (!email || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({
        error: "Add and verify an email address on your account before requesting a game.",
      });
    }

    const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("Game request replies are not configured.");
    }

    notification = await createWalletNotification({
      username,
      title: "Game request received",
      message: `Your request for ${gameTitle} (${platform}) was sent to the GameOnix team.`,
      type: "game_request",
      details: {
        gameTitle,
        platform,
      },
    });

    const replyToken = jwt.sign(
      {
        purpose: "game-request-reply",
        notificationId: notification.id,
        username,
        email,
        gameTitle,
        platform,
      },
      secret,
      {
        algorithm: "HS256",
        expiresIn: "30d",
        issuer: "gameonix-community-api",
        audience: "gameonix-game-request-reply",
      }
    );

    await sendGameRequestEmail({
      gameTitle,
      email,
      platform,
      details,
      username,
      replyUrl: `https://gameonixfav.vercel.app/api/game-request-reply?token=${encodeURIComponent(replyToken)}`,
    });

    return res.status(200).json({
      message: "Your game request was sent.",
    });
  } catch (error) {
    console.error("Game request email failed:", error.message);
    if (notification) {
      try {
        await deleteWalletNotification(username, notification.id);
      } catch (cleanupError) {
        console.error(
          "Failed to clean up game request notification:",
          cleanupError
        );
      }
    }
    return res.status(500).json({
      error: "Unable to send your request right now. Please try again later.",
    });
  }
}
