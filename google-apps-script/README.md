# Wallet Sheets operations

Wallet transfers and top-up approvals use this Apps Script endpoint so balance
changes are serialized with `LockService` and committed together with their
ledger rows through one Google Sheets `batchUpdate`.

## Deploy

1. Create a standalone Google Apps Script project and paste `WalletOperations.gs`.
2. Enable the manifest file and copy `appsscript.json` into the project.
3. In **Project settings → Script properties**, set:
   - `GOOGLE_SHEET_ID`: the wallet spreadsheet ID.
   - `GOOGLE_SHEET_NAME`: the main account tab name (usually `Sheet1`).
   - `WALLET_SHEETS_OPERATIONS_SECRET`: a random secret of at least 32 characters.
4. Run a function once from the editor to authorize spreadsheet and external
   request access.
5. Deploy as a **Web app**, executing as the spreadsheet owner, with access set
   to **Anyone** so the backend can call it without a Google user session. The
   endpoint rejects every request without the HMAC signature; only send signed
   requests from the backend.
6. Add these environment variables to the wallet backend deployment:
   - `WALLET_SHEETS_OPERATIONS_URL`: the deployed `/exec` URL.
   - `WALLET_SHEETS_OPERATIONS_SECRET`: the same secret as the script property.

Never expose the HMAC secret in frontend code. The backend expects the existing
`Wallet` account column, `Wallet Transactions` ledger tab, and the main account
tab to remain in the same spreadsheet. `Wallet Accounts` is created on demand.

Test with two low-balance test accounts before enabling transfers for users.
