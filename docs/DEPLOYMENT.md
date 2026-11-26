# Deployment

This guide deploys the cloud app to an Oracle Cloud VM with Docker Compose and
Cloudflare Tunnel. It assumes a fresh Ubuntu 24.04 LTS host.

> **Status:** the image is built in CI, but the steps below were not executed
> against a real Oracle account during development. Verify each step, especially
> DNS, TLS, restore and the real yt-dlp engine, before inviting users.

## 1. Choose the VM

Recommended starting point:

- **Shape:** `VM.Standard.A1.Flex` (Ampere/arm64), 2 OCPU, 12 GB RAM (or 1 OCPU,
  6 GB for a very small group).
- **Boot volume:** 50–100 GB. Media is deleted after retention, but a large ZIP or
  several concurrent jobs needs headroom.
- **OS:** Canonical Ubuntu 24.04 (aarch64).
- **Networking:** public IPv4, ingress only SSH (22/tcp) from your own address.
  Do **not** open 4174, 80 or 443; Cloudflare Tunnel is outbound-only.

If you use an x86 shape, the Dockerfile automatically selects the x86_64 yt-dlp
asset. No change is needed.

## 2. First login and updates

```bash
ssh ubuntu@<your-vm-public-ip>

sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg git ufw
```

Set the hostname and timezone (optional):

```bash
sudo hostnamectl set-hostname snagly
sudo timedatectl set-timezone UTC
```

## 3. Firewall

Oracle has two layers: the VCN security list and the host firewall.

In the OCI console, edit the VCN security list / network security group:

- Allow `22/tcp` from your own IP only.
- Remove or do not add `80`, `443` and `4174` ingress rules.
- Allow all egress (needed for YouTube, GitHub, Cloudflare and package updates).

On the host:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status verbose
```

## 4. Install Docker Engine and Compose

Use Docker's official apt repository:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"
newgrp docker

docker version
docker compose version
```

## 5. Clone and configure

```bash
sudo mkdir -p /opt/snagly
sudo chown "$USER":"$USER" /opt/snagly
git clone https://github.com/whif-fler/Snagly.git /opt/snagly
cd /opt/snagly
git checkout v2.0.0   # or the latest release tag

cp .env.example .env
chmod 600 .env
```

Generate a signing secret and edit `.env`:

```bash
openssl rand -base64 48
nano .env
```

Required values:

```dotenv
SNAGLY_PUBLIC_ORIGIN=https://snagly.example.com
SNAGLY_ALLOWED_HOSTS=snagly.example.com
SNAGLY_DOWNLOAD_SECRET=<paste the generated secret>
SNAGLY_TRUST_PROXY=true
SNAGLY_SECURE_COOKIES=true
SNAGLY_RETENTION_HOURS=24
```

Do not put the secret in Git, shell history, chat or screenshots. `.env` is
gitignored and mode `600`.

## 6. Build and start

```bash
cd /opt/snagly
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 snagly
```

Check the health endpoint from the VM:

```bash
curl -fsS http://127.0.0.1:4174/healthz
```

Expected JSON includes `"ok":true`, the version and the engine.

The service binds only to `127.0.0.1:4174`. That is intentional; do not change it
to `0.0.0.0`.

## 7. Cloudflare Tunnel

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels**.
2. Create a tunnel (Cloudflared), name it `snagly`.
3. Add a public hostname:
   - **Subdomain/domain:** `snagly.example.com`
   - **Service:** `http://snagly:4174`
4. Copy the tunnel token.
5. Add it to `.env`:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=<token>
```

6. Start the optional tunnel profile:

```bash
cd /opt/snagly
docker compose --profile tunnel up -d
docker compose logs --tail=100 cloudflared
```

7. Confirm DNS and TLS:

```bash
curl -fsS https://snagly.example.com/healthz
```

Cloudflare creates the DNS record for the tunnel hostname. Keep the Cloudflare
SSL/TLS mode at **Full** or **Full (strict)**; the tunnel carries traffic to the
container over the private Compose network.

### Optional authentication

The app uses anonymous sessions. For a public instance, add **Cloudflare Access**
in front of the hostname and allow only the people who should use it. Without an
identity-aware proxy, anyone who reaches the URL gets a new anonymous library.

## 8. Verify the deployment

```bash
cd /opt/snagly
docker compose ps
curl -fsS https://snagly.example.com/healthz

# Check the container is not root and tools are present:
docker compose exec snagly id
docker compose exec snagly /usr/local/bin/yt-dlp --version
docker compose exec snagly ffmpeg -version | head -n 1

# Inspect the persistent volume:
docker compose exec snagly ls -la /data
```

Then in a browser:

1. Open `https://snagly.example.com`.
2. Preview a short public playlist.
3. Download one track with the real engine.
4. Save it to a folder (Chromium) or download the ZIP (any browser).
5. Open `/privacy` and confirm the cloud policy is shown.
6. Open the same URL in a private window and confirm the second session sees an
   empty library.

## 9. Backups

