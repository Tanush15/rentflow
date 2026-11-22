# Deploy RentFlow online (free)

This puts the **website + backend + shared database** on the internet so every family member (browser, Android app, iPhone) uses the same live data.

We will use:

- **GitHub** — free, stores your code (Render needs this)
- **Neon** — free PostgreSQL database (the shared rent book)
- **Render** — free Node.js web service (runs the backend + serves the website)

All three have free tiers. Total cost: ₹0.

---

## Step 1 — Create the free database (Neon)

1. Go to <https://neon.tech> and sign up (GitHub login is easiest).
2. Click **New project**. Name it `rentflow`, pick a region close to you, and create it.
3. On the project dashboard you will see a **Connection string** that looks like:

   ```
   postgresql://rentflow_owner:xxxxx@ep-xxxx.ap-southeast-1.aws.neon.tech/rentflow?sslmode=require
   ```

4. Copy the whole string. **Treat it like a password** — never post it in chat or screenshots.

> Supabase also works: create a project, then use its **Connection string → URI** from *Project Settings → Database*.

---

## Step 2 — Put the code on GitHub

Your current folder is not yet a Git repository. From a terminal opened in the project folder, run:

```bash
git init
git add .
git commit -m "RentFlow initial release"
git branch -M main
```

Then create the repository on GitHub:

1. Go to <https://github.com/new>.
2. Name it `rentflow`, leave it **Private** (recommended — your tenants' data is in the database, not the code, but private is still safer).
3. **Do not** tick "Add a README" — the code is already there.
4. Click **Create repository**, then copy the commands shown under "Push an existing repository from the command line". They look like:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/rentflow.git
   git push -u origin main
   ```

> `node_modules/`, `data/`, and `.env` are already in `.gitignore`, so they will not be uploaded. The generated `android/` and `ios/` folders will be uploaded — that is fine.

---

## Step 3 — Create the free web service (Render)

1. Sign up at <https://render.com> (GitHub login is easiest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and choose the `rentflow` repository → **Connect**.
4. Fill in:

   | Field | Value |
   | --- | --- |
   | Name | `rentflow` (this becomes your URL) |
   | Region | Closest to you |
   | Branch | `main` |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

5. Click **Advanced** → **Add Environment Variable** and add these one by one:

   | Key | Value |
   | --- | --- |
   | `NODE_VERSION` | `20` | Optional extra safeguard — `package.json` already pins Node 20 via `engines`, so Render should detect it automatically |
| `DATABASE_URL` | The Neon connection string from Step 1 |
   | `JWT_SECRET` | A long random string, e.g. `rentflow-2026-xyz-8Hk29QpLm4` — make up your own |
   | `NODE_ENV` | `production` |
   | `COOKIE_SECURE` | `true` |
   | `PGSSL` | `true` |
   | `PUBLIC_BASE_URL` | Leave blank for the first deploy; see Step 5 |
   | `ELECTRICITY_API_URL` | Leave blank | Optional provider endpoint for online BSES meter lookup (see below) |
   | `ELECTRICITY_API_KEY` | Leave blank | Optional bearer token for that provider |
   | `SEED_DEMO` | `true` |

   For `JWT_SECRET` you can use Render's **Generate** button — it creates a strong random value.

6. Click **Create Web Service**. The first deploy takes a few minutes.

> Instead of filling in the fields manually, you can use the included `render.yaml` blueprint: **New + → Blueprint → select the repo**. You will still be prompted for `DATABASE_URL` and `PUBLIC_BASE_URL`.

---

## Step 4 — Verify it is live

1. Wait until Render shows **Live** (green) next to the service.
2. Open `https://rentflow.onrender.com/api/health` in a browser. You should see:

   ```json
   {"ok":true,"db":"postgres","at":...}
   ```

   `db` must say **postgres**. If it says `sqlite`, the `DATABASE_URL` variable was not picked up.

3. Open `https://rentflow.onrender.com/` and log in with the demo account:

   | Username | Password |
   | --- | --- |
   | `admin` | `admin123` |

4. **Immediately change the demo passwords** (Account → Change password) for `admin`, `mom`, and `dad`, or delete the demo accounts from Admin.

---

## Step 5 — Set the public URL (for WhatsApp/QR links)

1. In Render, copy your real service URL from the top of the page, e.g. `https://rentflow.onrender.com`.
2. Go to **Environment**, edit `PUBLIC_BASE_URL`, and set it to that exact URL (no trailing slash).
3. Render will redeploy automatically. This makes WhatsApp reminders and QR codes contain a working public link instead of `localhost`.

---

## Step 6 — Connect the Android APK

1. Copy `dist\RentFlow.apk` to your Android phone (USB cable, Google Drive, WhatsApp to yourself, etc.).
2. Open it and tap **Install**. If Android warns about unknown sources, allow it for your file manager/browser.
3. On first launch the app asks **"Connect your family server"**.
4. Enter `https://rentflow.onrender.com` and tap **Connect**.
5. Log in. That's it — the app and the website now share the same live database and sync in real time.

The URL is remembered, so you only do this once. If Render ever changes your URL, clear the app's data in Android Settings and enter the new one.

### Optional: bake the URL into a custom APK

If you want the app to open the server directly with no setup screen:

1. Create a `.env` file in the project folder containing:

   ```env
   RENTFLOW_URL=https://rentflow.onrender.com
   ```

2. Run:

   ```bash
   npm install
   npm run mobile:sync
   cd android
   gradlew assembleDebug
   ```

   (On Windows use `gradlew.bat assembleDebug`. Requires JDK 21 + Android SDK.)

3. The new APK is at `android\app\build\outputs\apk\debug\app-debug.apk`.

---

## Useful to know

| Topic | Detail |
| --- | --- |
| Free plan sleeps | Render's free web service sleeps after ~15 minutes of inactivity. The first open of the day can take 10–30 seconds. Socket.IO reconnects automatically. |
| Electricity (BSES Delhi) | Open **Electricity** in the sidebar: set each flat's meter/CA number, then record monthly readings — units, bill and full history are calculated automatically. **BSES ↗** opens the official *Know Your Bill* page. BSES has no free public API, so direct automatic lookup is not possible unless you set `ELECTRICITY_API_URL` to a provider (contract in the README). |
| Files & photos | Stored **inside PostgreSQL**, not on Render's disk, so nothing is lost when the service restarts. |
| Storage limits | Neon's free tier is generous for a family rent book. If it fills up, upgrade the database (still cheap) — no code changes needed. |
| Custom domain | Render → Settings → Custom Domain. Add the domain at your DNS provider, then set `PUBLIC_BASE_URL` to it. |
| HTTPS | Render provides a free SSL certificate automatically. |
| Backups | Neon keeps point-in-time backups on paid plans. For free, you can export data from the Reports page or add a periodic `pg_dump`. |
| Logs | Render → Logs shows the backend console if something fails. |
| Updates | After changing code, run `git add . && git commit -m "update" && git push` — Render redeploys automatically. Website and APK (local shell mode) pick up changes on reload. |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Start fails with `invalid input syntax for type date: "2026-03"` | A `YYYY-MM` month string was written to a `DATE` column. Fixed in the current code: demo seed uses full `YYYY-MM-DD` dates and tenant create/update normalises dates. Pull the latest code and redeploy. The seed also clears a half-finished demo set automatically after a failed first start. |
| `/api/health` says `db: sqlite` | `DATABASE_URL` is missing or has a typo. Check Render → Environment, then redeploy. |
| Login fails / cookies do not stick | Make sure `COOKIE_SECURE=true` and you are using `https://` (not `http://`). |
| APK says "Could not reach that server" | Check the URL spelling, confirm the health endpoint works in a browser, and make sure the phone has internet. |
| WhatsApp link opens `localhost` | Set `PUBLIC_BASE_URL` (Step 5) and redeploy. |
| Build fails with `better-sqlite3` / `node-gyp` / `GetPrototype` errors | Render picked a Node version too new for `better-sqlite3` (e.g. Node 26). This repo pins Node 20 in `package.json` → `engines.node` and in `.nvmrc`. Commit and push those files, or set `NODE_VERSION=20` in Render → Environment. Node 20 is LTS and has prebuilt `better-sqlite3` binaries, so `npm install` succeeds. |
| Render build fails for another reason | Check Render → Logs. Usually a missing env var. Confirm `npm install` and `npm start` are the build/start commands. |
| First load is slow | Normal on the free plan (cold start). Consider a paid instance if you need it always instant. |
