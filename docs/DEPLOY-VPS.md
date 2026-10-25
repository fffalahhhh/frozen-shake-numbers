# Deploy on your own free VM (needs a card for Oracle sign-up)

This setup costs nothing to run:

- **Server:** an Oracle Cloud *Always Free* VM.
- **Domain:** a free subdomain from DuckDNS.
- **HTTPS:** Caddy, which gets a free Let's Encrypt certificate and renews it automatically.

The repo's `docker-compose.yml` runs unchanged. All the software is open source
(Docker, PostgreSQL, Caddy, nginx). The server stays on, so there are no cold
starts. The database lives on the VM's own disk, so it never expires.

> Free tiers change. In mid-2026 Oracle cut the free Arm (Ampere A1) allowance
> to **2 OCPU / 12 GB RAM**. That is still far more than this app needs. Check
> Oracle's current Always Free limits before you start.

Allow about 45 minutes.

---

## 1. Create the free server

1. Sign up at <https://www.oracle.com/cloud/free/>.
   - A card is required for identity verification only. Always Free resources
     are never charged.
   - Choose a **home region** close to your shops, e.g. *India South (Hyderabad)*
     or *India West (Mumbai)*. You can't change it later.
2. Go to **Compute → Instances → Create instance**.
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** Ampere → `VM.Standard.A1.Flex`, **1 OCPU, 6 GB RAM**. This stays
     inside the free allowance with room to spare.
     - If you get *"Out of capacity"*, try again later or pick another
       availability domain.
     - Fallback: `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM, also free). It works,
       but add swap first (see Troubleshooting).
   - **Networking:** keep "Assign a public IPv4 address" ticked.
   - **SSH keys:** upload your public key (`~/.ssh/id_ed25519.pub`) or let Oracle
     generate one and download it.
3. Click **Create**, then copy the instance's **Public IP address**.

## 2. Open ports 80 and 443

Oracle blocks web traffic in **two** places. You need to open both.

**a) Cloud firewall (Security List).**
1. Go to Instance → *Subnet* link → *Security Lists* → *Default Security List*
   → **Add Ingress Rules**.
2. Add two rules with source `0.0.0.0/0`, protocol TCP:
   - destination port `80`
   - destination port `443`

**b) The VM's own firewall.** SSH in first:

```bash
ssh ubuntu@YOUR_PUBLIC_IP
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Get a free domain

1. Go to <https://www.duckdns.org>. Sign in with GitHub or Google and create a
   subdomain, e.g. `frozenshake` → `frozenshake.duckdns.org`.
2. Set its **current ip** to your VM's public IP and click *update ip*.
3. Check it from your laptop:

   ```bash
   ping frozenshake.duckdns.org
   ```

   It should reply from your VM's IP.

Optional: in Oracle, go to *Networking → Reserved Public IPs* and reserve the IP
(one is free). That way it never changes, even if you recreate the VM.

## 4. Install Docker on the VM

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit          # log out and back in so the group change applies
ssh ubuntu@YOUR_PUBLIC_IP
docker compose version
```

## 5. Copy the app to the server

From your laptop, in the project folder:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./ ubuntu@YOUR_PUBLIC_IP:~/frozen-shake/
```

Alternatively, push the project to a free private GitHub or Codeberg repo and
`git clone` it on the server. That makes later updates a `git pull`.

## 6. Configure

On the server:

```bash
cd ~/frozen-shake
cp .env.example .env
nano .env
```

Set at least these values:

```ini
POSTGRES_PASSWORD=<long random string>     # e.g. output of: openssl rand -hex 24
DOMAIN=frozenshake.duckdns.org
APP_URL=https://frozenshake.duckdns.org
WEB_PORT=127.0.0.1:8080                    # keep nginx private; Caddy is the public door
COOKIE_SECURE=true
```

Password-reset email is optional. With Gmail (free):

1. Turn on 2-Step Verification.
2. Create an **App password** at <https://myaccount.google.com/apppasswords>.
3. Add these lines:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<16-character app password>
SMTP_FROM=Frozen Shake <you@gmail.com>
```

If you leave `SMTP_HOST` empty, reset links are written to the API log instead.
You can read them with `docker compose logs api | grep reset`.

## 7. Start it

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The first build takes a few minutes. Caddy fetches the HTTPS certificate on its
own within about 30 seconds of starting.

Open **https://frozenshake.duckdns.org**, create your account, and you're live.

To install the app on a phone:
- **Android (Chrome):** menu → *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

## 8. Back up the database daily (free)

```bash
mkdir -p ~/backups
crontab -e
```

Add this line. It makes a compressed dump every night at 02:30 and keeps 30 days:

```cron
30 2 * * * cd ~/frozen-shake && docker compose exec -T db pg_dump -U frozen frozen | gzip > ~/backups/frozen-$(date +\%F).sql.gz && find ~/backups -name '*.sql.gz' -mtime +30 -delete
```

Keep a copy somewhere other than the VM. For example, copy `~/backups`
occasionally with `rsync ubuntu@YOUR_PUBLIC_IP:~/backups/ ./backups/`, or use
`rclone` to send it to your free Google Drive.

To restore:

```bash
gunzip -c ~/backups/frozen-2026-10-25.sql.gz | docker compose exec -T db psql -U frozen frozen
```

## Updating the app

Copy the new code again (step 5, or `git pull`), then rebuild:

```bash
cd ~/frozen-shake
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically when the API starts. Installed PWAs pick
up the new version the next time they're opened.

## Troubleshooting

| Problem | Fix |
|---|---|
| Browser can't connect | Check both firewalls (step 2). Then run `curl -I http://localhost` on the VM. |
| Certificate error / Caddy log says "challenge failed" | DuckDNS must point at the VM's IP, and port 80 must be open. Check with `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy`. |
| Build killed on the 1 GB AMD VM | Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' \| sudo tee -a /etc/fstab` |
| Oracle emails that the instance is "idle" | Oracle can reclaim Always Free VMs that stay almost completely idle for 7 days. Daily use and the nightly backup usually avoid this. Upgrading the account to Pay-As-You-Go (still free if you stay inside the limits) removes the idle rule. |
| See logs | `docker compose logs -f api` |
