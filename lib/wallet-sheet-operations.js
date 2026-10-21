import { createHmac } from "node:crypto";

function getConfiguration() {
  const url = process.env.WALLET_SHEETS_OPERATIONS_URL;
  const secret = process.env.WALLET_SHEETS_OPERATIONS_SECRET;
  if (!url || !secret || secret.length < 32) {
    const error = new Error("Wallet sheet operations are not configured.");
    error.code = "WALLET_OPERATION_NOT_CONFIGURED";
    throw error;
  }
  return { url, secret };
}

export async function runWalletSheetOperation(operation) {
  const { url, secret } = getConfiguration();
  const body = JSON.stringify(operation);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...operation, signature }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => null);

  if (!response.ok || !result || result.success !== true) {
    const error = new Error(
      result?.error || "The wallet sheet operation could not be completed."
    );
    error.code = result?.code || "WALLET_OPERATION_FAILED";
    throw error;
  }

  return result;
}
