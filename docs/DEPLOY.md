# Deploy for free, no card needed

| Piece | Service | Free plan (check current terms) |
|---|---|---|
| App (API + PWA, HTTPS included) | [Render](https://render.com) | 1 web service. Sleeps after 15 min without visitors and takes about 1 min to wake. 750 hours/month. |
| Database | [Neon](https://neon.com) Postgres | Free forever: about 0.5–1 GB storage and 100 compute-hours/month. Sleeps when idle and wakes in under a second. |
| Code + nightly backups | GitHub (private repo + Actions) | Free |

None of these asks for a card at sign-up. Render's own free Postgres expires
after 30 days, which is why the database is on Neon.

Allow about 30 minutes.

---

## 1. Put the code on GitHub

1. Create a free account at <https://github.com>.
2. Click **New repository**. Name it `frozen-shake`, choose **Private**, and
   don't add a README.
3. In the project folder on your laptop, run:

```bash
git init
git add .
git commit -m "Frozen Shake Cash Tracker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/frozen-shake.git
git push -u origin main
```

Git will ask you to log in. Easiest options are
[GitHub Desktop](https://desktop.github.com) or `gh auth login`.

## 2. Create the database on Neon

1. Sign up at <https://neon.com> with your GitHub account.
2. Create a project:
   - **Name:** `frozen-shake`
   - **Region:** *AWS Asia Pacific (Singapore)*. That's close to India and the
     same region as Render's Singapore.
3. Click **Connect** on the project dashboard and switch **Connection pooling
   off**. The app needs the *direct* connection: its migrations take a lock that
   poolers don't support.
4. Copy the connection string. It looks like:

   ```
   postgresql://neondb_owner:xxxx@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   - If it ends with `&channel_binding=require`, delete that part and keep
     `?sslmode=require`.
   - Make sure the host does **not** contain `-pooler`.

## 3. Deploy the app on Render

1. Sign up at <https://render.com> with your GitHub account and allow it to see
   the `frozen-shake` repo.
2. Go to **New → Blueprint** and pick the repo. Render reads `render.yaml` and
   proposes one free web service called `frozen-shake`.
3. Fill in the values it asks for:
   - **`DATABASE_URL`:** the Neon string from step 2.
   - **`APP_URL`:** `https://frozen-shake.onrender.com`. If that name is taken,
     Render adds a suffix; you'll fix it in step 4.
   - **SMTP fields:** leave them empty for now (see step 6).
4. Click **Apply**. The first build takes about 5–10 minutes.
   - In **Logs** you should see `applied migration` and then `api listening`.
   - Check the service's real URL at the top of its page. If it differs from
     `APP_URL`, change `APP_URL` under **Environment**. Render redeploys
     automatically.
5. Open the URL and create your account. The first shop comes with your default
   categories and partners.

To install the app on a phone:
- **Android (Chrome):** menu → *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

## 4. Turn on nightly backups (free, automatic)

The repo includes `.github/workflows/backup.yml`, which dumps the database every
night at 03:00 IST and keeps each backup for 30 days.

1. In your GitHub repo, go to **Settings → Secrets and variables → Actions → New
   repository secret**.
2. Set **Name** to `DATABASE_URL` and **Value** to the same Neon string.
3. Open the **Actions** tab, choose **Backup database**, and click **Run
   workflow** to test it. When the run finishes, the backup is listed under
   **Artifacts**.

Keep the repo **private**, because the backups contain all your shop data.

To restore, download the artifact, unzip it, and load it into an empty
database. The easiest target is a fresh Neon branch or project:

```bash
gunzip -c backup.sql.gz | psql "NEW_DATABASE_URL"
```

Neon can also roll the database back to any point in the last 6 hours (on the
Neon dashboard: *Restore*).

## 5. Optional: avoid the 1-minute wake-up

On the free plan the app sleeps after 15 minutes without visitors.

- **What it means in practice:** the first person to open the app after a quiet
  spell waits about a minute. Anything they enter offline in the meantime syncs
  on its own once the server is up.
- **To keep it awake:**
  1. Create a free account at <https://cron-job.org> (no card).
  2. Make it call `https://YOUR-APP.onrender.com/api/health` every 10 minutes.
- **Will that use up the free hours?** No. One service running all month is
  about 744 hours, which is within the 750 free hours, as long as it's your only
  Render service.
- **Does it affect the database?** No. The health check doesn't touch the
  database, so Neon still sleeps and saves its compute-hours.

## 6. Optional: password-reset emails

Render's free plan blocks the usual email ports (25, 465, 587). Your options:

- **Do nothing.** When someone uses "Forgot password", the reset link is written
  to the logs. Open Render → **Logs**, search for `reset link`, and send the
  link to them yourself. For a handful of partners this is usually enough.
- **Use [Brevo](https://www.brevo.com)'s free SMTP relay** (no card), which also
  accepts port **2525**. In Render → **Environment**, set:
  - `SMTP_HOST=smtp-relay.brevo.com`
  - `SMTP_PORT=2525`
  - `SMTP_USER` and `SMTP_PASS`: your Brevo SMTP login and SMTP key
  - `SMTP_FROM=Frozen Shake <your-verified-sender@example.com>`

## Updating the app

Run `git push`. Render rebuilds and redeploys automatically, and database
migrations run when the app starts. Installed PWAs pick up the new version the
next time they're opened.

## Troubleshooting

| Problem | Fix |
|---|---|
| Logs show `failed to connect` or `channel binding` | Use the direct Neon string (no `-pooler`) ending in `?sslmode=require`. |
| Can't stay signed in | `APP_URL` must be the `https://` Render URL, and `COOKIE_SECURE` must be `true` (render.yaml sets it). |
| "Service suspended" | The free hours for the month ran out, usually because there are several free services. Delete the extras. |
| Neon says compute limit reached | Very unlikely at this scale. It resets monthly. Make sure nothing pings an endpoint that hits the database. |

If you get a card later, [DEPLOY-VPS.md](DEPLOY-VPS.md) explains how to move to
your own always-on free VM.
