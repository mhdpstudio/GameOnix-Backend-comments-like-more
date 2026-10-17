
import jwt from "jsonwebtoken";

export function requireUser(req, res) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    res.status(401).json({ error: "Missing access token." });
    return null;
  }

  const secret = process.env.GAMEONIX_API_TOKEN_SECRET;

  if (!secret || secret.length < 32) {
    res.status(500).json({ error: "Authentication is not configured." });
    return null;
  }

  try {
    const payload = jwt.verify(match[1], secret, {
      algorithms: ["HS256"],
      issuer: "gameonix-community-api",
      audience: "gameonix-web",
    });

    const username = payload.username;

    if (typeof username !== "string" || !username.trim()) {
      res.status(401).json({ error: "Invalid access token." });
      return null;
    }

    return username.trim();
  } catch {
    res.status(401).json({ error: "Invalid or expired access token." });
    return null;
  }
}
