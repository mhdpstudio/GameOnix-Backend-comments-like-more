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

function createPurchaseAdminActionUrl(requestId, username, action, details) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Wallet admin actions are not configured.");
  }
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify(details))
    .digest("hex");
  const token = jwt.sign(
    {
      purpose: "wallet-purchase-admin-action",
      requestId,
      username,
      action,
      requestFingerprint,
      isGiftCard: details.isGiftCard === true,
      quantity: Number(details.quantity),
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

export async function sendWalletPurchaseRequestEmail({
  requestId,
  username,
  email,
  amount,
  currentBalance,
  details,
}) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error("Wallet email is not configured.");
  }
  const approveUrl = createPurchaseAdminActionUrl(
    requestId,
    username,
    "approve",
    details
  );
  const rejectUrl = createPurchaseAdminActionUrl(
    requestId,
    username,
    "cancel",
    details
  );
  const formatCurrency = (value) =>
    new Intl.NumberFormat("en-EG", {
      style: "currency",
      currency: "EGP",
      minimumFractionDigits: 2,
    }).format(value);
  const image = details.gameIcon
    ? `<img src="${escapeHtml(details.gameIcon)}" alt="${escapeHtml(details.gameName)}" width="72" height="72" style="display:block;width:72px;height:72px;object-fit:cover;border-radius:16px;border:1px solid #eee">`
    : "";
  const rows = [
    ["Game", details.gameName],
    ["Package", details.packageName],
    ["Quantity", details.quantity],
    ["Total", formatCurrency(amount)],
    ["Username", username],
    ["Account email", email || "Not provided"],
    ["Order contact email", details.contactEmail || "Not provided"],
    ["Player ID / Account", details.playerId || details.recipient || "Not provided"],
    ["Server / Region", details.serverId || "Not provided"],
    ["Payment phone", details.mobileNumber || "Not provided"],
    ["Payment method", details.paymentMethod || "GameOnix wallet"],
    ["Request ID", requestId],
    ["Balance before approval", formatCurrency(currentBalance)],
  ];
  const table = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid #eee;color:#777">${escapeHtml(label)}</td><td style="padding:9px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"GameOnix Store" <${smtpUser}>`,
    to: ADMIN_EMAIL,
    subject: `Game purchase request: ${details.gameName} · ${details.packageName}`,
    text: [
      "A game purchase request is waiting for your review.",
      `Game: ${details.gameName}`,
      `Package: ${details.packageName}`,
      `Quantity: ${details.quantity}`,
      `Total: ${formatCurrency(amount)}`,
      `Username: ${username}`,
      `Account email: ${email || "Not provided"}`,
      `Order contact email: ${details.contactEmail || "Not provided"}`,
      `Player ID / Account: ${details.playerId || details.recipient || "Not provided"}`,
      `Server / Region: ${details.serverId || "Not provided"}`,
      `Payment phone: ${details.mobileNumber || "Not provided"}`,
      `Payment method: ${details.paymentMethod || "GameOnix wallet"}`,
      `Request ID: ${requestId}`,
      `Balance before approval: ${formatCurrency(currentBalance)}`,
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`,
      details.walletPayment === false
        ? "This order uses an external payment method. Approving it will not deduct wallet funds."
        : "Wallet funds are deducted only after approval.",
    ].join("\n\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#f5f2fa;background:#17151c">
        <div style="padding:24px;border:1px solid #493a5f;border-radius:18px;background:#211d29">
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:22px">
            ${image}
            <div>
              <div style="color:#bda2ed;font-size:11px;font-weight:bold;letter-spacing:1.5px">GAMEONIX STORE</div>
              <h1 style="margin:5px 0 0;font-size:23px">${escapeHtml(details.gameName)}</h1>
              <div style="margin-top:5px;color:#b6afc2">${escapeHtml(details.packageName)}</div>
            </div>
          </div>
          <p style="color:#d2cadf;line-height:1.6">A game purchase request is waiting for review. Payment method: <strong>${escapeHtml(details.paymentMethod || "GameOnix wallet")}</strong>. ${details.walletPayment === false ? "Approving records the order only; no wallet funds will be deducted." : "Wallet funds are deducted only after approval."}</p>
          <table style="width:100%;border-collapse:collapse">${table}</table>
          <div style="display:flex;gap:12px;margin:24px 0 12px">
            <a href="${escapeHtml(approveUrl)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:#16845b;color:#fff;text-decoration:none;font-weight:bold">Review &amp; approve</a>
            <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:#a83d46;color:#fff;text-decoration:none;font-weight:bold">Reject request</a>
          </div>
          <p style="margin:16px 0 0;color:#a9a1b5;font-size:12px">${details.walletPayment === false ? "No wallet deduction will be made for this payment method." : "The wallet is charged only after approval."} Links expire in 7 days.</p>
        </div>
      </div>
    `,
  });
}

