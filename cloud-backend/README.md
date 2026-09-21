# Connecting Google Home — Step-by-Step Guide

This guide walks you through everything needed to control your Dahua XVR cameras through
**Google Home**, using the Android TV to get the RTSP streams to the cloud.

---

## What happens under the hood

```
Android TV (app) ──pairs via /api/devices/register──▶ Cloud backend
                                                        │
   Google Home app / Nest Hub ──works-with-google──▶   │  /google-fulfillment
                                                        ▼
                       Google receives LAN RTSP URL → plays on a device in your Wi‑Fi
```

- The TV registers the discovered Dahua channels (RTSP URLs) with the cloud backend.
- Google Home talks to the cloud backend (HTTPS) on your behalf.
- The backend hands back the **LAN RTSP URL** of a channel. The Google device that plays the
  stream (your phone with the Google Home app, a Nest Hub, a Chromecast-capable display) must
  therefore be on the **same local network** as the XVR.

---

## Part 0 — Prerequisites

- The latest APK installed on your Android TV (debug or signed release).
- Your Dahua XVR on the same LAN, reachable over RTSP (see `docs/dahua.md`).
- A computer to deploy the backend and do the account steps.
- An internet-facing server that can run Node.js **with an HTTPS URL** — a tunnel like `ngrok`
  works for testing, a service like Render/Railway is better long term.

--- 

## Part 1 — Deploy the cloud backend

The backend is a single Node/Express file in `cloud-backend/`.

### Option A — Render (easiest, free tier)

1. Push this repo to GitHub.
2. Go to https://render.com → **New → Web Service** → connect your repo.
3. Set **Root Directory** to `cloud-backend`.
4. Build command: (leave empty). Start command: `node index.js`.
5. Environment variables:
   - `BRIDGE_SECRET` — a strong secret. **Make up your own**, e.g. `B7!kQw-29eXz-9kLm`.
   - `PORT` — set to `3000`.
6. Deploy. Copy the returned HTTPS URL, e.g. `https://dahua-bridger.onrender.com`.
7. Verify: open `https://<your-url>/api/health` in a browser → JSON `{"ok":true,...}`.

> `ALLOWED_REDIRECT_URIS`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` can be left unset for now
> (see Part 3/5 to lock them down).

### Option B — Railway

1. Create a project at https://railway.app → Deploy with empty template → add a **Node** service
   pointing at `cloud-backend`.
2. Add the same environment variables.
3. Railway gives you `https://<name>.up.railway.app`.

### Option C — Any other host (Fly, Glitch, Vercel, Cloud Run, VPS)

The service exposes HTTP on `PORT`. Do whatever you usually do to get an **HTTPS** URL. On
**read-only filesystems** the JSON store file will not persist — you'll simply need to re-pair
the app after a restart.

---

## Part 2 — Pair the TV with the backend (in the app)

1. Install the APK on the TV.
2. Open **Settings → Apps → Dahua Bridger → Open** (or the launcher icon if enabled).
3. Finish the Setup Wizard as usual (network / auth / discovery), so the TV knows your XVR.
4. From the dashboard choose **GOOGLE HOME**.
5. Fill in:
   - **Cloud backend URL** — `https://<your-url>` (e.g. `https://dahua-bridger.onrender.com`).
   - **This TV name** — e.g. `Living Room TV`.
   - **Bridge secret** — same value you set in `BRIDGE_SECRET` on the backend.
6. Press **Test Connection** → should say "Backend reachable".
7. Press **Pair**. It now shows "PAIRED (N channels pushed)".
8. Later, if you change channels, press **Sync Channels**.

The TV also re-syncs channels to the backend every time the foreground bridge service starts
(on boot if auto-start is on).

---

## Part 3 — Create the Google Cloud project & OAuth client

### 3.1 Google Cloud project

1. Go to https://console.cloud.google.com (log in with your Google account).
2. **Create project** → name: `Dahua Bridger`.
3. From the top menu open **APIs & Services → Library**, search **HomeGraph**, open it and
   press **Enable**. (HomeGraph only matters if you later want device state/reports; the smart
   home actions can run without it, but it does not hurt to enable it.)

### 3.2 OAuth consent screen & OAuth client

