import jwt from "jsonwebtoken";
import { setCors } from "../lib/http.js";
import {
  createWalletNotification,
  deleteWalletNotification,
} from "../lib/wallet-notifications.js";
import { sendGameRequestReplyEmail } from "../lib/wallet-mailer.js";

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
    throw new Error("Game request replies are not configured.");
  }

  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "gameonix-community-api",
    audience: "gameonix-game-request-reply",
  });

  if (
    payload.purpose !== "game-request-reply" ||
    typeof payload.username !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.notificationId !== "string" ||
    typeof payload.gameTitle !== "string" ||
    typeof payload.platform !== "string"
  ) {
    throw new Error("Invalid reply link.");
  }

  return payload;
}

function renderPage(res, { title, message, token = "", request = null, success = false }) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const content = success
    ? `
      <div class="badge">REPLY SENT</div>
      <h1>Player notified</h1>
      <p>${escapeHtml(message)}</p>
    `
    : request
      ? `
        <div class="badge">GAMEONIX · PRIVATE REPLY</div>
        <h1>Reply to game request</h1>
        <p class="intro">Your reply will be emailed to the player and added to their GameOnix notifications.</p>
        <div class="request">
          <span>GAME REQUEST</span>
          <strong>${escapeHtml(request.gameTitle)}</strong>
          <small>${escapeHtml(request.platform)} · @${escapeHtml(request.username)}</small>
        </div>
        <form method="POST">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <label for="reply">Your reply</label>
          <textarea id="reply" name="reply" maxlength="2000" rows="7" placeholder="Write a helpful response..." required></textarea>
          <p class="hint">This message will be sent to the player's email and displayed in their topbar notifications.</p>
          <button type="submit">Send reply &amp; notify player <span aria-hidden="true">→</span></button>
        </form>
      `
      : `<div class="badge">GAMEONIX · GAME REQUEST</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;

  return res.status(success ? 200 : request ? 200 : 400).send(`<!doctype html>
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
          .intro{margin-bottom:20px}.request{margin:20px 0;padding:16px;background:#211e29;border:1px solid #373241;border-radius:12px}
          .request span,.request small{display:block;color:#918b9c;font-size:10px;letter-spacing:1px}.request strong{display:block;margin:8px 0;color:#f5f3fa;font-size:17px}.request small{font-size:11px;letter-spacing:0}
          label{display:block;margin:20px 0 8px;font-size:12px;font-weight:bold}
          textarea{width:100%;min-height:150px;padding:13px;color:#f5f3fa;background:#0b0d10;border:1px solid #373241;border-radius:10px;font:14px/1.6 Arial,Helvetica,sans-serif;resize:vertical}
          textarea:focus{outline:2px solid #695cfe;border-color:#8d70ff}
          .hint{margin:8px 0 18px;font-size:11px}
          button{width:100%;padding:13px 16px;border:0;border-radius:9px;background:#695cfe;color:#fff;font-size:13px;font-weight:bold;cursor:pointer}
          button:hover{background:#8d70ff}
          @media(max-width:480px){main{padding:24px 20px}}
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

  let request;
  try {
    request = verifyReplyToken(token);
  } catch {
    return renderPage(res, {
      title: "Invalid reply link",
      message: "This reply link is invalid or has expired. Please contact the GameOnix team.",
    });
  }

  if (req.method === "GET") {
    return renderPage(res, {
      title: "Reply to game request",
      message: "",
      token,
      request,
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
      request,
    });
  }

  let notification;
  try {
    notification = await createWalletNotification({
      username: request.username,
      title: "Reply to your game request",
      message: reply,
      type: "game_request_reply",
      details: {
        gameTitle: request.gameTitle,
        platform: request.platform,
        reply,
        requestId: request.notificationId,
      },
    });

    await sendGameRequestReplyEmail({
      gameTitle: request.gameTitle,
      platform: request.platform,
      reply,
      username: request.username,
      to: request.email,
    });

    return renderPage(res, {
      title: "Reply sent",
      message: `Your reply about ${request.gameTitle} was sent to the player by email and as a GameOnix notification.`,
      success: true,
    });
  } catch (error) {
    console.error("Game request reply failed:", error.message);
    if (notification) {
      try {
        await deleteWalletNotification(request.username, notification.id);
      } catch (cleanupError) {
        console.error(
          "Failed to clean up game request reply notification:",
          cleanupError
        );
      }
    }

    return renderPage(res, {
      title: "Reply could not be sent",
      message: "The reply could not be delivered. Please try again later.",
      token,
      request,
    });
  }
}
