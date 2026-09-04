# Legacy v1 (archived, not executed)

The original application, kept verbatim for reference. Nothing here runs -
the live app is `server/` (API) + `client/` (UI).

| Old file      | Replaced by |
|---------------|-------------|
| `server.js`   | `server/` - app.js, routes/, controllers/, services/, sockets/, middleware/ |
| `index.html`  | `client/index.html` + `client/js/customer.js` |
| `admin.html`  | `client/admin.html` + `client/js/admin.js` |
| `driver.html` | `client/driver.html` + `client/js/driver.js` |

## Credentials removed from these files

Two secrets were hardcoded in the v1 source and have been replaced with
placeholders here:

- `index.html` contained a live **Google Maps browser API key**.
  **Rotate that key in Google Cloud Console** - it existed in plaintext in the
  source tree and must be considered compromised. The new app reads the key from
  `GOOGLE_MAPS_API_KEY` and serves it via `/api/config`.
- `server.js` contained placeholder Razorpay keys. The new app reads
  `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` from the environment, and the secret
  key never leaves the server.

## Data

v1 targeted MongoDB (`mongodb://127.0.0.1:27017/waterApp`) but MongoDB was never
installed on this machine, so the connection always failed and no data was ever
written. There was nothing to migrate.
