import jwt from "jsonwebtoken";
import { setCors } from "../lib/http.js";
import {
  createWalletNotification,
  deleteWalletNotification,
} from "../lib/wallet-notifications.js";
import { sendGameBugReportReplyEmail } from "../lib/wallet-mailer.js";

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

function getRequestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return Object.fromEntries(new URLSearchParams(req.body));
    }
  }
  return {};
}

function verifyReplyToken(token) {
  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Game report replies are not configured.");
  }
  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "gameonix-community-api",
    audience: "gameonix-game-report-reply",
  });
  if (
    payload.purpose !== "game-bug-report-reply" ||
    typeof payload.username !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.notificationId !== "string" ||
    typeof payload.gameTitle !== "string" ||
    typeof payload.slug !== "string"
  ) {
    throw new Error("Invalid reply link.");
  }
  return payload;
}

function renderPage(res, { title, message, token = "", report = null, success = false }) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const content = success
    ? `<div class="badge">REPLY SENT</div><h1>Player notified</h1><p>${escapeHtml(message)}</p>`
    : report
      ? `
        <div class="badge">GAMEONIX · PRIVATE REPLY</div>
        <h1>Reply to player report</h1>
        <p class="intro">Your reply will be emailed to the player and added to their GameOnix notifications.</p>
        <div class="report">
          <span>GAME REPORT</span>
          <strong>${escapeHtml(report.gameTitle)}</strong>
          <small>@${escapeHtml(report.username)}${report.platform ? ` · ${escapeHtml(report.platform)}` : ""}</small>
        </div>
        <form method="POST">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <label for="reply">Your reply</label>
          <textarea id="reply" name="reply" maxlength="2000" rows="7" placeholder="Write a helpful response..." required></textarea>
          <p class="hint">The player will receive your reply by email and as a GameOnix notification.</p>
          <button type="submit">Send reply &amp; notify player <span aria-hidden="true">→</span></button>
        </form>
      `
      : `<div class="badge">GAMEONIX · GAME REPORT</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;

  return res.status(success ? 200 : report ? 200 : 400).send(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)}</title>
        <style>
          *{box-sizing:border-box}
          body{margin:0;min-height:100vh;padding:32px 16px;display:grid;place-items:center;background:#0b0d10;color:#f5f3fa;font-family:Arial,Helvetica,sans-serif}
          main{width:min(100%,560px);padding:32px;background:#17151e;border:1px solid #302b3b;border-radius:18px;box-shadow:0 24px 70px #0006}
          .brand{margin-bottom:28px;color:#aaa5b8;font-size:12px;font-weight:800;letter-spacing:2px}.brand span{color:#8d70ff}
          .badge{display:inline-block;padding:7px 10px;border:1px solid #443568;border-radius:20px;background:#29213b;color:#c4b5fd;font-size:10px;font-weight:bold;letter-spacing:1.1px}
          h1{margin:18px 0 9px;font-size:25px;line-height:1.25}p{color:#aaa5b8;font-size:14px;line-height:1.7}
          .intro{margin-bottom:20px}.report{margin:20px 0;padding:16px;background:#211e29;border:1px solid #373241;border-radius:12px}
          .report span,.report small{display:block;color:#918b9c;font-size:10px;letter-spacing:1px}.report strong{display:block;margin:8px 0;color:#f5f3fa;font-size:17px}.report small{font-size:11px;letter-spacing:0}
          label{display:block;margin:20px 0 8px;font-size:12px;font-weight:bold}
          textarea{width:100%;min-height:150px;padding:13px;color:#f5f3fa;background:#0b0d10;border:1px solid #373241;border-radius:10px;font:14px/1.6 Arial,Helvetica,sans-serif;resize:vertical}
          textarea:focus{outline:2px solid #695cfe;border-color:#8d70ff}.hint{margin:8px 0 18px;font-size:11px}
          button{width:100%;padding:13px 16px;border:0;border-radius:9px;background:#695cfe;color:#fff;font-size:13px;font-weight:bold;cursor:pointer}
          button:hover{background:#8d70ff}@media(max-width:480px){main{padding:24px 20px}}
        </style>
      </head>
      <body><main><div class="brand">GAME<span>ONIX</span></div>${content}</main></body>
    </html>`);
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.method === "POST" ? getRequestBody(req) : {};
  const token =
    typeof (body.token || req.query?.token) === "string"
      ? body.token || req.query.token
      : "";
  let report;
  try {
    report = verifyReplyToken(token);
  } catch {
    return renderPage(res, {
      title: "Invalid reply link",
      message: "This reply link is invalid or has expired. Please contact the GameOnix team.",
    });
  }

  if (req.method === "GET") {
    return renderPage(res, {
      title: "Reply to game report",
      message: "",
      token,
      report,
    });
  }

  const reply =
    typeof body.reply === "string"
      ? body.reply.replace(/\r\n?/g, "\n").trim().slice(0, 2000)
      : "";
  if (!reply) {
    return renderPage(res, {
      title: "Reply is required",
      message: "Write a reply before submitting.",
      token,
      report,
    });
  }

  let notification;
  try {
    notification = await createWalletNotification({
      username: report.username,
      title: "Reply to your game report",
      message: reply,
      type: "bug_report_reply",
      details: {
        gameTitle: report.gameTitle,
        gameName: report.gameTitle,
        slug: report.slug,
        platform: report.platform,
        reply,
      },
    });
    await sendGameBugReportReplyEmail({
      gameTitle: report.gameTitle,
      reply,
      username: report.username,
      to: report.email,
    });
    return renderPage(res, {
      title: "Reply sent",
      message: `Your reply about ${report.gameTitle} was emailed to the player and added to their GameOnix notifications.`,
      success: true,
    });
  } catch (error) {
    console.error("Game report reply delivery failed:", error);
    if (notification) {
      try {
        await deleteWalletNotification(report.username, notification.id);
      } catch (cleanupError) {
        console.error("Failed to remove undelivered game report reply:", cleanupError);
      }
    }
    return renderPage(res, {
      title: "Reply could not be sent",
      message: "The reply could not be delivered. Please try again later.",
      token,
      report,
    });
  }
}
