# Dahua Bridger Cloud Backend

Cloud-to-cloud integration between **Google Home** and the **Dahua Bridger Android TV app**.

The backend is a single self-contained Node/Express server:
- **Device registration** — the TV app pairs and pushes its discovered camera channels.
- **Google Home fulfillment** (`POST /google-fulfillment`) — SYNC / QUERY / EXECUTE for the `action.devices.traits.CameraStream` trait.
- **OAuth 2.0 authorisation server** (`/oauth/authorize`, `/oauth/token`) used for Google Home account linking.

## Why it works the way it does

The XVR and the TV live on your LAN. A Google Home device that is **on the same local network** (phone with the Google Home app, Nest Hub, Chromecast-capable display) receives the **LAN RTSP URL** of a channel and plays it directly. This avoids transcoding and public media relay infrastructure.

> If your Google Home device is not on the same LAN as the XVR, stream playback will fail. A public HLS relay is outside the scope of this bridge.

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `BRIDGE_SECRET` | yes (prod) | `changeme-bridge-secret` | Shared secret used by the TV app to pair and by the OAuth login page to link accounts. **Set a strong value before exposing publicly.** |
| `PORT` | no | `3000` | HTTP port. |
| `STORE_FILE` | no | `./store.json` | Where devices/tokens persist (not used on read-only filesystems like some serverless hosts). |
| `ALLOWED_REDIRECT_URIS` | no | any `https://` or `http://localhost` | Comma-separated allow-list for OAuth redirect URIs. |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | no | any | One client id/secret pair accepted for `/oauth/token`. |
| `OAUTH_CLIENT_IDS` / `OAUTH_CLIENT_SECRETS` | no | any | Comma-separated lists (index-aligned) for multiple clients. |

## Local testing

```sh
npm install
BRIDGE_SECRET=my-secret npm start
```

Service is now at `http://localhost:3000`. Use `ngrok http 3000` (or a tunnel) to expose it publicly with HTTPS for testing webhooks.

## Deploying

Needs a platform that runs Node and gives you an **HTTPS URL** (required for Google Home). Good free/cheap options: **Render**, **Railway**, **Fly.io**, **Glitch**, **Vercel** (serverless), **Cloud Run** (container), **AWS Elastic Beanstalk**, or a VPS with Nginx + certbot. See `docs/cloud-setup-howto.md` in the repo root for the full guide.

For read-only filesystems (Vercel, Cloud Run, Heroku without a persistent disk), either reuse a mounted volume for `STORE_FILE` or set `STORE_FILE` to a writable path. On restart without persistence, simply re-run the TV app pairing.

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | – | Health check. |
| POST | `/api/devices/register` | body `{ secret }` | TV app pairs + registers channels. Returns `{ deviceId, bridgeToken }`. |
| POST | `/api/devices/channels` | `Authorization: Bearer <bridgeToken>` | TV app updates its channels. |
| GET | `/api/devices` | Bearer | List devices + channels for the linked home. |
| GET | `/oauth/authorize` | – | Account linking login page. |
| POST | `/oauth/authorize/decision` | – | Validates secret, redirects with code/token. |
| POST | `/oauth/token` | client creds / body | Access + refresh token exchange. |
| POST | `/google-fulfillment` | – | Google Home Smart Home fulfillment. |