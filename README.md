# RentFlow

A family rent manager built for one very specific reality: **everyone in the family uses the same shared rent book**. Mom records a payment on her phone, Dad sees it seconds later, partial payments stay visible as dues, and every due can be carried forward, settled, reminded on WhatsApp, or turned into a receipt.

**Stack (all free to use):** Node.js + Express + Socket.IO, a free PostgreSQL database (Neon or Supabase) in the cloud with SQLite for local development, and a plain HTML/CSS/JS browser app — no frontend build step, no paid services.

---

## What is included

| Need | What RentFlow does |
| --- | --- |
| Fast rent collection | Room-aware payment screen with rent, extra charges, old-due adjustment, partial payments and a full-payable hint |
| Family sync | Socket.IO `sync` event refreshes every connected phone and shows a toast with who made the change |
| Parent-friendly use | Hindi + English voice-assistant panel with working command shortcuts (mic input is a stub) |
| Tenant reminders | WhatsApp deep links with a formatted Hindi/English message plus a QR code that opens a shareable dues page |
| Receipts | Server-generated PDF receipts, copyable receipt text and shareable receipt links with QR codes |
| Documents | Tenant photo and PDF uploads stored **inside the database**, viewer and download buttons |
| Admin control | Super admin can add users, change roles, deactivate users, reset passwords and permanently delete accounts |
| Reporting | Monthly collection vs expenses, pending dues, yearly income, expense categories and room-wise collection |
| Electricity | Per-flat BSES meter/CA numbers, monthly readings with auto units and bill, full history, official bill links and optional online API fetch |

---

## Quick start (local, 2 minutes)

Requires Node.js 20 LTS (pinned in `package.json` → `engines.node` and `.nvmrc`). Newer major versions such as Node 26 can break the native `better-sqlite3` dependency used for local SQLite storage.

```bash
npm install
npm start
```

Open **http://localhost:3000**.

Demo accounts (seeded on first run):

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin123` | Super admin |
| `mom` | `family123` | Admin |
| `dad` | `family123` | Admin |

Change these passwords after logging in (**Account → Change password**). To start over locally: stop the server, run `npm run reset:demo`, then start again. Set `SEED_DEMO=false` in `.env` if you want an empty database instead of demo rooms/tenants.

Local data lives in `data/rentflow.db` (SQLite). It is ignored by git.

---

## Deploy for free (Render + Neon)

> A detailed click-by-click guide is in **[DEPLOY.md](DEPLOY.md)**, including creating the GitHub repo, Neon database, Render service, environment variables and connecting the Android APK. A ready-to-install APK is at `dist/RentFlow.apk`.

1. **Create the database.** Sign up at [neon.tech](https://neon.tech) (free tier) and create a Postgres database. Copy its connection string. Supabase free tier works too.
2. **Create the web service.** In Render, create a new **Web Service** and point it at this repository, or use the included `render.yaml` blueprint.
   - Build command: `npm install`
   - Start command: `npm start`
3. **Set environment variables** in Render:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | The Postgres connection string from Neon/Supabase |
   | `JWT_SECRET` | A long random string (Render can generate one) |
   | `NODE_ENV` | `production` |
   | `COOKIE_SECURE` | `true` |
   | `PGSSL` | `true` |
   | `PUBLIC_BASE_URL` | Your Render URL, e.g. `https://rentflow.onrender.com` |

4. **Deploy.** On first boot the server creates all tables and seeds the demo accounts/rooms. Share the Render URL with the family and have everyone log in.

> Render's free web service sleeps when idle, so the first request after inactivity can take a few seconds. Socket.IO reconnects automatically. Upgrade the web service if you need it always awake. Because uploads and all records live in Postgres, nothing is lost when the free service restarts.

---

## Mobile app (iOS + Android)

The mobile apps are a **Capacitor shell around the exact same RentFlow web app**. They load your deployed RentFlow URL inside a native WebView, so:

- there is still only **one codebase** — the web version above is unchanged;
- every family member (web, iOS, Android) uses the same shared database and Socket.IO live sync;
- web updates go live on all phones immediately — no app-store release needed for normal changes.

