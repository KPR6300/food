# Bhargavi Cloud order website

This site accepts customer orders, saves them on the server, and lets the owner update order status from a protected dashboard.

## Run locally

Requires Node.js 20 or newer. In PowerShell:

```powershell
$env:ADMIN_PASSWORD = "choose-a-unique-password-at-least-12-characters"
$env:UPI_ID = "merchant@bank"
$env:UPI_PAYEE_NAME = "Kitchen Name"
npm start
```

Open `http://localhost:3000` for customers and `http://localhost:3000/admin` for the owner. Signing out only ends the owner session; orders remain stored in `data/orders.json`. Food availability is saved to `data/menu-availability.json` only when the owner changes it. Keep `data/` on a persistent disk to retain both across restarts and deployments.

## Owner setup

Sign in to `/admin` and tick the menu items that are available. Set `UPI_ID` and `UPI_PAYEE_NAME` when starting the server to enable checkout through a UPI app. At least one available dish and valid UPI settings are needed to accept orders. Unticked dishes remain visible on the menu as unavailable.

After entering their delivery details, customers can open a UPI app with the order amount and recipient prefilled. App launching requires a compatible device. The kitchen must verify the payment in its UPI app and mark it verified in the dashboard. This site does not automatically verify payments.

The **My orders** page sends an SMS verification code using Twilio Verify before showing order history. Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID` in the server environment. The phone number must match the one used for previous orders. Verification codes are rate-limited.

Customers can search or tap the OpenStreetMap-powered checkout map, or share their current location, to fill in their delivery address. Location access is optional and requires browser permission. Map searches and reverse address lookups are sent to OpenStreetMap's public Nominatim service; selected coordinates are saved with the order and shown to the owner as a map link. Customers can also enter the address manually.

Customers can leave one 1–5 star rating and an optional comment after the order is marked delivered. The owner can see feedback alongside the order in the dashboard.

Orders and menu availability are saved under `data/`. Keep this directory on persistent storage and back it up.

## Deploy

Deploy this folder to a Node.js host that supports persistent storage. On Render, add `ADMIN_PASSWORD` (at least 12 characters), `UPI_ID`, `UPI_PAYEE_NAME`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, and `NODE_ENV=production` under the service's **Environment** settings, then redeploy. `UPI_ID` must be a valid UPI address and both UPI settings are required to enable checkout. Twilio Verify settings are required for **My orders**. Sign in to `/admin` after deploying and mark at least one menu item available; on a fresh instance, all dishes start unavailable. If the host's default disk is temporary, set `ORDERS_FILE` to a persistent disk location; menu availability is saved alongside it. Use HTTPS in production. The owner dashboard signs out when the server restarts.

UPI app payments are the only payment option. Update the sample menu, address, and delivery areas in `index.html` before going live.

Run checks with `npm test`.