1. **APIs & Services → OAuth consent screen**:
   - User type **External**, App name `Dahua Bridger`, your email. Save.
   - (Optional) Test users: add your own Google account.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URIs**: add
     `https://oauth-redirect.googleusercontent.com/r/<YOUR-CONSOLE-PROJECT-NUMBER>`
     (find the project number in the console top dropdown).
   - Note the **Client ID** and **Client Secret**.
3. On the backend, set `OAUTH_CLIENT_ID` = Client ID and `OAUTH_CLIENT_SECRET` = Client Secret,
   then redeploy. This locks the token endpoint down so only your project can use it.

---

## Part 4 — Create the Actions on Google app

1. Go to https://console.actions.google.com → **New project** → name `Dahua Bridger`.
2. Choose **Smart Home** → in **Set up Smart Home**, select the Cloud project from Part 3 and
   enable it.
3. Under **Invocation**, set a display name, e.g. `Thirdy CCTV Bridge`.
4. Under **Actions → Fulfillment**, set **Webhook URL** to
   `https://<your-url>/google-fulfillment`.
5. Under **Account linking**:
   - Linking type: **OAuth** → **Authorization code**.
   - **Authorization URL**: `https://<your-url>/oauth/authorize`
   - **Token URL**: `https://<your-url>/oauth/token`
   - Client ID / Secret = the OAuth web client from Part 3.2.
6. Leave **Scope** empty. Save. Enable the app with the **Test/Draft** toggle.

## Part 5 — Test

1. In the **Actions console → Test**:
   - Enter your account. **Discover devices**.
   - Confirm your channels appear (e.g. `Front Door`, `Camera 2`).
   - Trigger the `action.devices.commands.GetCameraStream` test.
2. In the **Google Home app** on your phone (**same Wi‑Fi as the XVR**):
   - **+** → **Set up device** → **Works with Google**.
   - Search your deployment name, e.g. `Thirdy CCTV Bridge`.
   - Enter the **bridge secret** → Link.
3. Ask: **"Hey Google, show the Front Door camera."**

---

## Important Google notes

- **Brand verification** only matters if you publish the action for other users' accounts — for
  personal use in the test harness this is not required.
- The fulfillment returns **RTSP** URLs (`cameraStreamSupportedProtocols: ['rtsp','hls']`).
  Phone with the Google Home app plays RTSP directly. Casting to a **Chromecast / Google TV**
  display prefers HLS/DASH — for that use-case you would need an HLS packager/relay in front
  of the streams (out of scope of this bridge).

---

## Optional hardening

Once everything works, set on the backend and redeploy:

```
OAUTH_CLIENT_ID=yourGoogleClientId
OAUTH_CLIENT_SECRET=yourGoogleClientSecret
ALLOWED_REDIRECT_URIS=https://oauth-redirect.googleusercontent.com/r/<project-number>
```

From then on the token endpoint only accepts your client and the authorize page only redirects
to your URIs.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Cannot reach backend" in the app | Backend not deployed / URL typo / not HTTPS. Test `https://<url>/api/health` in a browser. |
| Pair fails with 401 | Bridge secret mismatch between `BRIDGE_SECRET` on the server and the app. |
| SYNC returns 0 devices | Re-run **Sync Channels** on the TV after pairing; make sure channels are enabled. |
| Account linking page loads but link fails | Reopen `/oauth/authorize` cleanly; check the redirect URL in the browser is on your allowed list. |
| Stream never plays | Google Home device must be on the **same LAN/SSID** as the XVR (RTSP). Check XVR RTSP port, firewall, and try playing the URL in VLC first. |
| "Hey Google, show... on TV" does nothing | Chromecast targets prefer HLS/DASH. Use the Google Home app on a phone, or add an HLS relay. |
| After backend restart, TV shows disconnected | Store file is only on persistent disks. Re-open the Cloud screen and press **Pair** (it is idempotent per device name). |

---

## Contents of this repo (where the code lives)

- `cloud-backend/` — the cloud server (deploy this).
- `app/src/main/java/com/thirdy/dahuabridger/cloud/CloudBridgeClient.kt` — TV↔cloud client.
- `app/src/main/java/com/thirdy/dahuabridger/ui/screens/CloudLinkScreen.kt` — pairing UI.
- `app/src/main/java/com/thirdy/dahuabridger/ui/viewmodel/CloudLinkViewModel.kt` — pairing logic.
- `docs/google-home.md` — protocol-level notes.