Native projects are already generated in `android/` and `ios/`, and a ready-to-install debug APK is at **`dist/RentFlow.apk`**. That APK asks for your server URL on first launch, so it works with any deployment — see [DEPLOY.md](DEPLOY.md#step-6--connect-the-android-apk).

### Prerequisites

| Platform | Requirements |
| --- | --- |
| Android | Node 20+, **JDK 21**, Android SDK (platform 35), Android Studio — or just use the prebuilt APK |
| iOS | macOS, Xcode, CocoaPods (`sudo gem install cocoapods`) — iOS **cannot** be built on Windows |

### Setup (building your own APK)

1. Optionally bake your deployed server URL in `.env` (skip this to keep the first-launch setup screen):

   ```env
   RENTFLOW_URL=https://your-rentflow-app.onrender.com
   PUBLIC_BASE_URL=https://your-rentflow-app.onrender.com
   ```

2. Sync the web app and native projects:

   ```bash
   npm install
   npm run mobile:sync
   ```

   If you would rather not create a `.env` file, you can pass the URL for a single build:
   `RENTFLOW_URL=https://your-rentflow-app.onrender.com npm run mobile:sync`

3. Open and run the native project:

   ```bash
   npm run mobile:android   # opens Android Studio; press Run on a device/emulator
   npm run mobile:ios       # on a Mac: opens Xcode; pod install then press Run
   ```

   `npm run mobile:add` is only needed once if you ever need to regenerate `android/` or `ios/`.

### Testing against your local server

Start the web server with `npm start`, then set `RENTFLOW_URL` to a URL the phone can reach:

- Physical device on the same Wi-Fi: `http://192.168.x.x:3000`
- Android emulator: `http://10.0.2.2:3000`
- iOS simulator: `http://localhost:3000`

Run `npm run mobile:sync` after changing the URL. The URL is baked into the native config at sync time, so re-sync whenever you switch servers. Keep `COOKIE_SECURE=false` / do not set `NODE_ENV=production` for plain-HTTP local testing.

### What is native in the mobile app

- Android hardware **Back** button (closes dialogs, navigates back to dashboard, then exits).
- **Camera / gallery** buttons for tenant photos and documents.
- Native **share sheet** for receipts and reminder messages (clipboard fallback).
- WhatsApp and share links open in the **system browser**, not inside the app.
- Offline banner via network status monitoring, status-bar theming, and notch/safe-area spacing.

### Store builds

- **Android:** in Android Studio use *Build → Generate Signed Bundle / APK*, or `cd android && ./gradlew assembleRelease`. Sign the AAB with your own keystore and upload to Play Console.
- **iOS:** in Xcode choose *Product → Archive*, then *Distribute App* to App Store Connect or TestFlight.
- Replace the default Capacitor app icon and splash artwork in `android/app/src/main/res` and `ios/App/App/Assets.xcassets` before publishing. `capacitor.config.js` sets the app id to `com.rentflow.family` — change it there (and re-sync) if you prefer a different bundle id.

---

## How the money logic works

- Each room has a monthly rent. A tenant is assigned to one active room.
- On **Record payment**, pick the room/tenant and month. The form shows the **total payable = rent + extra charges + selected old dues**.
- Tick the old dues you want to adjust (all open dues are ticked by default). The payment is applied to those dues first, oldest first.
- If the amount received is less than the payable amount, the balance is automatically saved as a **new due** for that month (`Partial payment / आंशिक भुगतान`) and appears on the Dues screen and dashboards. Untick *"keep remaining visible as a due"* if you don't want this.
- On the **Dues** screen you can **Settle** (creates a settlement payment + receipt), **Carry →** (move it to next month), **Remind** (WhatsApp + QR), edit or delete.
- **PDF receipt** is generated on the fly at `/api/payments/:id/receipt/pdf`. The shareable QR link opens a public, token-protected receipt/reminder page.

---

## Electricity (BSES Delhi)

Open **Electricity** in the sidebar to manage meters flat-by-flat.

- **Set meter** stores the meter number, BSES CA/consumer number, provider (Rajdhani or Yamuna), notes and an optional ₹-per-unit rate.
- **＋ Reading** records a monthly meter reading. Units are calculated automatically as `current reading − previous reading`, and the bill is `units × rate` unless you type an amount explicitly. The full history is available per flat.
- **BSES ↗** opens the official *Know Your Bill* page for BSES Rajdhani or Yamuna in a new tab. This is where you verify the units shown on the real bill.
- **Fetch** is the online path. BSES does **not** publish a free public API — its lookup is a login/OTP-protected Liferay form — so RentFlow cannot call it directly. Instead, if you have any data provider or your own scraper/service, point `ELECTRICITY_API_URL` at it and the Fetch button pulls readings into a selectable list you can import.

### Provider API contract

Set on the server (Render → Environment):

```env
ELECTRICITY_API_URL=https://your-provider.example.com/electricity/lookup
ELECTRICITY_API_KEY=optional-bearer-token
```

RentFlow sends:

```json
POST { "meterNo": "12345678", "caNumber": "100123456", "provider": "BSES Rajdhani", "fromMonth": "2026-01", "toMonth": "2026-11" }
Authorization: Bearer <ELECTRICITY_API_KEY>
```

and expects:

```json
{
  "readings": [
    { "month": "2026-10", "reading": 12450, "amount": 1850,
      "bill_date": "2026-10-12", "due_date": "2026-10-28", "status": "pending" }
  ]
}
```

A single reading object (not an array) is also accepted. `bill_date`/`due_date` may use camelCase. If no API is configured, the Fetch button explains this and links to the BSES site; manual readings work in every case.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | — | `production` enables secure cookies and static caching |
| `JWT_SECRET` | dev-only fallback | Set this in production |
| `DATABASE_URL` | empty | Postgres URL; empty means local SQLite |
| `PGSSL` | `true` | Set `false` for a local Postgres without SSL |
| `COOKIE_SECURE` | follows `NODE_ENV` | Force secure auth cookie on/off |
| `PUBLIC_BASE_URL` | empty | Prefix for share links inside WhatsApp messages |
| `SEED_DEMO` | `true` | Seed demo rooms/tenants on an empty database |
| `DATA_DIR` | `./data` | Where the local SQLite file is stored |
| `ELECTRICITY_API_URL` | empty | Optional provider endpoint for online meter lookup |
| `ELECTRICITY_API_KEY` | empty | Bearer token sent to that provider |

---

## Roles

- **Member** — can view everything, cannot change records.
- **Admin** — can record payments, manage rooms/tenants/dues/expenses.
- **Super admin** — everything above plus user management and permanent deletion of accounts, tenants, payments and records.

The last active super admin cannot be deactivated, demoted or deleted, and you cannot delete your own account.

---

## Notes and limits

- Voice assistant is intentionally a **UI stub**: the mic animates and the Hindi/English command buttons perform real navigation/actions, but speech recognition is not wired up yet.
- Uploads are limited to 10 MB per file (JPG, PNG, WebP, GIF, PDF) and are stored as database blobs, so they survive cloud restarts.
- Free-tier Postgres has storage/connection limits; this is fine for a family-scale rent book.
- WhatsApp buttons open `wa.me` deep links; they never send messages automatically.
- Share links expire after 30 days by default.

## Project layout

```
server.js            Express + Socket.IO bootstrap and public share page
db.js                SQLite/Postgres adapter, schema and demo seed
auth.js              JWT cookie auth and role guards
utils.js             money/month/reminder/receipt helpers
lib/data.js          Dashboard/report aggregations
lib/share.js         QR + public share pages
lib/pdf.js           PDF receipt generator
routes/              REST endpoints grouped by feature
public/              Shared browser/mobile UI (index.html, styles.css, js/app.js, js/native.js)
capacitor.config.js  Mobile app config (server URL, app id, plugins)
scripts/native-entry.js Source for the native bridge bundle
android/             Generated Android Studio project
ios/                 Generated Xcode project
render.yaml          Free Render deployment blueprint
scripts/reset-demo.js Local database reset helper
```
