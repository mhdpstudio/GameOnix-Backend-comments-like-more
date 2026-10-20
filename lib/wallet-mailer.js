import nodemailer from "nodemailer";

const ADMIN_EMAIL = "gameonix.website@gmail.com";

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

export async function sendWalletTopUpRequestEmail({
  requestId,
  username,
  email,
  currentBalance,
  amount,
  paymentMethod,
  mobileNumber,
  whatsappNumber,
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

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"GameOnix Wallet" <${smtpUser}>`,
    to: ADMIN_EMAIL,
    subject: `Wallet top-up request: ${formattedAmount}`,
    text: [
      "A new wallet top-up request needs admin review.",
      `Request ID: ${requestId}`,
      `Username: ${username}`,
      `Email: ${email}`,
      `Amount: ${formattedAmount}`,
      `Current wallet balance: ${formattedBalance}`,
      `Payment method: ${paymentMethod}`,
      `Mobile number: ${mobileNumber}`,
      `WhatsApp contact: ${whatsappNumber}`,
      "Do not update the wallet balance until payment has been verified.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#222">
        <h1 style="color:#6c5ce7">Wallet top-up request</h1>
        <p>A user submitted a request that needs admin review.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Request ID</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(requestId)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Username</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(username)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Email</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(email)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Amount</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(formattedAmount)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Current wallet balance</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(formattedBalance)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Payment method</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(paymentMethod)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">Mobile number</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(mobileNumber)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #ddd">WhatsApp contact</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(whatsappNumber)}</td></tr>
        </table>
        <p style="color:#a33;font-weight:bold">Verify the payment before changing the wallet balance.</p>
      </div>
    `,
  });

  return requestId;
}
