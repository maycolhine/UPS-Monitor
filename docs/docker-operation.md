# Docker operation

## 1. Requirements

- Docker Engine 24+ and Docker Compose v2 (`docker compose version`).
- Network access from the host to the telemetry API of the *UPS telemetry service*.

Installing Docker CE on Ubuntu (official repository — the commands with `sudo` are run by the
operator):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl        # curl is not installed by default on this host
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # requires a new login to take effect
```

If the terminal used in the current session does not yet have the `docker` group (the `usermod` only
takes effect on a new login), the same tasks can be done without logging out using:

```bash
sg docker -c "docker compose up --build -d"
```

## 2. Build and startup

```bash
cp .env.example .env        # adjust UPS_API_BASE_URL and, if desired, VIEWER_HTTP_PORT
docker compose up --build -d
```

> On the lab host the `.env` file already exists, with
> `UPS_API_BASE_URL=http://127.0.0.1:8080` and `VIEWER_HTTP_PORT=8090`. There is no need to recreate
> it.

The interface is available at `http://<host-ip>:8090` (or on the port defined in `VIEWER_HTTP_PORT`).

Day-to-day operations:

```bash
docker compose logs -f                 # follow the logs
docker compose ps                      # state + healthcheck
docker compose restart                 # restart without rebuild
docker compose up --build -d           # rebuild after changing code
docker compose down                    # stop and remove the container
docker compose build --no-cache        # clean rebuild
```

Quick check:

```bash
curl -s http://localhost:8090/healthz
# {"status":"ok","service":"ups-monitor-viewer","version":"1.0.0","read_only":true,"uptime_seconds":...}

curl -s http://localhost:8090/api/dashboard | head -c 400
```

## 3. Container ↔ API connectivity on the host

This is the point that causes the most errors. **Inside the container, `localhost` and `127.0.0.1`
point to the container itself** unless the container shares the host network — never to the Ubuntu
machine that has the USB cable.

| Scenario | `UPS_API_BASE_URL` | Requirement on the host |
|---|---|---|
| A | `http://host.docker.internal:8080` | API listening on `0.0.0.0` |
| B (**default**) | `http://127.0.0.1:8080` + `network_mode: host` | API listening on loopback |

> **The default is scenario B.** The *UPS telemetry service* is bound only to the host loopback
> (`http_host=127.0.0.1`), not to `0.0.0.0`. With `network_mode: host` the container shares the host
> network and reaches the API at `http://127.0.0.1:8080`; scenario A would only work by restarting the
> API with `--http-host 0.0.0.0`. Without host networking, `127.0.0.1` inside the container is the
> container itself, never the host.

The `compose.yaml` already includes:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

On Linux this is **not** automatic (unlike Docker Desktop), and that is why the line above exists. In
scenario A, start the API accepting connections from outside the loopback:

```bash
cd monitor
python3 scripts/run_api.py --http-host 0.0.0.0 --http-port 8080
```

Validate from inside the container:

```bash
docker compose exec ups-monitor-viewer node -e \
  "fetch(process.env.UPS_API_BASE_URL + '/health').then(r => console.log('HTTP', r.status)).catch(e => console.error('failed:', e.message))"
```

Or, more simply, query what the viewer itself publishes:

```bash
curl -s http://localhost:8090/api/dashboard | grep -o '"reachable":[a-z]*'
# "reachable":true  → the container reached the API
```

If `"error":{"code":"upstream_unreachable"` appears, the problem is network-related (address or
`--http-host`). If `"code":"upstream_timeout"` appears, the API is unreachable or slow: increase
`UPS_API_TIMEOUT_MS`.

See the effective configuration:

```bash
docker compose exec ups-monitor-viewer printenv | sort | grep -E 'UPS_|VIEWER_'
```

## 4. Environment variables

