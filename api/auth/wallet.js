import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import { getWalletBalanceByUsername } from "../../lib/sheets.js";
import {
  createWalletTopUpRequest,
  getWalletTransactions,
  updateWalletTransactionStatus,
} from "../../lib/wallet-ledger.js";
import { sendWalletTopUpRequestEmail } from "../../lib/wallet-mailer.js";

const PAYMENTS_URL =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-Content/main/payments.json";
const MAX_TOP_UP_AMOUNT = 100000;

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

  if (req.method === "POST") {
    const { amount, paymentMethod, mobileNumber, whatsappNumber } =
      getRequestBody(req);
    const parsedAmount = Number(amount);

    if (
      !Number.isFinite(parsedAmount) ||
      parsedAmount < 1 ||
      parsedAmount > MAX_TOP_UP_AMOUNT ||
      Math.round(parsedAmount * 100) / 100 !== parsedAmount
    ) {
      return res.status(400).json({
        error: `Enter an amount between 1 and ${MAX_TOP_UP_AMOUNT} EGP.`,
      });
    }

    if (
      typeof paymentMethod !== "string" ||
      !paymentMethod.trim() ||
      paymentMethod.length > 80
    ) {
      return res.status(400).json({ error: "Choose a valid payment method." });
    }

    if (
      mobileNumber !== undefined &&
      (typeof mobileNumber !== "string" || mobileNumber.trim().length > 30)
    ) {
      return res.status(400).json({ error: "Enter a valid mobile number." });
    }

    if (
      typeof whatsappNumber !== "string" ||
      !/^[+\d][\d\s()-]{5,28}$/.test(whatsappNumber.trim())
    ) {
      return res.status(400).json({ error: "Enter a valid WhatsApp number." });
    }

    try {
      const account = await getWalletBalanceByUsername(username);
      if (!account) {
        return res.status(404).json({ error: "Wallet account was not found." });
      }
      if (!account.email) {
        return res.status(409).json({
          error: "Add an email address to your account before requesting a top-up.",
        });
      }

      const paymentsResponse = await fetch(PAYMENTS_URL, { cache: "no-store" });

      if (!paymentsResponse.ok) {
        throw new Error(`Payment methods request failed (${paymentsResponse.status})`);
      }

      const paymentMethods = await paymentsResponse.json();
      const method = Array.isArray(paymentMethods)
        ? paymentMethods.find(
            (item) =>
              item?.name === paymentMethod.trim() && item.av === true
          )
        : null;

      if (!method) {
        return res.status(400).json({
          error: "That payment method is unavailable. Refresh and choose another.",
        });
      }

      const normalizedMobileNumber =
        method["mobile-number"] && typeof mobileNumber === "string"
          ? mobileNumber.trim()
          : "";

      if (method["mobile-number"] && !normalizedMobileNumber) {
        return res.status(400).json({ error: "Enter a mobile number." });
      }

      if (
        method["mobile-number"] &&
        !/^[+\d][\d\s()-]{5,28}$/.test(normalizedMobileNumber)
      ) {
        return res.status(400).json({ error: "Enter a valid mobile number." });
      }

      const requestId = await createWalletTopUpRequest({
        username,
        email: account.email,
        currentBalance: account.balance,
        amount: parsedAmount,
        paymentMethod: method.name,
        mobileNumber: normalizedMobileNumber || "Not required",
        whatsappNumber: whatsappNumber.trim(),
      });

      try {
        await sendWalletTopUpRequestEmail({
          requestId,
          username,
          email: account.email,
          currentBalance: account.balance,
          amount: parsedAmount,
          paymentMethod: method.name,
          mobileNumber: normalizedMobileNumber || "Not required",
          whatsappNumber: whatsappNumber.trim(),
        });
      } catch (emailError) {
        try {
          await updateWalletTransactionStatus(requestId, "notification_failed");
        } catch (statusError) {
          console.error("Wallet request status update failed:", statusError);
        }
        throw emailError;
      }

      return res.status(202).json({
        message:
          "Your top-up request was sent to the admin. Your wallet balance will change only after review.",
        requestId,
      });
    } catch (error) {
      console.error("Wallet top-up request failed:", error);
      return res.status(500).json({
        error: "Unable to send your top-up request. Please try again later.",
      });
    }
  }

  try {
    const account = await getWalletBalanceByUsername(username);

    if (!account) {
      return res.status(404).json({ error: "Wallet account was not found." });
    }

    const transactions = await getWalletTransactions(username);
    return res.status(200).json({
      balance: account.balance,
      email: account.email,
      transactions,
    });
  } catch (error) {
    console.error("Wallet lookup failed:", error);
    return res.status(500).json({ error: "Unable to load wallet balance." });
  }
}
