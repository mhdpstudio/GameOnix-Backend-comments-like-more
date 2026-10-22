import jwt from "jsonwebtoken";
import {
  approveWalletPurchaseRequest,
  approveWalletTopUpRequest,
  cancelWalletPurchaseRequest,
  cancelWalletTopUpRequest,
  getWalletPurchaseRequestForAction,
} from "../../lib/wallet-ledger.js";
import { createWalletNotification } from "../../lib/wallet-notifications.js";
import {
  sendWalletPurchaseStatusEmail,
  sendWalletTopUpUserStatusEmail,
} from "../../lib/wallet-mailer.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function sendPage(res, statusCode, title, message, token, options = {}) {
  const isRejection =
    title.startsWith("Cancel") || title.startsWith("Reject");
  const giftCardQuantity = Number.isInteger(options.giftCardQuantity)
    ? Math.min(Math.max(options.giftCardQuantity, 0), 99)
    : 0;
  const giftCardFields = Array.from(
    { length: giftCardQuantity },
    (_, index) => `<label for="gift-card-code-${index}">Gift card code ${index + 1}</label>
      <input id="gift-card-code-${index}" name="giftCardCode_${index}" type="text" maxlength="200" autocomplete="off" required>`
  ).join("");
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  res.end(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)} · GameOnix Wallet</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #111014; color: #f7f7fa; font: 16px/1.6 Arial, sans-serif; }
          main { width: min(100%, 480px); padding: 30px; border: 1px solid #514267; border-radius: 18px; background: #1b1920; box-shadow: 0 24px 70px #0008; }
          h1 { margin: 0 0 12px; color: #c9a7ff; font-size: 24px; }
          p { color: #c6c1d0; }
          label { display: block; margin-top: 14px; color: #d8d2e2; font-size: 14px; font-weight: 700; }
          input { width: 100%; margin-top: 6px; padding: 12px; border: 1px solid #514267; border-radius: 9px; background: #111014; color: #f7f7fa; font: inherit; }
          button { width: 100%; margin-top: 14px; padding: 13px 16px; border: 0; border-radius: 9px; background: ${isRejection ? "#a83d46" : "#16845b"}; color: white; font-size: 15px; font-weight: 700; cursor: pointer; }
          small { display: block; margin-top: 16px; color: #9994a3; }
        </style>
      </head>
      <body>
        <main>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          ${
            token
              ? `<form method="post">
                  <input type="hidden" name="token" value="${escapeHtml(token)}">
                  ${options.giftCardError ? `<p role="alert">${escapeHtml(options.giftCardError)}</p>` : ""}
                  ${giftCardFields}
                  <button type="submit">${isRejection ? title.startsWith("Reject") ? "Confirm rejection" : "Confirm cancellation" : title.startsWith("Approve game") ? "Confirm approval and deduct wallet" : "Confirm approval and add funds"}</button>
                </form>
                <small>This request can only be processed once and only while it is pending.</small>`
              : ""
          }
        </main>
      </body>
    </html>`);
}

function getToken(req) {
  if (req.method === "POST") {
    if (req.body && typeof req.body === "object") {
      return typeof req.body.token === "string" ? req.body.token : "";
    }
    if (typeof req.body === "string") {
      return new URLSearchParams(req.body).get("token") || "";
    }
    return "";
  }

  if (typeof req.query?.token === "string") return req.query.token;
  return new URL(req.url, "https://gameonixfav.vercel.app")
    .searchParams.get("token");
}

function getFormBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return {};
}

function getGiftCardCodes(req, quantity) {
  const body = getFormBody(req);
  return Array.from({ length: quantity }, (_, index) => {
    const value = body[`giftCardCode_${index}`];
    return typeof value === "string" ? value.trim() : "";
  });
}

function verifyActionToken(token) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Wallet admin actions are not configured.");
  }

  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "gameonix-community-api",
    audience: "gameonix-wallet-admin",
  });

  if (
    !["wallet-admin-action", "wallet-purchase-admin-action"].includes(
      payload.purpose
    ) ||
    typeof payload.requestId !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.requestFingerprint !== "string" ||
    !/^[a-f\d]{64}$/i.test(payload.requestFingerprint) ||
    !["approve", "cancel"].includes(payload.action)
  ) {
    throw new Error("This wallet action link is invalid.");
  }

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  let payload;
  let token;
  try {
    token = getToken(req);
    if (!token) throw new Error("The action link is missing its token.");
    payload = verifyActionToken(token);
  } catch (error) {
    return sendPage(
      res,
      400,
      "Invalid or expired link",
      error.message || "This wallet action link is invalid or has expired."
    );
  }

  const actionTitle =
    payload.purpose === "wallet-purchase-admin-action"
      ? payload.action === "approve"
        ? "Approve game purchase"
        : "Reject game purchase"
      : payload.action === "approve"
        ? "Approve top-up request"
        : "Cancel top-up request";
  const isPurchaseApproval =
    payload.purpose === "wallet-purchase-admin-action" &&
    payload.action === "approve";
  let purchaseRequest = null;
  if (isPurchaseApproval) {
    try {
      purchaseRequest = await getWalletPurchaseRequestForAction({
        id: payload.requestId,
        username: payload.username,
        expectedFingerprint: payload.requestFingerprint,
      });
    } catch (error) {
      console.error("Wallet purchase request lookup failed:", error);
      return sendPage(
        res,
        500,
        "Unable to load purchase request",
        "The purchase request could not be loaded. Please retry from the latest admin email."
      );
    }
    if (!purchaseRequest) {
      return sendPage(
        res,
        404,
        "Request not found",
        "This purchase request could not be found for the account in the email."
      );
    }
    if (purchaseRequest.unavailable || purchaseRequest.changed) {
      return sendPage(
        res,
        409,
        purchaseRequest.changed ? "Request updated" : "Request already processed",
        purchaseRequest.changed
          ? "The request details have changed since this email was sent. Use the latest email to review it."
          : `This request is no longer pending. Current status: ${purchaseRequest.status || "unknown"}.`
      );
    }
  }
  const giftCardQuantity =
    purchaseRequest?.details?.isGiftCard === true
      ? Number(purchaseRequest.details.quantity)
      : 0;
  if (
    purchaseRequest?.details?.isGiftCard === true &&
    (!Number.isInteger(giftCardQuantity) ||
      giftCardQuantity < 1 ||
      giftCardQuantity > 99)
  ) {
    return sendPage(
      res,
      400,
      "Invalid gift card order",
      "The gift card quantity on this order is invalid. No funds were deducted."
    );
  }
  if (req.method === "GET") {
    const confirmationMessage =
      payload.purpose === "wallet-purchase-admin-action"
        ? `Confirm that you want to ${
            payload.action === "approve"
              ? "approve this game purchase and deduct its total from the user's wallet"
              : "reject this game purchase without deducting wallet funds"
          } for ${payload.username}.${giftCardQuantity ? ` Enter one gift card code for each of the ${giftCardQuantity} items before confirming.` : ""}`
        : `Confirm that you want to ${
            payload.action === "approve"
              ? "approve this request and add the requested funds. Confirm only after verifying the payment"
              : "cancel this pending request"
          } for ${payload.username}.`;
    return sendPage(
      res,
      200,
      actionTitle,
      confirmationMessage,
      token,
      giftCardQuantity ? { giftCardQuantity } : {}
    );
  }

  try {
    const isPurchase =
      payload.purpose === "wallet-purchase-admin-action";
    const giftCardCodes = giftCardQuantity
      ? getGiftCardCodes(req, giftCardQuantity)
      : [];
    if (
      giftCardQuantity &&
      giftCardCodes.some(
        (code) => !code || code.length > 200 || /[\u0000-\u001f\u007f]/.test(code)
      )
    ) {
      return sendPage(
        res,
        400,
        actionTitle,
        "Enter one valid code for every gift card in the order.",
        token,
        {
          giftCardQuantity,
          giftCardError: "All code fields are required (maximum 200 characters each).",
        }
      );
    }
    const result =
      payload.action === "approve"
        ? await (isPurchase
          ? approveWalletPurchaseRequest({
              id: payload.requestId,
              username: payload.username,
              expectedFingerprint: payload.requestFingerprint,
              giftCardCodes,
            })
          : approveWalletTopUpRequest({
            id: payload.requestId,
            username: payload.username,
            expectedFingerprint: payload.requestFingerprint,
          }))
        : await (isPurchase
          ? cancelWalletPurchaseRequest({
              id: payload.requestId,
              username: payload.username,
              expectedFingerprint: payload.requestFingerprint,
            })
          : cancelWalletTopUpRequest({
            id: payload.requestId,
            username: payload.username,
            expectedFingerprint: payload.requestFingerprint,
          }));

    if (!result) {
      return sendPage(
        res,
        404,
        "Request not found",
        "This request could not be found for the account in the email."
      );
    }
    if (result.unavailable) {
      return sendPage(
        res,
        409,
        "Request already processed",
        `This request is no longer pending. Current status: ${result.status || "unknown"}.`
      );
    }
    if (result.changed) {
      return sendPage(
        res,
        409,
        "Request updated",
        "The request details have changed since this email was sent. Use the latest email to review it."
      );
    }
    if (result.insufficientFunds) {
      return sendPage(
        res,
        409,
        "Insufficient wallet balance",
        `This purchase was not approved because ${payload.username}'s current wallet balance (${Number(result.balance).toFixed(2)} EGP) is too low. No money was deducted.`
      );
    }

    const resultStatus = isPurchase
      ? payload.action === "approve"
        ? "completed"
        : "rejected"
      : payload.action === "approve"
        ? "approved"
        : "cancelled";
    const notificationOrderDetails = isPurchase
      ? { ...result.details }
      : {};
    delete notificationOrderDetails.giftCardCodes;
    let notificationCreated = true;
    try {
      await createWalletNotification({
        username: result.username,
        title: isPurchase
          ? payload.action === "approve"
            ? "Game purchase approved"
            : "Game purchase rejected"
          : payload.action === "approve"
            ? "Top-up request approved"
            : "Top-up request cancelled",
        message: isPurchase
          ? payload.action === "approve"
            ? `${result.details.gameName} · ${result.details.packageName} was approved. EGP ${result.amount.toFixed(2)} was deducted from your wallet.${result.details.isGiftCard ? " Gift card codes are available in your wallet history. Check your email for the codes." : ""}`
            : `${result.details.gameName} · ${result.details.packageName} was rejected. No money was deducted.`
          : payload.action === "approve"
            ? `EGP ${result.amount.toFixed(2)} was added to your wallet. New balance: EGP ${result.balance.toFixed(2)}.`
            : `Your pending top-up request for EGP ${result.amount.toFixed(2)} was cancelled by the admin.`,
        type: isPurchase ? "game_purchase" : "top_up_request",
        details: {
          ...notificationOrderDetails,
          requestId: result.id,
          amount: result.amount,
          email: result.details?.email || "Not provided",
          paymentMethod: result.details?.paymentMethod || "",
          mobileNumber: result.details?.mobileNumber || "",
          whatsappNumber: result.details?.whatsappNumber || "",
          currentBalance:
            payload.action === "approve"
              ? result.balance
              : isPurchase
                ? undefined
                : result.details?.currentBalance,
          status: resultStatus,
        },
      });
    } catch (notificationError) {
      notificationCreated = false;
      console.error(
        "Wallet admin action notification creation failed:",
        notificationError
      );
    }

    let userEmailSent = false;
    try {
      if (isPurchase) {
        await sendWalletPurchaseStatusEmail({
          email: result.details?.contactEmail || result.details?.email,
          username: result.username,
          requestId: result.id,
          amount: result.amount,
          currentBalance: result.balance,
          details: result.details,
          status: resultStatus,
        });
      } else {
        await sendWalletTopUpUserStatusEmail({
          email: result.details?.email,
          username: result.username,
          requestId: result.id,
          amount: result.amount,
          paymentMethod: result.details?.paymentMethod,
          status: payload.action === "approve" ? "approved" : "rejected",
          currentBalance:
            payload.action === "approve"
              ? result.balance
              : result.details?.currentBalance,
        });
      }
      userEmailSent = true;
    } catch (emailError) {
      console.error("Wallet request decision email failed:", emailError);
    }

    const giftCardDeliveryMessage =
      isPurchase && result.details.isGiftCard
        ? userEmailSent
          ? ` Gift card codes were saved to wallet history and emailed to ${result.details.contactEmail || result.details.email}.`
          : " Gift card codes were saved to wallet history, but email delivery failed."
        : "";
    const resultMessage = isPurchase
      ? payload.action === "approve"
        ? `Purchase approved. ${result.details.gameName} · ${result.details.packageName} was deducted from ${result.username}'s wallet. New balance: ${result.balance.toFixed(2)} EGP.${giftCardDeliveryMessage}`
        : `The purchase request for ${result.username} was rejected. No funds were deducted.`
      : payload.action === "approve"
        ? `${result.amount.toFixed(2)} EGP was added to ${result.username}'s wallet. New balance: ${result.balance.toFixed(2)} EGP.`
        : `The pending top-up request for ${result.username} was cancelled.`;
    const completionMessage = [
      resultMessage,
      !notificationCreated &&
        "However, the user's in-app notification could not be created.",
      !userEmailSent && !(isPurchase && result.details.isGiftCard) &&
        "The request was processed, but the confirmation email could not be sent.",
    ]
      .filter(Boolean)
      .join(" ");
    return sendPage(
      res,
      200,
      isPurchase
        ? payload.action === "approve"
          ? "Purchase approved"
          : "Purchase rejected"
        : payload.action === "approve"
          ? "Request approved"
          : "Request cancelled",
      completionMessage
    );
  } catch (error) {
    console.error("Wallet admin action failed:", error);
    const actionError =
      typeof error?.message === "string" && error.message.trim()
        ? error.message.trim().slice(0, 400)
        : "An unexpected server error occurred.";
    return sendPage(
      res,
      500,
      "Action failed",
      `The request could not be confirmed. Check the wallet ledger before retrying. Details: ${actionError}`
    );
  }
}
