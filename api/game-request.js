import { setCors } from "../lib/http.js";
import { sendGameRequestEmail } from "../lib/wallet-mailer.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLATFORMS = new Set([
  "",
  "PC",
  "PlayStation",
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

  const body = getRequestBody(req);
  if (cleanText(body.website, 200)) {
    return res.status(200).json({ message: "Request received." });
  }

  const gameTitle = cleanText(body.gameTitle, 120).replace(/\s+/g, " ");
  const email = cleanText(body.email, 254).toLowerCase();
  const platform = cleanText(body.platform, 40);
  const details = cleanText(body.details, 1000);
  const username = cleanText(body.username, 30);

  if (!gameTitle || !email) {
    return res.status(400).json({
      error: "Game title and email are required.",
    });
  }

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({
      error: "Enter a valid email address.",
    });
  }

  if (!PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: "Choose a valid platform.",
    });
  }

  try {
    await sendGameRequestEmail({
      gameTitle,
      email,
      platform,
      details,
      username,
    });

    return res.status(200).json({
      message: "Your game request was sent.",
    });
  } catch (error) {
    console.error("Game request email failed:", error.message);
    return res.status(500).json({
      error: "Unable to send your request right now. Please try again later.",
    });
  }
}
