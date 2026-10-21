import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import {
  getWalletRecipientByNumber,
  verifyWalletPin,
} from "../../lib/wallet-accounts.js";
import { createWalletNotification } from "../../lib/wallet-notifications.js";
import { runWalletSheetOperation } from "../../lib/wallet-sheet-operations.js";

const MAX_TRANSFER_AMOUNT = 100000;

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;
  const { walletNumber, amount, pin, transferId } = getRequestBody(req);
  const parsedAmount = Number(amount);
  if (
    typeof walletNumber !== "string" ||
    !/^[A-Z0-9]{32}$/.test(walletNumber) ||
    !Number.isFinite(parsedAmount) ||
    parsedAmount < 1 ||
    parsedAmount > MAX_TRANSFER_AMOUNT ||
    Math.round(parsedAmount * 100) / 100 !== parsedAmount ||
    typeof pin !== "string" ||
    !/^\d{6}$/.test(pin) ||
    typeof transferId !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      transferId
    )
  ) {
    return res.status(400).json({
      error: "Enter a valid wallet number, amount, and 6-digit PIN.",
    });
  }

  try {
    const recipient = await getWalletRecipientByNumber(walletNumber);
    if (!recipient) {
      return res.status(404).json({ error: "GameOnix wallet was not found." });
    }
    if (recipient.username.toLowerCase() === username.toLowerCase()) {
      return res.status(400).json({
        error: "You cannot transfer funds to your own wallet.",
      });
    }

    const sender = await verifyWalletPin(username, pin);
    const result = await runWalletSheetOperation({
      action: "transfer",
      transferId,
      senderUsername: username,
      senderWalletNumber: sender.walletNumber,
      recipientUsername: recipient.username,
      recipientWalletNumber: walletNumber,
      amount: parsedAmount,
    });

    if (!result.replayed) {
      const messageToSender = `You sent EGP ${parsedAmount.toFixed(2)} to ${recipient.displayName}.`;
      const messageToRecipient = `You received EGP ${parsedAmount.toFixed(2)} from ${username}.`;
      const notifications = await Promise.allSettled([
        createWalletNotification({
          username,
          title: "Wallet transfer sent",
          message: messageToSender,
          type: "wallet_transfer",
          details: {
            transferId,
            amount: parsedAmount,
            recipient: recipient.displayName,
            status: "completed",
          },
        }),
        createWalletNotification({
          username: recipient.username,
          title: "Wallet transfer received",
          message: messageToRecipient,
          type: "wallet_transfer",
          details: {
            transferId,
            amount: parsedAmount,
            sender: username,
            status: "completed",
          },
        }),
      ]);
      notifications.forEach((notification, index) => {
        if (notification.status === "rejected") {
          console.error(
            `Wallet transfer notification ${index + 1} failed:`,
            notification.reason
          );
        }
      });
    }

    return res.status(200).json({
      success: true,
      transferId,
      balance: result.senderBalance,
      recipient: recipient.displayName,
    });
  } catch (error) {
    console.error("Wallet transfer failed:", error);
    const statusCode =
      error.code === "INSUFFICIENT_FUNDS"
        ? 409
        : error.code === "WALLET_OPERATION_NOT_CONFIGURED" ||
            error.code === "WALLET_BUSY"
          ? 503
          : error.message?.includes("PIN attempts")
            ? 429
            : error.message?.includes("PIN")
              ? 400
          : 500;
    return res.status(statusCode).json({
      error:
        error.code === "INSUFFICIENT_FUNDS"
          ? "Your wallet balance is not enough for this transfer."
          : error.message || "Unable to complete this wallet transfer.",
    });
  }
}
