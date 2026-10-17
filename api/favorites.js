
import {
  getFavoritesByUsername,
  saveFavoritesByUsername,
} from "../lib/sheets.js";

import { requireUser } from "../lib/auth.js";
import { setCors } from "../lib/http.js";

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const username = requireUser(req, res);
    if (!username) return;

    if (req.method === "GET") {
      const record = await getFavoritesByUsername(username);

      if (!record) {
        return res.status(404).json({ error: "User not found." });
      }

      return res.status(200).json({ favorites: record.favorites });
    }

    const slug =
      typeof req.body?.slug === "string"
        ? req.body.slug.trim()
        : "";

    if (!slug || slug.length > 200) {
      return res.status(400).json({ error: "A valid game slug is required." });
    }

    const record = await getFavoritesByUsername(username);

    if (!record) {
      return res.status(404).json({ error: "User not found." });
    }

    let favorites;

    if (req.method === "POST") {
      favorites = [...new Set([...record.favorites, slug])];
    } else {
      favorites = record.favorites.filter((item) => item !== slug);
    }

    const saved = await saveFavoritesByUsername(username, favorites);

    if (!saved) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.status(200).json({ favorites });
  } catch (error) {
    console.error("Favorites API error:", error);
    return res.status(500).json({ error: "Failed to update favorites." });
  }
}
