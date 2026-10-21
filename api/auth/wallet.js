import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import { getWalletBalanceByUsername } from "../../lib/sheets.js";
import {
  createWalletTopUpRequest,
  cancelWalletTopUpRequest,
  getWalletTransactions,
  updateWalletTopUpRequest,
  updateWalletTransactionStatus,
} from "../../lib/wallet-ledger.js";
import {
  sendWalletTopUpRequestEmail,
  sendWalletTopUpCancellationEmail,
  sendWalletTopUpUpdateEmail,
  sendWalletTopUpUserStatusEmail,
} from "../../lib/wallet-mailer.js";
import {
  createWalletNotification,
  updatePendingWalletRequestNotification,
} from "../../lib/wallet-notifications.js";

const PAYMENTS_URL =
  "https://raw.githubusercontent.com/mhdpstudio/GameOnix-Data-Content/main/payments.json";
const MAX_TOP_UP_AMOUNT = 100000;

async function tryCreateWalletNotification(notification) {
  try {
    await createWalletNotification(notification);
    return true;
  } catch (error) {
    console.error("Wallet notification creation failed:", error);
    return false;
  }
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

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;

  if (req.method === "DELETE") {
    const { requestId } = getRequestBody(req);
    if (typeof requestId !== "string" || !requestId.trim()) {
      return res.status(400).json({ error: "A valid request ID is required." });
    }

    try {
      const account = await getWalletBalanceByUsername(username);
      if (!account) {
        return res.status(404).json({ error: "Wallet account was not found." });
      }

      const cancelledRequest = await cancelWalletTopUpRequest({
        id: requestId.trim(),
        username,
      });
      if (!cancelledRequest) {
        return res.status(404).json({
          error: "This wallet request was not found for your account.",
        });
      }
      if (cancelledRequest.unavailable) {
        return res.status(409).json({
          error: "Only pending top-up requests can be cancelled.",
        });
      }

      let notificationSent = true;
      try {
        await sendWalletTopUpCancellationEmail({
          requestId: cancelledRequest.id,
          username,
          email: account.email || "Not available",
          currentBalance: account.balance,
          amount: cancelledRequest.amount,
          paymentMethod: cancelledRequest.details.paymentMethod || "Not provided",
          mobileNumber: cancelledRequest.details.mobileNumber || "Not provided",
          whatsappNumber:
            cancelledRequest.details.whatsappNumber || "Not provided",
        });
      } catch (emailError) {
        notificationSent = false;
        console.error(
          "Wallet request cancellation notification failed:",
          emailError
        );
      }

      const notificationDetails = {
        requestId: cancelledRequest.id,
        amount: cancelledRequest.amount,
        email: account.email || "Not available",
        paymentMethod: cancelledRequest.details.paymentMethod || "Not provided",
        mobileNumber: cancelledRequest.details.mobileNumber || "Not provided",
        whatsappNumber:
          cancelledRequest.details.whatsappNumber || "Not provided",
        currentBalance: account.balance,
        status: "cancelled",
      };
      const notificationMessage = `Your request for EGP ${cancelledRequest.amount.toFixed(2)} via ${notificationDetails.paymentMethod} was cancelled.`;
      let notificationCreated = false;
      try {
        const notificationUpdated =
          await updatePendingWalletRequestNotification({
            username,
            requestId: cancelledRequest.id,
            title: "Top-up request cancelled",
            message: notificationMessage,
            details: notificationDetails,
          });
        notificationCreated =
          notificationUpdated ||
          (await tryCreateWalletNotification({
            username,
            title: "Top-up request cancelled",
            message: notificationMessage,
            type: "top_up_request",
            details: notificationDetails,
          }));
      } catch (error) {
        console.error("Wallet cancellation notification update failed:", error);
      }

      return res.status(200).json({ notificationSent, notificationCreated });
    } catch (error) {
      console.error("Wallet top-up request cancellation failed:", error);
      return res.status(500).json({
        error: "Unable to cancel your top-up request. Please try again later.",
      });
    }
  }

  if (req.method === "POST" || req.method === "PUT") {
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

    if (req.method === "PUT") {
      const { requestId } = getRequestBody(req);

      if (typeof requestId !== "string" || !requestId.trim()) {
        return res.status(400).json({ error: "A valid request ID is required." });
      }
      if (
        typeof paymentMethod !== "string" ||
        !paymentMethod.trim() ||
        paymentMethod.length > 80
      ) {
        return res.status(400).json({ error: "Choose a valid payment method." });
      }
      if (
        typeof mobileNumber !== "string" ||
        mobileNumber.trim().length > 30
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
            error: "Add an email address to your account before editing a request.",
          });
        }

        const paymentsResponse = await fetch(PAYMENTS_URL, { cache: "no-store" });
        if (!paymentsResponse.ok) {
          throw new Error(
            `Payment methods request failed (${paymentsResponse.status})`
          );
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
          method["mobile-number"] ? mobileNumber.trim() : "Not required";
        if (
          method["mobile-number"] &&
          (!normalizedMobileNumber ||
            !/^[+\d][\d\s()-]{5,28}$/.test(normalizedMobileNumber))
        ) {
          return res.status(400).json({ error: "Enter a valid mobile number." });
        }

        const updatedRequest = await updateWalletTopUpRequest({
          id: requestId.trim(),
          username,
          email: account.email,
          currentBalance: account.balance,
          amount: parsedAmount,
          paymentMethod: method.name,
          mobileNumber: normalizedMobileNumber,
          whatsappNumber: whatsappNumber.trim(),
        });
        if (!updatedRequest) {
          return res.status(404).json({
            error: "This wallet request was not found for your account.",
          });
        }
        if (updatedRequest.unavailable) {
          return res.status(409).json({
            error: "Only pending top-up requests can be edited.",
          });
        }

        let notificationSent = true;
        try {
          await sendWalletTopUpUpdateEmail({
            requestId: updatedRequest.id,
            username,
            email: account.email,
            currentBalance: account.balance,
            amount: updatedRequest.amount,
            paymentMethod: updatedRequest.details.paymentMethod,
            mobileNumber: updatedRequest.details.mobileNumber,
            whatsappNumber: updatedRequest.details.whatsappNumber,
            previousDetails: updatedRequest.previousDetails,
            previousAmount: updatedRequest.previousAmount,
          });
        } catch (emailError) {
          notificationSent = false;
          console.error("Wallet request update notification failed:", emailError);
        }

        const notificationCreated = await tryCreateWalletNotification({
          username,
          title: "Top-up request updated",
          message: `Your request for EGP ${updatedRequest.amount.toFixed(2)} via ${method.name} was updated and is still pending review.`,
          type: "top_up_request",
          details: {
            requestId: updatedRequest.id,
            amount: updatedRequest.amount,
            email: account.email,
            paymentMethod: method.name,
            mobileNumber: updatedRequest.details.mobileNumber,
            whatsappNumber: updatedRequest.details.whatsappNumber,
            currentBalance: account.balance,
            status: "pending",
          },
        });

        return res.status(200).json({
          request: {
            id: updatedRequest.id,
            type: "top_up_request",
            description: JSON.stringify(updatedRequest.details),
            amount: updatedRequest.amount,
            status: updatedRequest.status,
            createdAt: updatedRequest.createdAt,
          },
          notificationSent,
          notificationCreated,
        });
      } catch (error) {
        console.error("Wallet top-up request update failed:", error);
        return res.status(500).json({
          error: "Unable to update your top-up request. Please try again later.",
        });
      }
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

      let userEmailSent = false;
      try {
        await sendWalletTopUpUserStatusEmail({
          email: account.email,
          username,
          requestId,
          amount: parsedAmount,
          paymentMethod: method.name,
          status: "submitted",
          currentBalance: account.balance,
        });
        userEmailSent = true;
      } catch (emailError) {
        console.error("Wallet request confirmation email failed:", emailError);
      }

      const notificationCreated = await tryCreateWalletNotification({
        username,
        title: "Top-up request sent",
        message: `Your request for EGP ${parsedAmount.toFixed(2)} via ${method.name} was sent for review.`,
        type: "top_up_request",
        details: {
          requestId,
          amount: parsedAmount,
          email: account.email,
          paymentMethod: method.name,
          mobileNumber: normalizedMobileNumber || "Not required",
          whatsappNumber: whatsappNumber.trim(),
          currentBalance: account.balance,
          status: "pending",
        },
      });

      return res.status(202).json({
        message:
          "Your top-up request was sent to the admin. Your wallet balance will change only after review.",
        requestId,
        notificationCreated,
        userEmailSent,
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