Documented in [.env.example](../.env.example) and in the [README](../README.md#6-configuration).

Behavior rules:

- A numeric variable out of range → the process exits with **code 2** and the message `invalid
  configuration: ...` appears in the log; Compose restarts the container (policy `unless-stopped`) and
  the error repeats — fix the `.env`.
- An empty `UPS_DEVICE_ID` (default) makes the viewer discover the device in `GET /api/v1/ups`. Pinning
  it reduces queries and is useful when there is more than one UPS unit.
- `VIEWER_GAUGE_THRESHOLDS` with invalid JSON does **not** bring down the service: the default bands
  remain in effect and the problem appears in `threshold_problems` (and as a notice in the interface).

## 5. Healthcheck

The image's `HEALTHCHECK` and the Compose one query `http://127.0.0.1:8080/healthz`, which answers for
the health of the **container itself** — not the telemetry API. Thus, a powered-off UPS unit does not
make Docker mark the service as sick nor restart the application.

```bash
docker inspect --format '{{.State.Health.Status}}' ups-monitor-viewer
# healthy | starting | unhealthy
```

To monitor the UPS unit, use `GET /api/dashboard` (field `viewer.upstream`) — that is the operational
information, separate from the container health.

## 6. Ports

| Port | Where | Note |
|---|---|---|
| `8080` | inside the container | Internal port of the viewer backend |
| `8090` | host (default) | Published by `VIEWER_HTTP_PORT`; avoids a conflict with the telemetry API |

Do not publish the host's `8080` port while the telemetry API is using it. To serve the dashboard on
the host's 8080, the API must change port (`--http-port 8081`) and `UPS_API_BASE_URL` must follow.

## 7. Update / remove

```bash
docker compose up --build -d      # update after changing the code
docker compose down               # stop and remove the container
docker image rm ups-monitor-viewer:1.0.0
docker builder prune              # clear the build cache, if necessary
```

The application does not store state: **there are no volumes**. The container can be removed and
recreated at any time without data loss.

## 8. Troubleshooting

| Symptom | Probable cause | Action |
|---|---|---|
| "Web Viewer service unreachable" banner | The container is stopped or the published port does not respond | `docker compose ps`, `docker compose logs -f` |
| "Telemetry API unavailable" banner with `upstream_unreachable` | Wrong `UPS_API_BASE_URL`, or the API listening only on loopback | On this host use loopback (`http://127.0.0.1:8080`); to use `host.docker.internal`, start the API with `--http-host 0.0.0.0` |
| `upstream_timeout` | Slow or unreachable API | Increase `UPS_API_TIMEOUT_MS`; check the network |
| `no_devices_configured` (404) | `GET /api/v1/ups` empty and `/health` without `device_id` | Set `UPS_DEVICE_ID` to the correct identifier |
| `device_not_found` (404) | `UPS_DEVICE_ID` is not the API identifier | Check in `GET /api/v1/ups` |
| Amber "Stale" indicator | Collector without a new reading for more than `stale_after_s` | Check the collection in the telemetry service (serial port, permissions) |
| "Gauge bands not yet validated" notice | `threshold_problems` is not empty | Review the `VIEWER_GAUGE_THRESHOLDS` JSON |
| Container restarting in a loop | Invalid configuration | `docker compose logs ups-monitor-viewer` and fix the `.env` |
| Interface loads but has no data | `VIEWER_STATIC_DIR` without the compiled interface | Use the official image; in dev, `vite build` must have run |

More detailed logs:

```bash
VIEWER_LOG_LEVEL=debug docker compose up -d
docker compose logs -f ups-monitor-viewer
```

## 9. Security

- The application is **read-only**: it does not send commands to the UPS unit nor write to the API.
- The container runs as the `node` user (not root).
- No secret, token or credential is used or versioned.
- The telemetry API does not offer authentication; the application must remain on the **local
  management network** and not be exposed to the internet (scope §2.3).

## 10. Validation performed

Evidence of the last full verification, on the lab host (Ubuntu 24.04, `127.0.0.1`), with Docker
Engine 29.9.2 and Compose v5.6.1:

| Verification | Command | Result |
|---|---|---|
| Image built | `docker compose build` | `ups-monitor-viewer:1.0.0` (multi-stage, build OK) |
| Container healthy | `docker compose ps` | `Up (healthy)` on `0.0.0.0:8090->8080/tcp` |
| Non-root user | `docker exec ups-monitor-viewer id` | `uid=1000(node)` |
| Container health | `curl localhost:8090/healthz` | `200 {"status":"ok",...,"read_only":true}` |
| Published config | `curl localhost:8090/api/config` | `200`, `base_url` = `http://127.0.0.1:8080` |
| Interface served | `curl localhost:8090/` | `200 text/html` + `/assets/index-*.js` and `*.css` |
| Palette in the bundle | compiled CSS inspection | `--brand:#ff3d03`, `--ink-strong:#000032`, `--surface:#ffffff` |
| Container → host (loopback address) | `docker exec ... fetch('http://127.0.0.1:18080/...')` | `200` |
| Container → host (`host.docker.internal`) | `docker exec ... fetch('http://host.docker.internal:18080/...')` | `200` |
| `127.0.0.1` is the container itself | `docker exec ... fetch('http://127.0.0.1:8080/healthz')` | `200` (viewer, **not** the API) |
| Origin API down | `curl localhost:8090/api/dashboard` | `502` `upstream_unreachable`, with `viewer.upstream.error` filled in and `/healthz` still `200` |

The automated tests (`npm test`, 103 cases) and the build (`npm run build`) are executed outside the
container; see [tests.md](./tests.md).
