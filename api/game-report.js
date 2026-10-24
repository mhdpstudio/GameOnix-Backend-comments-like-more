import jwt from "jsonwebtoken";
import { requireUser } from "../lib/auth.js";
import { setCors } from "../lib/http.js";
import { getWalletBalanceByUsername } from "../lib/sheets.js";
import {
  createWalletNotification,
  deleteWalletNotification,
} from "../lib/wallet-notifications.js";
import { sendGameBugReportEmail } from "../lib/wallet-mailer.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function cleanGameContext(value) {
  const game = value && typeof value === "object" ? value : {};
  const slug = cleanText(game.slug, 120).toLowerCase();
  const title = cleanText(game.title, 120).replace(/\s+/g, " ");
  if (!title || !slug) {
    return null;
  }

  return {
    slug,
    title,
    version: cleanText(game.version, 80),
    platform: cleanText(game.platform, 60),
    gameType: cleanText(game.gameType, 80),
    publisher: cleanText(game.publisher, 120),
    size: cleanText(game.size, 40),
    fileType: cleanText(game.fileType, 40),
  };
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
    return res.status(200).json({ message: "Report received." });
  }
  const game = cleanGameContext(body.game);
  const description = cleanText(body.description, 1500);
  if (!game) {
    return res.status(400).json({ error: "A valid game is required." });
  }
  if (description.length < 10) {
    return res.status(400).json({
      error: "Please describe the issue in at least 10 characters.",
    });
  }

  let notification;
  try {
    const account = await getWalletBalanceByUsername(username);
    const email = cleanText(account?.email, 254).toLowerCase();
    if (!email || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({
        error: "Add a valid email address to your account before reporting an issue.",
      });
    }

    const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("Game report replies are not configured.");
    }

    notification = await createWalletNotification({
      username,
      title: "Game report received",
      message: `Your report about ${game.title} was sent to the GameOnix team.`,
      type: "bug_report",
      details: {
        gameTitle: game.title,
        gameName: game.title,
        slug: game.slug,
        version: game.version,
        platform: game.platform,
        gameType: game.gameType,
        publisher: game.publisher,
        size: game.size,
        fileType: game.fileType,
        description,
      },
    });

    const replyToken = jwt.sign(
      {
        purpose: "game-bug-report-reply",
        notificationId: notification.id,
        username,
        email,
        gameTitle: game.title,
        slug: game.slug,
        platform: game.platform,
      },
      secret,
      {
        algorithm: "HS256",
        expiresIn: "30d",
        issuer: "gameonix-community-api",
        audience: "gameonix-game-report-reply",
      }
    );

    await sendGameBugReportEmail({
      username,
      email,
      game,
      description,
      replyUrl: `https://gameonixfav.vercel.app/api/game-report-reply?token=${encodeURIComponent(replyToken)}`,
    });

    return res.status(200).json({
      message: "Your report was sent to the GameOnix team.",
    });
  } catch (error) {
    console.error("Game bug report delivery failed:", error);
    if (notification) {
      try {
        await deleteWalletNotification(username, notification.id);
      } catch (cleanupError) {
        console.error("Failed to remove undelivered game report notification:", cleanupError);
      }
    }
    return res.status(500).json({
      error: "Unable to send your report right now. Please try again later.",
    });
  }
}
