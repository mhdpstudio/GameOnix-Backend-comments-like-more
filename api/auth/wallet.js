import { requireUser } from "../../lib/auth.js";
import { setCors } from "../../lib/http.js";
import { getWalletBalanceByUsername } from "../../lib/sheets.js";

export default async function handler(req, res) {
  if (setCors(req, res)) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const username = requireUser(req, res);
  if (!username) return;

  try {
    const balance = await getWalletBalanceByUsername(username);

    if (balance === null) {
      return res.status(404).json({ error: "Wallet account was not found." });
    }

    return res.status(200).json({ balance });
  } catch (error) {
    console.error("Wallet lookup failed:", error);
    return res.status(500).json({ error: "Unable to load wallet balance." });
  }
}
