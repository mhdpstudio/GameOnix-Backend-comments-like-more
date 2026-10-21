import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";

const ADMIN_EMAIL = "gameonix.website@gmail.com";
const WALLET_ACTION_URL =
  "https://gameonixfav.vercel.app/api/auth/wallet-admin-action";

function getRequestFingerprint({
  amount,
  paymentMethod,
  mobileNumber,
  whatsappNumber,
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: Number(amount),
        paymentMethod,
        mobileNumber,
        whatsappNumber,
      })
    )
    .digest("hex");
}

function createAdminActionUrl(requestId, username, action, requestFingerprint) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Wallet admin actions are not configured.");
  }

  const token = jwt.sign(
    {
      purpose: "wallet-admin-action",
      requestId,
      username,
      action,
      requestFingerprint,
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: "7d",
      issuer: "gameonix-community-api",
      audience: "gameonix-wallet-admin",
    }
  );

  return `${WALLET_ACTION_URL}?token=${encodeURIComponent(token)}`;
}

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

async function sendWalletTopUpEmail({
  requestId,
  username,
  email,
  currentBalance,
  amount,
  paymentMethod,
  mobileNumber,
  whatsappNumber,
  previousDetails,
  previousAmount,
  cancelled = false,
}) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    throw new Error("Wallet email is not configured.");
  }

  const formattedAmount = new Intl.NumberFormat("en-EG", {
    style: "currency",
    currency: "EGP",
    minimumFractionDigits: 2,
  }).format(amount);
  const formattedBalance = new Intl.NumberFormat("en-EG", {
    style: "currency",
    currency: "EGP",
    minimumFractionDigits: 2,
  }).format(currentBalance);
  const isUpdate = previousDetails !== undefined;
  const subjectPrefix = cancelled
    ? "Cancelled "
    : isUpdate
      ? "Updated "
      : "";
  const formattedPreviousAmount =
    previousAmount === undefined
      ? null
      : new Intl.NumberFormat("en-EG", {
          style: "currency",
          currency: "EGP",
          minimumFractionDigits: 2,
        }).format(previousAmount);
  const adminActions = cancelled
    ? null
    : {
        approve: createAdminActionUrl(
          requestId,
          username,
          "approve",
          getRequestFingerprint({
            amount,
            paymentMethod,
            mobileNumber,
            whatsappNumber,
          })
        ),
        cancel: createAdminActionUrl(
          requestId,
          username,
          "cancel",
          getRequestFingerprint({
            amount,
            paymentMethod,
            mobileNumber,
            whatsappNumber,
          })
        ),
      };

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"GameOnix Wallet" <${smtpUser}>`,
    to: ADMIN_EMAIL,
    subject: `${subjectPrefix}Wallet top-up request: ${formattedAmount}`,
    text: [
      cancelled
        ? "A user cancelled a pending wallet top-up request."
        : isUpdate
        ? "A user edited a wallet top-up request. The latest details are below."
        : "A new wallet top-up request needs admin review.",
      `Request ID: ${requestId}`,
      `Username: ${username}`,
      `Email: ${email}`,
      `Amount: ${formattedAmount}`,
      ...(isUpdate
        ? [
            `Previous amount: ${formattedPreviousAmount}`,
            `Previous payment method: ${previousDetails.paymentMethod || "Not provided"}`,
            `Previous mobile number: ${previousDetails.mobileNumber || "Not provided"}`,
            `Previous WhatsApp contact: ${previousDetails.whatsappNumber || "Not provided"}`,
          ]
        : []),
      `Current wallet balance: ${formattedBalance}`,
      `Payment method: ${paymentMethod}`,
      `Mobile number: ${mobileNumber}`,
      `WhatsApp contact: ${whatsappNumber}`,
      ...(adminActions
        ? [
            "Admin actions (links expire in 7 days):",
            `Approve & add funds: ${adminActions.approve}`,
            `Cancel request: ${adminActions.cancel}`,
          ]
        : []),
      cancelled
        ? "Do not process this cancelled request."
        : "Do not update the wallet balance until payment has been verified.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#222">
        <h1 style="color:#6c5ce7">${cancelled ? "Cancelled wallet top-up request" : isUpdate ? "Updated wallet top-up request" : "Wallet top-up request"}</h1>
        <p>${cancelled ? "A user cancelled a pending request. The request details are shown below." : isUpdate ? "A user edited a request. The latest details are shown below." : "A user submitted a request that needs admin review."}</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Request ID</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(requestId)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Username</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(username)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Email</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(email)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Amount</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(formattedAmount)}</td></tr>
          ${isUpdate ? `<tr><td style="padding:8px;border-bottom:1px solid #ddd">Previous amount</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(formattedPreviousAmount)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Previous payment method</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(previousDetails.paymentMethod || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Previous mobile number</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(previousDetails.mobileNumber || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Previous WhatsApp contact</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(previousDetails.whatsappNumber || "Not provided")}</td></tr>` : ""}
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Current wallet balance</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(formattedBalance)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Payment method</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(paymentMethod)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Mobile number</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(mobileNumber)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">WhatsApp contact</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(whatsappNumber)}</td></tr>
        </table>
        ${adminActions ? `
          <div style="margin:24px 0;display:flex;flex-wrap:wrap;gap:12px">
            <a href="${escapeHtml(adminActions.approve)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#16845b;color:#fff;text-decoration:none;font-weight:bold">Approve &amp; Add Funds</a>
            <a href="${escapeHtml(adminActions.cancel)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#a83d46;color:#fff;text-decoration:none;font-weight:bold">Cancel Request</a>
          </div>
          <p style="font-size:12px;color:#666">For security, each button opens a confirmation page. The request can only be processed once, while it is pending. Links expire in 7 days.</p>
        ` : ""}
        <p style="color:#a33;font-weight:bold">${cancelled ? "Do not process this cancelled request." : "Verify the payment before changing the wallet balance."}</p>
      </div>
    `,
  });

  return requestId;
}