export async function sendGameRequestEmail({
  gameTitle,
  email,
  platform,
  details,
  username,
}) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error("Game request email is not configured.");
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
  const text = [
    "GAMEONIX  /  GAME REQUEST",
    "A new game suggestion is ready for review.",
    "",
    `GAME: ${gameTitle}`,
    `PLATFORM: ${platform || "Not specified"}`,
    `FROM: ${email}`,
    `USERNAME: ${username || "Guest"}`,
    "",
    "ADDITIONAL DETAILS",
    details || "None provided",
    "",
    "Reply to this email to contact the player.",
  ].join("\n");

  await transporter.sendMail({
    from: `"GameOnix" <${smtpUser}>`,
    to: ADMIN_EMAIL,
    replyTo: email,
    subject: `Game request: ${gameTitle}`,
    text,
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">
        New request for ${escapeHtml(gameTitle)} from ${escapeHtml(email)}.
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0;padding:28px 12px;background-color:#0b0d10;font-family:Arial,Helvetica,sans-serif">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">
              <tr>
                <td style="padding:0 4px 16px;color:#aaa5b8;font-size:12px;font-weight:bold;letter-spacing:2px">
                  GAME<span style="color:#8d70ff">ONIX</span>
                  <span style="float:right;color:#777184;font-size:10px;letter-spacing:1.4px">COMMUNITY</span>
                </td>
              </tr>
              <tr>
                <td style="padding:30px 32px 28px;background-color:#17151e;border:1px solid #302b3b;border-radius:18px 18px 0 0">
                  <div style="display:inline-block;padding:7px 10px;color:#c4b5fd;background-color:#29213b;border:1px solid #443568;border-radius:20px;font-size:10px;font-weight:bold;letter-spacing:1.2px">
                    NEW GAME SUGGESTION
                  </div>
                  <h1 style="margin:18px 0 8px;color:#f7f5fb;font-size:27px;line-height:1.25">
                    ${escapeHtml(gameTitle)}
                  </h1>
                  <p style="margin:0;color:#a8a2b4;font-size:14px;line-height:1.6">
                    A player suggested this game for the GameOnix collection.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 32px;background-color:#211e29;border-right:1px solid #302b3b;border-left:1px solid #302b3b">
                  <p style="margin:0 0 12px;color:#aaa5b8;font-size:10px;font-weight:bold;letter-spacing:1.5px">REQUEST DETAILS</p>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #373241;border-radius:12px;background-color:#191720">
                    <tr>
                      <td style="padding:14px 16px;border-bottom:1px solid #302b39;color:#918b9c;font-size:12px">Platform</td>
                      <td align="right" style="padding:14px 16px;border-bottom:1px solid #302b39;color:#eeeaf5;font-size:13px;font-weight:bold">${escapeHtml(platform || "Not specified")}</td>
                    </tr>
                    <tr>
                      <td style="padding:14px 16px;border-bottom:1px solid #302b39;color:#918b9c;font-size:12px">Player email</td>
                      <td align="right" style="padding:14px 16px;border-bottom:1px solid #302b39;font-size:13px">
                        <a href="mailto:${escapeHtml(email)}" style="color:#b7a2ff;text-decoration:none">${escapeHtml(email)}</a>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:14px 16px;color:#918b9c;font-size:12px">GameOnix account</td>
                      <td align="right" style="padding:14px 16px;color:#eeeaf5;font-size:13px;font-weight:bold">${escapeHtml(username ? `@${username}` : "Guest request")}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 32px 28px;background-color:#211e29;border:1px solid #302b3b;border-top:0;border-radius:0 0 18px 18px">
                  <p style="margin:0 0 10px;color:#aaa5b8;font-size:10px;font-weight:bold;letter-spacing:1.5px">PLAYER'S NOTE</p>
                  <div style="padding:16px;color:#e7e2ef;background-color:#191720;border:1px solid #373241;border-radius:12px;font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(details || "No additional details were provided.")}</div>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px">
                    <tr>
                      <td align="center" bgcolor="#695cfe" style="border-radius:9px">
                        <a href="mailto:${escapeHtml(email)}?subject=${encodeURIComponent(`Re: Game request: ${gameTitle}`)}" style="display:inline-block;padding:12px 18px;color:#fff;font-size:12px;font-weight:bold;text-decoration:none">
                          Reply to player&nbsp;&nbsp;→
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:18px 8px 0;color:#777184;font-size:10px;line-height:1.6">
                  Sent privately through GameOnix game requests.<br>
                  Replies go directly to ${escapeHtml(email)}.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `,
  });
}

export async function sendWalletPurchaseStatusEmail({
  email,
  username,
  requestId,
  amount,
  currentBalance,
  details,
  status,
}) {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error("Wallet email is not configured.");
  }
  if (
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("The wallet account email address is invalid.");
  }
  const action = {
    submitted: {
      subject: "Game purchase request received",
      heading: "Your order is waiting for review",
      description: "Your wallet purchase request was sent to the GameOnix team. No money has been deducted yet.",
      color: "#7650c8",
    },
    completed: {
      subject: "Game purchase approved",
      heading: "Your order was approved",
      description: `${new Intl.NumberFormat("en-EG", {
        style: "currency",
        currency: "EGP",
        minimumFractionDigits: 2,
      }).format(amount)} was deducted from your GameOnix wallet.`,
      color: "#16845b",
    },
    approved: {
      subject: "Game purchase approved",
      heading: "Your order was approved",
      description: "Your game purchase request was approved. Your GameOnix wallet was not charged for this payment method.",
      color: "#16845b",
    },
    rejected: {
      subject: "Game purchase request rejected",
      heading: "Your order was not approved",
      description: "Your purchase request was rejected. No money was deducted from your wallet.",
      color: "#b83f4a",
    },
  }[status];
  if (!action) throw new Error("The purchase email status is invalid.");
  const formatCurrency = (value) =>
    new Intl.NumberFormat("en-EG", {
      style: "currency",
      currency: "EGP",
      minimumFractionDigits: 2,
    }).format(value);
  const image = details.gameIcon
    ? `<img src="${escapeHtml(details.gameIcon)}" alt="${escapeHtml(details.gameName)}" width="72" height="72" style="display:block;width:72px;height:72px;object-fit:cover;border-radius:16px">`
    : "";
  const balance = Number.isFinite(Number(currentBalance))
    ? `<p style="margin:18px 0 0;color:#777">Wallet balance: <strong>${escapeHtml(formatCurrency(currentBalance))}</strong></p>`
    : "";
  const giftCardCodes =
    ["completed", "approved"].includes(status) &&
    details.isGiftCard === true &&
    Array.isArray(details.giftCardCodes)
      ? details.giftCardCodes
      : [];
  const giftCardCodeText = giftCardCodes.map(
    (code, index) => `Gift card code ${index + 1}: ${code}`
  );
  const giftCardCodeHtml = giftCardCodes.length
    ? `<div style="margin-top:22px;padding:16px;border:1px solid #d8c9f3;border-radius:12px;background:#f2ecff">
        <h2 style="margin:0 0 10px;color:#5e36a5;font-size:16px">Your gift card codes</h2>
        ${giftCardCodes.map((code, index) => `<p style="margin:8px 0;color:#292333"><strong>Code ${index + 1}:</strong> <code style="font-size:15px;word-break:break-all">${escapeHtml(code)}</code></p>`).join("")}
      </div>`
    : "";
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from: `"GameOnix Store" <${smtpUser}>`,
    to: email,
    subject: action.subject,
    text: [
      `Hi ${username},`,
      action.description,
      `Game: ${details.gameName}`,
      `Package: ${details.packageName}`,
      `Quantity: ${details.quantity}`,
      `Total: ${formatCurrency(amount)}`,
      `Payment method: ${details.paymentMethod || "GameOnix wallet"}`,
      `Player ID / Account: ${details.playerId || details.recipient || "Not provided"}`,
      `Server / Region: ${details.serverId || "Not provided"}`,
      ...giftCardCodeText,
      `Request ID: ${requestId}`,
      Number.isFinite(Number(currentBalance))
        ? `Wallet balance: ${formatCurrency(currentBalance)}`
        : "",
      "GameOnix Store",
    ].filter(Boolean).join("\n\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:auto;padding:24px;color:#222">
        <div style="padding:24px;border:1px solid #e7e1ef;border-radius:18px;background:#fbfaff">
          <div style="display:flex;align-items:center;gap:15px;margin-bottom:20px">
            ${image}
            <div>
              <div style="color:#7650c8;font-size:11px;font-weight:bold;letter-spacing:1.2px">GAMEONIX STORE</div>
              <h1 style="margin:5px 0;font-size:22px;color:${action.color}">${escapeHtml(action.heading)}</h1>
              <strong>${escapeHtml(details.gameName)} · ${escapeHtml(details.packageName)}</strong>
            </div>
          </div>
          <p style="color:#514b5d;line-height:1.7">Hi ${escapeHtml(username)}, ${escapeHtml(action.description)}</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Quantity</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(details.quantity)}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Total</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right;font-weight:bold">${escapeHtml(formatCurrency(amount))}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Payment method</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(details.paymentMethod || "GameOnix wallet")}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Player ID / Account</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(details.playerId || details.recipient || "Not provided")}</td></tr>
            <tr><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;color:#777">Server / Region</td><td style="padding:9px 0;border-bottom:1px solid #e7e1ef;text-align:right">${escapeHtml(details.serverId || "Not provided")}</td></tr>
            <tr><td style="padding:9px 0;color:#777">Request ID</td><td style="padding:9px 0;text-align:right">${escapeHtml(requestId)}</td></tr>
          </table>
          ${giftCardCodeHtml}
          ${balance}
        </div>
      </div>
    `,
  });
}
