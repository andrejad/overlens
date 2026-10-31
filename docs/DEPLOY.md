# Deploying Overlens

Overlens is one program: it serves the API and the web app, keeps its data in one SQLite file and makes its own
daily backups. There is no web server in front of it and no separate database to run. It is meant to run on the company VPN
(see "The VPN setup: cookies and proxies" at the end).

Pick one route:

| Route | Use it when |
|---|---|
| [Download and start](#download-and-start) | one person tries it on their own computer (Windows, macOS, Linux; REQ_DEPLOY_016) |
| [Linux with systemd](#linux-route-systemd) | you want a plain program on a Linux server (REQ_DEPLOY_003) |
| [Windows service](#windows-route) | the server is Windows (REQ_DEPLOY_004) |
| [Docker (Portainer / Docker Compose)](#docker-route-portainer-and-docker-compose) | you have a Docker host (REQ_DEPLOY_001, 002, 011) |
| [CapRover](#caprover-route) | you host apps with CapRover (REQ_DEPLOY_013) |
| [Kubernetes](#kubernetes-route) | you run a Kubernetes cluster (REQ_DEPLOY_014) |

Everything after the routes (first start, restoring a backup, upgrading, health checks) applies to all of them.

## Download and start

Each release has ready downloads (REQ_DEPLOY_016): `overlens-<version>-windows-x64.zip`, `-linux-x64` and `-linux-arm64`,
`-macos-arm64` (Apple Silicon) and `-macos-x64` (Intel) as `.tar.gz`, with a `SHA256SUMS` file to check them. Unpack one
into a folder of its own and start the program in it (`overlens.exe` by double-click on Windows, `./overlens` in a terminal
on macOS and Linux); `START-HERE.txt` in the archive says the same, including the warnings Windows and macOS show for a
program that is not signed.

The archive carries a ready `overlens.conf` (`deploy/overlens.conf` in the repository) with every setting filled in and
explained: admin `admin` with the password `admin`, port 8080, the sample company, the AI connection on, daily backups at
04:00 kept 10 days, and everything the program writes in `overlens-data/` beside it (`db/`, `logs/`, `backups/`). Change
the password right after the first login. When the program has started, its window ends with a framed message giving the
address to open, `http://localhost:8080` (REQ_DEPLOY_017). To move such a trial to a server, copy the whole folder, or
follow one of the routes below.

Maintainers build all downloads with `make release-files` (into `dist/release/`, needs Go, Node and Python 3) and upload
them to the GitHub release.

## Configuration in one page

The program reads `overlens.conf` (see `overlens.conf.example`, every key is explained there). Any key can be set with an
environment variable instead: `OVERLENS_` plus the key in capitals (`OVERLENS_PORT=9000`); the variable wins over the file.
The container is configured only with variables. Changes need a restart.

New keys with the Phase 8 release:

| Key | Values | Meaning |
|---|---|---|
| `environment` | `production` (default), `development` | `development` only unlocks the development data loader (`make dev-data`). Never set it on a server |
| `cookie_secure` | `auto` (default), `true` | `auto`: the session cookie gets `Secure` only when the request itself arrived over TLS. `true`: always `Secure`. Use `true` when a proxy ends HTTPS in front of the app (for example CapRover) |
| `sample_data` | `true` (default), `false` | `true` creates a small sample company once, on the first start of an empty database |
| `mcp_enabled` | `false` (default), `true` | `true` switches on the read-only AI connection at `/mcp` (see "Connecting AI apps" below). Off, `/mcp` answers `404` |

`OVERLENS_BOOTSTRAP_ADMIN_PASSWORD_FILE` can name a file holding the first admin's password (trailing line breaks are removed; the file must hold nothing else), instead of putting
the password in `OVERLENS_BOOTSTRAP_ADMIN_PASSWORD`.

## Linux route (systemd)

Needs a Linux server with systemd. `make build-linux` builds the program on any machine with Go and Node.

```
make build-linux
```

This writes `dist/overlens`, the Linux program, with the
frontend embedded and the version, build time and commit stamped in (see "Versions"). `./dist/overlens -version` prints them.

Install, as root (or with `sudo`) on the server, with the built `overlens` and the repository's `deploy/overlens.service`
copied over:

```
useradd --system --home-dir /var/lib/overlens --shell /usr/sbin/nologin overlens
install -d -o overlens -g overlens -m 750 /var/lib/overlens /var/log/overlens /var/backups/overlens
install -d -m 755 /opt/overlens /etc/overlens
install -m 755 dist/overlens /opt/overlens/overlens
install -m 640 -o root -g overlens overlens.conf.example /etc/overlens/overlens.conf
install -m 644 deploy/overlens.service /etc/systemd/system/overlens.service
```

Edit `/etc/overlens/overlens.conf`. Use absolute paths, because relative ones resolve against `/etc/overlens`:

```
bootstrap_admin_user: admin
bootstrap_admin_password: choose-a-long-password
db_path: /var/lib/overlens/overlens-database.db
log_dir: /var/log/overlens
backup_dir: /var/backups/overlens
```

The file holds a password, so it is readable only by root and the `overlens` group (set above by `-m 640`). Then:

```
systemctl daemon-reload
systemctl enable --now overlens
systemctl status overlens
journalctl -u overlens -f
curl http://localhost:8080/health
```

The program listens on all interfaces on the port in the config. To keep it to the VPN, close the port to everything else in
the server's firewall, or put the VPN address in front of it with a firewall rule; the program has no bind-address setting.

## Windows route

`make build-windows` (run on Linux, macOS or WSL) builds `overlens.exe` with the frontend embedded and the version stamped in.
Copy these to the Windows server:

- `overlens.exe` into `C:\Program Files\Overlens\`
- `overlens.conf.example` as `C:\ProgramData\Overlens\overlens.conf`
- [NSSM](https://nssm.cc) (`nssm.exe`), because `overlens.exe` is an ordinary console program and does not speak the Windows
  service protocol. `sc.exe create` on its own would make a service that Windows kills after 30 seconds (error 1053).
  NSSM runs the program as a service, and `sc.exe` then manages that service.

Edit `C:\ProgramData\Overlens\overlens.conf` in Notepad with absolute paths (a backslash is fine; so is a forward slash):

```
bootstrap_admin_user: admin
bootstrap_admin_password: choose-a-long-password
db_path: C:\ProgramData\Overlens\data\overlens-database.db
log_dir: C:\ProgramData\Overlens\logs
backup_dir: D:\OverlensBackups
```

Run in an Administrator PowerShell. First a service account with no other rights, and the folders it may write:

```
$pw = Read-Host -AsSecureString "Password for the service account"
New-LocalUser -Name svc-overlens -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
New-Item -ItemType Directory C:\ProgramData\Overlens\data, C:\ProgramData\Overlens\logs, D:\OverlensBackups -Force
icacls "C:\ProgramData\Overlens" /grant "svc-overlens:(OI)(CI)M" /T
icacls "D:\OverlensBackups" /grant "svc-overlens:(OI)(CI)M"
icacls "C:\Program Files\Overlens" /grant "svc-overlens:(OI)(CI)RX"
```

Install and start the service (the working folder is the program's own folder; `AppParameters` points it to the config):

```
nssm install Overlens "C:\Program Files\Overlens\overlens.exe"
nssm set Overlens AppDirectory "C:\Program Files\Overlens"
nssm set Overlens AppParameters "-config C:\ProgramData\Overlens\overlens.conf"
nssm set Overlens ObjectName ".\svc-overlens" "<the account's password>"
nssm set Overlens Start SERVICE_AUTO_START
nssm set Overlens AppExit Default Restart
nssm set Overlens AppStdout C:\ProgramData\Overlens\logs\service.out.log
nssm set Overlens AppStderr C:\ProgramData\Overlens\logs\service.err.log
sc.exe description Overlens "Overlens"
sc.exe start Overlens
sc.exe query Overlens
```

NSSM stops the program with Ctrl+C, which it handles as a graceful shutdown. If the service will not start with error 1069
(logon failure), open Local Security Policy, Local Policies, User Rights Assignment, "Log on as a service" and add
`svc-overlens`. Check `http://localhost:8080/health` in a browser. Allow the port in Windows Firewall only for the VPN
network profile or address range.

To remove it: `sc.exe stop Overlens` then `nssm remove Overlens confirm`.

## Docker route (Portainer and Docker Compose)

Files: `Dockerfile`, `.dockerignore`, `docker-compose.yml` in the repository root.

The image has three build stages (Node builds `web/`, Go builds the program with the frontend embedded, a distroless image
runs it). It runs as the non-root user 65532, has the volumes `/data` (database and logs) and `/backups`, and listens on
port 8080 inside the container.

### Prepare the host

Use absolute paths. The compose file explains why at its top: a relative path may be resolved against a temporary folder by
Portainer and the database would be lost on the next deploy.

```
sudo mkdir -p /srv/overlens/data /srv/overlens/backups /srv/overlens/config
sudo chown 65532:65532 /srv/overlens/data /srv/overlens/backups
```

Put the first admin's password in a file, one line, no quotes, readable by the container user (it is mounted read-only):

```
printf '%s\n' 'choose-a-long-password' | sudo tee /srv/overlens/config/admin_password > /dev/null
sudo chown 65532:65532 /srv/overlens/config/admin_password
sudo chmod 400 /srv/overlens/config/admin_password
```

The whole file is the password, minus trailing line breaks; if the first login fails, check that the file holds nothing else.

### With Docker Compose

Create a file `.env` beside `docker-compose.yml`:

```
VPN_BIND_ADDRESS=10.8.0.5
DATA_DIR=/srv/overlens/data
BACKUP_DIR=/srv/overlens/backups
CONFIG_DIR=/srv/overlens/config
BOOTSTRAP_ADMIN_USER=admin
```

`VPN_BIND_ADDRESS` is the host's address on the VPN interface (`ip -4 addr` shows it). It has no default on purpose: without
it `docker compose` stops with an error, so the app is never published on all interfaces by accident. Then:

```
docker compose config        # prints the resolved file; check the ports and paths
docker compose up -d --build
docker compose logs -f overlens
```

Open `http://<VPN_BIND_ADDRESS>:8080`.

### With Portainer

1. Stacks, Add stack, "Repository" (or paste `docker-compose.yml` into the web editor, but then Portainer cannot build the
   image: build it first on the host with `docker build -t overlens .` and add `IMAGE=overlens:latest`).
2. In "Environment variables" set `VPN_BIND_ADDRESS`, `DATA_DIR`, `BACKUP_DIR`, `CONFIG_DIR` and `BOOTSTRAP_ADMIN_USER` as in
   the `.env` above.
3. Deploy the stack. Restart policy is `unless-stopped` (set in the file).

### Version stamp

`docker build -t overlens --build-arg VERSION=$(make -s version) --build-arg COMMIT=$(git rev-parse --short HEAD) --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) .`
stamps the version, commit and build time into the program. Without `--build-arg VERSION` (as on CapRover, which builds
from the files alone) the `VERSION` file in the repository is used. They show in the first lines of the log
(`docker compose logs overlens`), in `GET /health` (the version) and on the admin screen.

### Where things are

| In the container | On the host | Holds |
|---|---|---|
| `/data` | `DATA_DIR` | `overlens-database.db` (plus `overlens-database.db-wal` and `overlens-database.db-shm` while running) and `logs/` |
| `/backups` | `BACKUP_DIR` | `overlens-YYYY-MM-DD.db`, one per day, the newest 10 kept |
| `/config` (read-only) | `CONFIG_DIR` | `admin_password`, optionally `overlens.conf` |

Keep `BACKUP_DIR` on a different disk from `DATA_DIR` if you can; a backup next to the database does not survive a dead disk.

## CapRover route

Runs the same Dockerfile: the repository's `captain-definition` tells CapRover to build with `./Dockerfile`.

In the CapRover dashboard, create an app (for example `overlens`), tick "Has persistent data", then:

1. **HTTP Settings.** Set "Container HTTP Port" to `8080` (CapRover's default is 80). Enable HTTPS and tick "Force HTTPS by
   redirecting all HTTP traffic to HTTPS" after you have attached the domain (Enable HTTPS on the app's domain; CapRover gets
   the certificate from Let's Encrypt).
2. **App Configs, Persistent Directories.** Add `/data` (label `overlens-data`) so the database survives deploys. Add
   `/backups` (label `overlens-backups`) as well. The sample, logs and database live in `/data`.
3. **App Configs, Environment Variables:**

   ```
   OVERLENS_BOOTSTRAP_ADMIN_USER=owner
   OVERLENS_BOOTSTRAP_ADMIN_PASSWORD=<a long random password>
   OVERLENS_COOKIE_SECURE=true
   OVERLENS_SAMPLE_DATA=false
   ```

   `OVERLENS_COOKIE_SECURE=true` is needed because CapRover ends HTTPS at its proxy, so the app sees plain HTTP and would
   otherwise send the session cookie without `Secure`. `OVERLENS_SAMPLE_DATA=false` starts with an empty roadmap; leave it out
   (the default is `true`) to get the small sample company on the first start.
4. **Deployment.** From a checkout of the repository, with the CapRover CLI (`npm install -g caprover`):

   ```
   caprover deploy
   ```

   and answer the questions (server, app name). Or use "Deploy via ImageName" with an image you built and pushed yourself, or
   the Git webhook method in the Deployment tab; all three use the same `Dockerfile`.
5. **Health check path.** The path is `/health` (answers `200 {"status":"ok","version":"<version>"}`, no login). See "Health checks" below for what
   CapRover can and cannot do with it; point an uptime monitor at `https://<your domain>/health`.

**Accepted risk: the shared login lockout.** The app does not trust `X-Forwarded-For` (otherwise anyone could fake an
address and dodge the lockout). Behind CapRover's proxy every visitor therefore arrives from the proxy's address and shares
one lockout counter: five failed logins by anyone lock all logins for 15 minutes (REQ_AUTH_011/017). Readers, who need no
login, are not affected. A restart clears the lockout (it is held in memory).

## Kubernetes route

Uses the same image as the Docker route: build it as in "Version stamp" and push it to a registry the cluster can pull from.
The app keeps its data in one SQLite file, so **run exactly one replica** with the `Recreate` strategy: two pods on one
database would corrupt it, and a rolling update briefly runs two. There is no scaling out; the one pod is the server.

Save this as `overlens.yaml`, replace the image and the password, and run `kubectl apply -f overlens.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: overlens
---
apiVersion: v1
kind: Secret
metadata:
  name: overlens-admin
  namespace: overlens
stringData:
  password: choose-a-long-password
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: overlens-data
  namespace: overlens
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: overlens-backups
  namespace: overlens
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overlens
  namespace: overlens
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: overlens
  template:
    metadata:
      labels:
        app: overlens
    spec:
      securityContext:
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
      containers:
        - name: overlens
          image: registry.example.com/overlens:1.0.0
          ports:
            - containerPort: 8080
          env:
            - name: OVERLENS_BOOTSTRAP_ADMIN_USER
              value: admin
            - name: OVERLENS_BOOTSTRAP_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: overlens-admin
                  key: password
          volumeMounts:
            - name: data
              mountPath: /data
            - name: backups
              mountPath: /backups
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 20
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: overlens-data
        - name: backups
          persistentVolumeClaim:
            claimName: overlens-backups
---
apiVersion: v1
kind: Service
metadata:
  name: overlens
  namespace: overlens
spec:
  selector:
    app: overlens
  ports:
    - port: 80
      targetPort: 8080
```

Check it with `kubectl -n overlens rollout status deploy/overlens` and `kubectl -n overlens logs deploy/overlens`. To try it
from your machine: `kubectl -n overlens port-forward svc/overlens 8080:80`, then open `http://localhost:8080`.

- **Keep it on the VPN.** The Service is `ClusterIP`, so it is reachable only inside the cluster. Expose it to the VPN with
  an internal Ingress or an internal load balancer, never a public one.
- **TLS at the ingress.** If the ingress ends HTTPS, add the variable `OVERLENS_COOKIE_SECURE=true` (see "The VPN setup:
  cookies and proxies"). Behind the ingress everybody also shares one login lockout, as with CapRover.
- **Backups.** They go to the second volume, which is often on the same storage system as the first. Copy `/backups` off the
  cluster (a `CronJob`, or your storage's snapshots) if you need to survive losing that storage.
- **Restoring** follows "Restoring a backup by hand": scale down with `kubectl -n overlens scale deploy/overlens --replicas=0`,
  replace the database on the data volume from a temporary pod that mounts it (delete the `-wal` and `-shm` files, keep
  owner 65532), then scale up with `--replicas=1`.
- **Upgrading:** push a new image tag, change `image:` and apply again. `Recreate` stops the old pod before the new one starts.

## First start and the bootstrap admin

On the first start the program creates the database, creates the first admin from `bootstrap_admin_user` and
`bootstrap_admin_password` (or the `_FILE` variant), and, unless `sample_data` is `false`, the small sample company. It logs
each step. Both bootstrap settings are required and have no defaults; without them the program prints one error line and exits.

- The bootstrap admin is created **only when there are no users**. On every later start the two settings must still be present
  (the program checks the config first) but they are ignored. Changing the password there changes nothing.
- Log in at `http://<address>:8080`, then change the password in the app's user administration. Add other admins there too.
- The sample company is created once. Once it has been created, or once any team or roadmap exists, it is never created again,
  and nothing ever overwrites existing data. Edit or delete it like any other data.

## Health checks

`GET /health` answers `200 {"status":"ok","version":"<version>"}` without a login and without touching sessions, and `503` when the database cannot
be read.

- Linux and Windows: `curl http://localhost:8080/health`.
- Docker: the distroless image has no shell, `curl` or `wget`, so the image's `HEALTHCHECK` and the compose `healthcheck`
  run the program itself: `/app/overlens -healthcheck` asks `http://127.0.0.1:<port>/health` (the configured port), prints
  nothing and exits 0 on `200`, and otherwise prints one line to stderr and exits 1. `docker ps` shows `healthy` once it passes.
- Kubernetes: the Deployment's readiness and liveness probes call `/health` over HTTP.

## Restoring a backup by hand

The program makes `overlens-YYYY-MM-DD.db` in the backup folder every day (at `backup_time`) and keeps the newest
`backup_keep_days`. It never restores one by itself. To go back to a backup:

1. Stop the program (`systemctl stop overlens`, `sc.exe stop Overlens`, `docker compose stop overlens`, or scale the Kubernetes
   Deployment to 0).
2. Keep what is there: copy `overlens-database.db` somewhere else (and `overlens-database.db-wal` if present).
3. Copy the chosen backup over the database file, named `overlens-database.db`.
4. **Delete `overlens-database.db-wal` and `overlens-database.db-shm`** next to it. They belong to the old database; leaving them can corrupt the
   restored one.
5. Make sure the file belongs to the service user (`chown overlens:overlens` on Linux, `chown 65532:65532` for Docker; on Windows
   the account `svc-overlens` needs Modify rights).
6. Start the program and check the log and `/health`.

Example for Docker with the paths above:

```
docker compose stop overlens
cp /srv/overlens/data/overlens-database.db /srv/overlens/overlens-database.db.before-restore
cp /srv/overlens/backups/overlens-2026-10-01.db /srv/overlens/data/overlens-database.db
rm -f /srv/overlens/data/overlens-database.db-wal /srv/overlens/data/overlens-database.db-shm
chown 65532:65532 /srv/overlens/data/overlens-database.db
docker compose start overlens
```

Changes made after the backup's date are lost. Sessions are part of the database, so people who logged in after that date
have to log in again.

## Versions

Every build says which version it is: `overlens -version`, the first line of the log, `GET /health` and the admin
screen's Storage section. `make version` prints the version a build from this checkout gets: the release tag (`v1.2.0`
gives `1.2.0`; a later commit reads like `1.2.0-3-gabc1234`, uncommitted changes add `-dirty`), or the `VERSION` file
where there is no tag or no git (REQ_DEPLOY_010).

Versions follow Semantic Versioning (REQ_DEPLOY_015): the **major** number goes up when something you depend on breaks
(an API contract, a config setting, or a database the new version can no longer open; read the release notes before such
an upgrade), the **minor** number for new features, the **patch** number for fixes. Within one major version an upgrade
needs nothing but the steps below, since database upgrades only add.

**Making a release** (maintainers): set `VERSION` to `X.Y.Z`, rename `CHANGELOG.md`'s `[Unreleased]` section to `[X.Y.Z] — date`, build the downloads (`make release-files`), commit, tag `vX.Y.Z` and push the tag;
publish the GitHub release with the downloads; then set `VERSION` to the next planned version with `-dev` (e.g. `1.3.0-dev`) and commit.

## Upgrading

1. Back up. The newest file in the backup folder is a good copy, but the safest is to stop the program and copy `overlens-database.db`
   (`overlens.db` on an installation from before the rename, see step 5)
   (see "Restoring a backup by hand").
2. Replace the program:
   - Linux: `make build-linux`, then `systemctl stop overlens`, `install -m 755 dist/overlens /opt/overlens/overlens`,
     `systemctl start overlens`.
   - Windows: `make build-windows`, `sc.exe stop Overlens`, replace `overlens.exe`, `sc.exe start Overlens`.
   - Docker: `git pull`, then `docker compose up -d --build`. The old container is replaced, the data stays in `DATA_DIR`.
   - Kubernetes: push a new image tag, change `image:` in `overlens.yaml`, `kubectl apply -f overlens.yaml`.
3. Database upgrades run on start and are logged. If a start fails, the log says why; restore the backup from step 1 and start
   the previous program.
4. New config keys have defaults, so an old `overlens.conf` keeps working. A key the program does not know is an error, so do
   not copy a newer `overlens.conf` onto an older program.
5. **The files were renamed from "roadmap" to "overlens"** (2026-10-31). The program reads only the new names and never
   renames or deletes anything itself; an installation that keeps the old names starts on an **empty database** (the old
   file stays untouched beside it). Before the first start of the new program, stop the old one and rename:
   `roadmap` / `roadmap.exe` to `overlens` / `overlens.exe`, `roadmap.conf` to `overlens.conf`, `roadmap-database.db`
   to `overlens-database.db` (remove `roadmap-database.db-wal` and `roadmap-database.db-shm` first, after copying the
   database somewhere safe), and the backups `roadmap-YYYY-MM-DD.db` to `overlens-YYYY-MM-DD.db` (until then the daily
   pruning does not see them). The `ROADMAP_*` environment variables keep working and log a warning; `OVERLENS_*` wins
   when both are set. Service names, folders and users in this guide changed the same way, but an existing service can
   keep its old name. An installation that sets `db_path` (or `OVERLENS_DB_PATH`) to some other name is not affected.

## The VPN setup: cookies and proxies

The app is meant for an internal VPN, and plain HTTP behind the VPN is the expected setup. Two things follow, and both are
accepted trade-offs:

- **Session cookie.** It is `HttpOnly` and `SameSite=Lax`, and `Secure` only when the request itself arrived over TLS.
  `X-Forwarded-Proto` is not trusted. Over plain HTTP on the VPN the cookie is sent without `Secure`, which is the intended
  `cookie_secure: auto` behaviour. If you put a TLS-terminating proxy in front, either accept the same, or set
  `cookie_secure: true` (`OVERLENS_COOKIE_SECURE=true`) so the cookie is always `Secure`. With `true` the browser sends the
  cookie only over HTTPS, so logging in over plain HTTP no longer works.
- **Login lockout and proxies.** Five failed logins from one address, or against one username, lock logins for 15 minutes.
  The address is the connection's, never `X-Forwarded-For`. Behind a reverse proxy everybody arrives from the proxy's address
  and shares one lock: five failures by anyone lock the address for everyone for 15 minutes. Without a proxy (the Docker setup
  above publishes the port directly) each machine has its own address.

`docker-compose.yml` publishes the port on the VPN interface address only. If the host's firewall or routing makes the VPN
address reachable from outside the VPN, the app is reachable from there too; check it from a machine outside the VPN.

## Connecting AI apps (optional)

The app can answer AI assistants (Claude Code, Claude Desktop, other apps that speak MCP over HTTP) through a read-only
endpoint at `/mcp`. It is **off** until your organisation decides to offer it: set `mcp_enabled: true`
(`OVERLENS_MCP_ENABLED=true`) and restart. The start-up log says whether it is on.

- It only reads and shows exactly what an anonymous visitor sees: no users, audit log, backups or settings. No login,
  no token.
- Descriptions, risk notes and link labels are free text typed by people; the AI reads them as part of its context. The
  worst a crafted text can do is mislead an answer, never change data.
- A request sent from a web page on another site is refused `403`. That does not protect against DNS rebinding, which the
  anonymous `GET /api/...` reads are equally open to; on the VPN this is the accepted setup.
- Links in AI answers use `https` when the request arrived over TLS or the proxy sends `X-Forwarded-Proto: https`
  (for these links only; the session cookie rule above is unchanged).
- How people connect their assistant, and the read-only `GET /api/company/attention` list for scripts and dashboards
  (available whether or not `/mcp` is on): `docs/API-USAGE.md`, "AI and App Integration". Claude Desktop needs the small
  `mcp-remote` bridge (Node.js on the user's computer), because a connector added on claude.ai cannot reach a server
  that only exists on the VPN.

## Notes for whoever maintains these instructions

- `make build-linux` and `make build-windows` write `dist/overlens` and `dist/overlens.exe` (the Makefile is the reference).