Backups stop the app briefly so SQLite and files are consistent.

```bash
cd /opt/snagly
./scripts/backup.sh
ls -lh backups/
```

Copy backups off the VM (OCI Object Storage, rsync, restic, etc.). A backup that
only exists on the same disk is not a backup.

To restore (this **replaces all current cloud data**):

```bash
cd /opt/snagly
FORCE=1 ./scripts/restore.sh backups/snagly-data-YYYYMMDDTHHMMSSZ.tar.gz
curl -fsS http://127.0.0.1:4174/healthz
```

Both scripts use `docker compose` and the `snagly-data` volume. They require the
Compose project to exist on the host.

## 10. Updates

Take a backup first. Migrations are forward-only.

```bash
cd /opt/snagly
./scripts/backup.sh
git fetch --tags
git checkout v2.x.y
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 snagly
curl -fsS https://snagly.example.com/healthz
```

The container is replaced; the named volume keeps the database and media.

## 11. Rollback

Application rollback:

```bash
cd /opt/snagly
git checkout <previous-tag>
docker compose build
docker compose up -d
```

If the newer release applied a database migration that the older code cannot
read, restore the backup taken before the upgrade:

```bash
cd /opt/snagly
FORCE=1 ./scripts/restore.sh backups/snagly-data-<timestamp>.tar.gz
```

Keep the previous image tag and a recent backup until you have verified the new
release.

## 12. Common operations

### Change retention or limits

Edit `.env`, then recreate the container:

```bash
docker compose up -d
```

Cleanup runs on its interval (`SNAGLY_CLEANUP_MINUTES`, default 10). Existing
jobs keep their current expiry until refreshed; new terminal jobs use the new
retention.

### Rotate the signing secret

```bash
openssl rand -base64 48
# update SNAGLY_DOWNLOAD_SECRET in .env
docker compose up -d
```

Existing download links stop working. Sessions remain valid.

### Revoke all sessions

```bash
docker compose exec snagly node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/snagly.sqlite');
  db.exec('DELETE FROM sessions');
  db.close();
  console.log('all sessions revoked');
"
```

This logs everyone out. It does not delete jobs or media.

### Clear one user's data

There is no admin UI. Use **Remove** in that user's library, or stop the app and
operate on `/data` deliberately. Do not delete another user's files by hand
unless you understand the directory layout.

## 13. Resource sizing

- `SNAGLY_GLOBAL_CONCURRENCY` controls simultaneous yt-dlp/FFmpeg processes.
  4 is a reasonable start on 2 OCPU / 12 GB.
- `SNAGLY_USER_CONCURRENCY` should stay below the global limit.
- Audio jobs are usually light; 4K video and FLAC are CPU/disk heavy.
- `SNAGLY_MAX_FILE_MB` and `SNAGLY_MAX_JOB_MB` protect disk. A ZIP is streamed,
  but the source files still occupy disk.
- Compose limits the container to `${SNAGLY_MEM_LIMIT:-1g}` and
  `${SNAGLY_CPUS:-1.5}`. Raise them if FFmpeg is killed under load.
- Keep at least 20% disk free; SQLite WAL and thumbnails need headroom.

## 14. Troubleshooting

**`healthz` fails inside the container**

```bash
docker compose logs --tail=200 snagly
docker compose exec snagly ls -la /data
```

Common causes: `.env` has an invalid integer, the data directory is not writable,
or the port is already in use on the host.

**Cloudflare returns 502/1033**

The tunnel cannot reach `snagly:4174`. Check `docker compose ps`, the tunnel
public hostname service URL, and `docker compose logs cloudflared`.

**`Host not allowed` (421)**

`SNAGLY_ALLOWED_HOSTS` or `SNAGLY_PUBLIC_ORIGIN` does not match the hostname in
the browser's address bar. Both should be the public hostname, without a path.

**Login/session resets every request**

`SNAGLY_SECURE_COOKIES=true` requires HTTPS. If you are testing over plain HTTP on
a remote host, use an SSH tunnel or set it to `false` only for local testing.

**Downloads fail with a YouTube sign-in check**

Cloud mode deliberately does not use personal cookies. Update the pinned
`YTDLP_VERSION`, rebuild, and consider a different egress IP if YouTube blocks the
VM. Do not copy personal cookies onto a shared server.

**Disk fills up**

Lower `SNAGLY_RETENTION_HOURS`, reduce job/file limits, check for failed jobs with
partial files, and inspect `/data/users`. Cleanup skips active jobs by design.

**Container restarts during a job**

Interrupted tracks are requeued on startup. Check logs for OOM kills; raise
`SNAGLY_MEM_LIMIT` or lower concurrency.

## 15. Uninstall

Destructive. Back up first if you need the data.

```bash
cd /opt/snagly
docker compose --profile tunnel down
docker volume rm snagly-data
cd /
rm -rf /opt/snagly
```

This removes the database, media, secrets and the local `.env`. Cloudflare DNS
and the tunnel must be deleted in the Cloudflare dashboard.