export function sendWalletTopUpRequestEmail(details) {
  return sendWalletTopUpEmail(details);
}

export function sendWalletTopUpUpdateEmail(details) {
  return sendWalletTopUpEmail(details);
}

export function sendWalletTopUpCancellationEmail(details) {
  return sendWalletTopUpEmail({ ...details, cancelled: true });
}

export async function sendWalletTopUpUserStatusEmail({
  email,
  username,
  requestId,
  amount,
  paymentMethod,
  status,
  currentBalance,
}) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error("Wallet email is not configured.");
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("The wallet account email address is invalid.");
  }
  if (!["submitted", "approved", "rejected"].includes(status)) {
    throw new Error("The wallet request email status is invalid.");
  }

  const formatCurrency = (value) =>
    new Intl.NumberFormat("en-EG", {
      style: "currency",
      currency: "EGP",
      minimumFractionDigits: 2,
    }).format(value);
  const formattedAmount = formatCurrency(amount);
  const action = {
    submitted: {
      subject: "Top-up request received",
      heading: "Your top-up request was received",
      description:
        "Your request has been sent successfully and is waiting for review.",
      color: "#7650c8",
    },
    approved: {
      subject: "Top-up request approved",
      heading: "Your top-up request was approved",
      description: `${formattedAmount} has been added to your GameOnix wallet.`,
      color: "#16845b",
    },
    rejected: {
      subject: "Top-up request rejected",
      heading: "Your top-up request was rejected",
      description:
        "Your top-up request was rejected and no funds were added to your wallet.",
      color: "#b83f4a",
    },
  }[status];
  const balanceLine =
    currentBalance === undefined || currentBalance === null
      ? ""
      : `Current wallet balance: ${formatCurrency(currentBalance)}`;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"GameOnix Wallet" <${smtpUser}>`,
    to: email,
    subject: action.subject,
    text: [
      `Hi ${username},`,
      action.description,
      `Request ID: ${requestId}`,
      `Amount: ${formattedAmount}`,
      `Payment method: ${paymentMethod || "Not provided"}`,
      balanceLine,
      "GameOnix Wallet",
    ]
      .filter(Boolean)
      .join("\n\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#222">
        <div style="padding:24px;border:1px solid #e7e1ef;border-radius:16px;background:#fbfaff">
          <h1 style="margin:0 0 14px;color:${action.color};font-size:24px">${escapeHtml(action.heading)}</h1>
          <p style="margin:0 0 20px;color:#514b5d;line-height:1.6">Hi ${escapeHtml(username)}, ${escapeHtml(action.description)}</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Amount</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right;font-weight:bold">${escapeHtml(formattedAmount)}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Payment method</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(paymentMethod || "Not provided")}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Request ID</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(requestId)}</td></tr>
            ${balanceLine ? `<tr><td style="padding:9px 0;color:#777">Wallet balance</td><td style="padding:9px 0;text-align:right">${escapeHtml(formatCurrency(currentBalance))}</td></tr>` : ""}
          </table>
          <p style="margin:20px 0 0;color:#777;font-size:12px">GameOnix Wallet</p>
        </div>
      </div>
    `,
  });
}
