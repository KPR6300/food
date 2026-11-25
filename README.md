# Bhargavi Cloud order website

This site accepts customer orders, saves them on the server, and lets the owner update order status from a protected dashboard.

## Run locally

Requires Node.js 20 or newer and MySQL Server 8.0 or newer. MySQL Workbench is used to create/manage the database; it does not run the database server. In PowerShell, copy `.env.example` to `.env` with `Copy-Item .env.example .env`, then set your MySQL account password in `.env`.

In MySQL Workbench, connect to your local MySQL Server, open `schema.sql`, and execute it. Then create a separate app account in a Workbench SQL tab (replace the example password with a strong one):

```sql
CREATE USER IF NOT EXISTS 'bhargavi_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
ALTER USER 'bhargavi_app'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON bhargavi_cloud.* TO 'bhargavi_app'@'127.0.0.1';
```

Set the same account and password in `.env` as `MYSQL_USER` and `MYSQL_PASSWORD`. Start the site:

```powershell
npm install
npm start
```

The first MySQL startup imports existing JSON orders, menu settings, and push subscriptions if the matching database tables are empty. After that, MySQL is the source of truth. If `MYSQL_HOST` is unset, the app continues using JSON files instead.

Open `http://localhost:3000` for customers and `http://localhost:3000/admin` for the owner. Signing out only ends the owner session. Back up the MySQL database regularly.

To inspect orders in a Workbench SQL tab:

```sql
USE bhargavi_cloud;
SELECT order_code, customer_phone, status, payment_status, created_at
FROM orders
ORDER BY created_at DESC;
```

## Owner setup

Sign in to `/admin` and tick menu items that are available. Set `UPI_ID` and `UPI_PAYEE_NAME` when starting the server to enable checkout through a UPI app. All dishes start unavailable until the owner explicitly marks them available. Availability changes remain saved across server restarts.

To receive order alerts while the owner device is locked, configure VAPID keys and enable **Lock-screen alerts** in the owner dashboard on each device. Generate a key pair with `npx web-push generate-vapid-keys`, set the displayed public/private keys as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT` to a contact such as `mailto:owner@example.com`. Keep the private key secret. The site must use HTTPS (localhost is allowed for development), and the browser and operating system must permit notifications. Push subscriptions are stored in MySQL when configured, otherwise in `data/push-subscriptions.json`.

After entering their delivery details, customers can open a UPI app with the order amount and recipient prefilled. App launching requires a compatible device. The kitchen must verify the payment in its UPI app and mark it verified in the dashboard. This site does not automatically verify payments.

The **My orders** page shows orders matching the entered mobile number without an SMS code. Searches are rate-limited, and order history is available to anyone who knows that number. Results do not include delivery addresses.

Customers can search or tap the OpenStreetMap-powered checkout map, or share their current location, to fill in their delivery address. Location access is optional and requires browser permission. Map searches and reverse address lookups are sent to OpenStreetMap's public Nominatim service; selected coordinates are saved with the order and shown to the owner as a map link. Customers can also enter the address manually.

Customers can leave one 1–5 star rating and an optional comment after the order is marked delivered. The owner can see feedback alongside the order in the dashboard.

Orders, menu availability, and push subscriptions are saved in MySQL when configured.

## Deploy

For deployment, configure `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` to a reachable MySQL server, and run `schema.sql` there using Workbench or another MySQL client. Also configure `ADMIN_PASSWORD`, `UPI_ID`, `UPI_PAYEE_NAME`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `NODE_ENV=production`. Never expose the database publicly without appropriate network controls. Use HTTPS in production.

UPI app payments are the only payment option. Update the menu, address, and delivery areas in `index.html` before going live.

Run checks with `npm test`.
