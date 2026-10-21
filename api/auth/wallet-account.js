import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  getWalletAccountProfile,
  getWalletRecipientByNumber,
  resetWalletPin,
  sendWalletPinResetCode,
  setWalletPin,
} from "../../lib/wallet-accounts.js";

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
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;

  try {
    if (req.method === "GET") {
      return res.status(200).json(await getWalletAccountProfile(username));
    }

    const { action, pin, code, walletNumber } = getRequestBody(req);
    if (action === "lookup-recipient") {
      const recipient = await getWalletRecipientByNumber(walletNumber);
      if (!recipient || recipient.username.toLowerCase() === username.toLowerCase()) {
        return res.status(404).json({
          error: "Another GameOnix wallet with this number was not found.",
        });
      }
      return res.status(200).json({ displayName: recipient.displayName });
    }
    if (action === "set-pin") {
      await setWalletPin(username, pin);
      return res.status(200).json({ success: true });
    }
    if (action === "request-pin-reset") {
      await sendWalletPinResetCode(username);
      return res.status(200).json({ success: true });
    }
    if (action === "reset-pin") {
      await resetWalletPin(username, code, pin);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "Choose a valid wallet action." });
  } catch (error) {
    console.error("Wallet account request failed:", error);
    const statusCode =
      error.message?.includes("already set") ||
      error.message?.includes("Wait one minute") ||
      error.message?.includes("incorrect") ||
      error.message?.includes("expired") ||
      error.message?.includes("Too many") ||
      error.message?.includes("exactly 6 digits")
        ? 400
        : 500;
    return res.status(statusCode).json({
      error: error.message || "Unable to update your wallet account.",
    });
  }
}
