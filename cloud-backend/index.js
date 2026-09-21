const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Configuration (all optional except BRIDGE_SECRET for production)
// ---------------------------------------------------------------------------
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'changeme-bridge-secret';
const STORE_FILE = process.env.STORE_FILE || path.join(__dirname, 'store.json');
const PORT = process.env.PORT || 3000;
// Comma separated list of allowed OAuth redirect URIs.
// If empty, any https:// URI (and http://localhost) is accepted.
const ALLOWED_REDIRECT_URIS = (process.env.ALLOWED_REDIRECT_URIS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Optional mTLS/basic-auth client credentials for the Google OAuth flow.
const OAUTH_CLIENT_IDS = (process.env.OAUTH_CLIENT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OAUTH_CLIENT_SECRETS = (process.env.OAUTH_CLIENT_SECRETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';

// ---------------------------------------------------------------------------
// Persisted store
// ---------------------------------------------------------------------------
let store = loadStore();

function defaultStore() {
  return {
    devices: {}, // deviceId -> { deviceId, deviceName, home, bridgeTokenHash, updatedAt, channels }
    channelsByHome: {}, // home -> deviceId -> [channel]
    homeByTokenHash: {}, // bridgeTokenHash -> home
    deviceByName: {}, // home:deviceName -> deviceId  (stable id across re-registers)
    tokens: {}, // accessToken -> { home, expiresAt }
    refreshTokens: {}, // refreshToken -> { home, accessToken }
    authCodes: {}, // code -> { home, expiresAt }
    pairingCodes: {}, // pairingCode -> { home, label, createdAt }
  };
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      return { ...defaultStore(), ...raw };
    }
  } catch (e) {
    console.error('Could not load store:', e.message);
  }
  return defaultStore();
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Could not persist store:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function secretOk(secret) {
  const a = sha256(String(secret || '').trim());
  const b = sha256(String(BRIDGE_SECRET).trim());
  return a === b;
}

function homeFor(secret) {
  return 'home-' + sha256(String(secret).trim()).slice(0, 16);
}

function rand(n) {
  return crypto.randomBytes(n).toString('hex');
}

function tokenFor(prefix) {
  return prefix + '_' + rand(24);
}

function chHashChannel(c) {
  return sha256(JSON.stringify(c || {}));
}

function now() {
  return new Date().toISOString();
}

function clearExpired() {
  const t = Date.now();
  for (const [k, v] of Object.entries(store.tokens)) {
    if (!v || v.expiresAt < t) delete store.tokens[k];
  }
  for (const [k, v] of Object.entries(store.authCodes)) {
    if (!v || v.expiresAt < t) delete store.authCodes[k];
  }
}

// Reads token from "Authorization: Bearer <token>"
function readBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : null;
}

function tokenHome(token) {
  if (!token) return null;
  const entry = store.tokens[token];
  if (entry && entry.expiresAt > Date.now()) return entry.home;
  // Bridge tokens issued during /api/devices/register.
  const bridgeHome = store.homeByTokenHash[sha256(token)];
  return bridgeHome || null;
}

// ---------------------------------------------------------------------------
// API: health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'DahuaBridgerCloud', ts: now() });
});

// ---------------------------------------------------------------------------
// API: device registration (called by the Android TV)
// ---------------------------------------------------------------------------
app.post('/api/devices/register', (req, res) => {
  const secret = req.body && req.body.secret;
  if (!secretOk(secret)) {
    return res.status(401).json({ error: 'Invalid bridge secret' });
  }
  const deviceName = String((req.body && req.body.deviceName) || '').trim();
  if (!deviceName) {
    return res.status(400).json({ error: 'deviceName is required' });
  }
  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : [];
  const home = homeFor(secret);

  // Stable device id across re-registrations.
  let deviceId = store.deviceByName[home + ':' + deviceName];
  if (!deviceId) {
    deviceId = tokenFor('dev');
    store.deviceByName[home + ':' + deviceName] = deviceId;
  }

  const bridgeToken = tokenFor('bt');
  const t = now();
  store.devices[deviceId] = {
    deviceId,
    deviceName,
    home,
    bridgeTokenHash: sha256(bridgeToken),
    updatedAt: t,
    channels,
  };
  store.channelsByHome[home] = store.channelsByHome[home] || {};
  store.channelsByHome[home][deviceId] = channels;
  store.homeByTokenHash[sha256(bridgeToken)] = home;
  saveStore();

  res.json({ ok: true, deviceId, bridgeToken, channelCount: channels.length });
});

// ---------------------------------------------------------------------------
// API: update channels / device info (called by the Android TV)
// ---------------------------------------------------------------------------
app.post('/api/devices/channels', (req, res) => {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const home = tokenHome(token);
  if (!home) return res.status(401).json({ error: 'Invalid token' });

  // The home owning this token must be able to write all devices under it
  // (a single home can have multiple TVs bridging the same XVR).
  const matchingDeviceIds = Object.keys(store.devices).filter((id) => {
    return store.devices[id].home === home && sha256(token) === store.devices[id].bridgeTokenHash;
  });

  if (matchingDeviceIds.length === 0) {
    return res.status(401).json({ error: 'Token is not bound to a device, re-register first' });
  }

  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels : [];
  const t = now();
  const updated = [];

  matchingDeviceIds.forEach((deviceId) => {
    store.devices[deviceId].channels = channels;
    store.devices[deviceId].updatedAt = t;
    store.channelsByHome[home][deviceId] = channels;
    updated.push(deviceId);
  });
  saveStore();

  res.json({ ok: true, count: channels.length, devices: updated });
});

// ---------------------------------------------------------------------------
// API: get device status (called by the Android TV)
// ---------------------------------------------------------------------------
app.get('/api/devices', (req, res) => {
  const token = readBearer(req);
  const home = tokenHome(token);
  if (!home) return res.status(401).json({ error: 'Invalid token' });

  const result = [];
  for (const [deviceId, device] of Object.entries(store.devices)) {
    if (device.home === home) {
      result.push({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        updatedAt: device.updatedAt,
        channels: store.channelsByHome[home][deviceId] || [],
      });
    }
  }
  res.json({ ok: true, devices: result });
});

// ---------------------------------------------------------------------------
// OAuth 2 authorisation server (used by Google Home account linking)
// ---------------------------------------------------------------------------
function redirectOk(redirectUri) {
  if (ALLOWED_REDIRECT_URIS.length > 0) {
    return ALLOWED_REDIRECT_URIS.includes(redirectUri);
  }
  if (!redirectUri) return false;
  return redirectUri.startsWith('https://') || redirectUri.startsWith('http://localhost');
}

app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query;
  if (response_type && response_type !== 'code' && response_type !== 'token') {
    return res
      .status(400)
      .send('Unsupported response_type. Use "code" for the authorization code flow.');
  }
  if (!redirectOk(redirect_uri)) {
    return res.status(400).send('redirect_uri is not allowed by this server.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
      <title>Dahua Bridger - Account Linking</title>
      <style>
        body{font-family:system-ui,sans-serif;background:#101014;color:#e8e8ec;
             margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh}
        .card{background:#1b1b22;border:1px solid #333;border-radius:16px;padding:40px;
              max-width:420px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.5)}
        h1{font-size:20px;margin:0 0 8px}h2{font-size:14px;font-weight:400;color:#9aa;margin:0 0 24px}
        label{display:block;font-size:13px;margin:16px 0 6px;color:#b8b8c2}
        input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;
              border:1px solid #444;background:#0f0f13;color:#fff;font-size:15px}
        button{margin-top:24px;width:100%;padding:13px;border-radius:10px;border:0;
               background:#3a7afe;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
        button:hover{background:#2f66dd}
        .hint{font-size:12px;color:#7c7c8a;line-height:1.5;margin-top:20px}
        .err{color:#ff7b72;font-size:13px;margin-top:14px}
      </style></head><body><div class="card">
      <h1>Dahua Bridger</h1>
      <h2>Link your assistant using the bridge secret.</h2>
      <form method="POST" action="/oauth/authorize/decision">
        <input type="hidden" name="client_id" value="${escapeHtml(client_id)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
        <input type="hidden" name="state" value="${escapeHtml(state)}" />
        <input type="hidden" name="response_type" value="${escapeHtml(response_type || 'code')}" />
        <label for="secret">Bridge secret</label>
        <input type="password" id="secret" name="secret" placeholder="Enter the secret you configured in the bridge secret env var" required />
        <button type="submit">Link account</button>
      </form>
      <div class="hint">This is the same secret you entered in the &quot;Bridge secret&quot; setting on
        the Android TV app. It is only used to prove you own the bridge.</div>
      ${req.query.error ? `<div class="err">${escapeHtml(req.query.error)}</div>` : ''}
    </div></body></html>`);
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

app.post('/oauth/authorize/decision', (req, res) => {
  const { client_id, redirect_uri, state, response_type, secret } = req.body;
  if (!secretOk(secret)) {
    return res.redirect(
      '/oauth/authorize?client_id=' + encodeURIComponent(client_id || '') +
      '&redirect_uri=' + encodeURIComponent(redirect_uri || '') +
      '&state=' + encodeURIComponent(state || '') +
      '&response_type=' + encodeURIComponent(response_type || 'code') +
      '&error=' + encodeURIComponent('invalid_secret')
    );
  }

  const home = homeFor(secret);
  const redirect = new URL(redirect_uri);
  redirect.searchParams.set('state', state || '');

  if (response_type === 'token') {
    // Implicit flow: token goes in the URL fragment + state in query.
    const accessToken = tokenFor('at');
    store.tokens[accessToken] = { home, expiresAt: Date.now() + 86400 * 1000 };
    saveStore();
    redirect.hash = `access_token=${accessToken}&token_type=bearer&expires_in=86400`;
    return res.redirect(redirect.toString());
  }

  // Authorization code flow.
  const code = tokenFor('code');
  store.authCodes[code] = { home, expiresAt: Date.now() + 600 * 1000 };
  saveStore();
  redirect.searchParams.set('code', code);
  res.redirect(redirect.toString());
});

app.post('/oauth/token', (req, res) => {
  const { grant_type } = req.body || {};
  const bodyClientId = req.body && (req.body.client_id || '');
  const bodyClientSecret = req.body && (req.body.client_secret || '');
  const basicAuth = req.headers['authorization'] || '';
  let authClientId = bodyClientId;
  let authClientSecret = bodyClientSecret;
  const m = /^Basic\s+(.+)/i.exec(basicAuth);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      authClientId = decoded.slice(0, idx);
      authClientSecret = decoded.slice(idx + 1);
    }
  }

  // Validate client credentials if configured; otherwise accept anything.
  if (OAUTH_CLIENT_ID || OAUTH_CLIENT_SECRET || OAUTH_CLIENT_IDS.length) {
    const ids = OAUTH_CLIENT_IDS.length ? OAUTH_CLIENT_IDS : [OAUTH_CLIENT_ID];
    const secrets = OAUTH_CLIENT_SECRETS.length ? OAUTH_CLIENT_SECRETS : [OAUTH_CLIENT_SECRET];
    const ok = ids.some((id, i) => id === authClientId && secrets[i] === authClientSecret);
    if (!ok) return res.status(401).json({ error: 'invalid_client' });
  }

  if (grant_type === 'authorization_code') {
    const code = req.body && req.body.code;
    const entry = store.authCodes[code];
    if (!entry || entry.expiresAt <= Date.now()) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    delete store.authCodes[code];

    const accessToken = tokenFor('at');
    const refreshToken = tokenFor('rt');
    store.tokens[accessToken] = { home: entry.home, expiresAt: Date.now() + 86400 * 1000 };
    store.refreshTokens[refreshToken] = { home: entry.home, accessToken };
    saveStore();
    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
    });
  }

  if (grant_type === 'refresh_token') {
    const rt = req.body && req.body.refresh_token;
    const entry = store.refreshTokens[rt];
    if (!entry) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const accessToken = tokenFor('at');
    store.tokens[accessToken] = { home: entry.home, expiresAt: Date.now() + 86400 * 1000 };
    entry.accessToken = accessToken;
    store.refreshTokens[rt] = entry;
    saveStore();
    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: rt,
      expires_in: 86400,
    });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// ---------------------------------------------------------------------------
// Google Home fulfillment
// ---------------------------------------------------------------------------
function googleChannelsForHome(home) {
  const out = [];
  const byDevice = store.channelsByHome[home] || {};
  for (const [deviceId, channels] of Object.entries(byDevice)) {
    (channels || []).forEach((ch) => {
      out.push({ deviceId, ...ch });
    });
  }
  return out;
}

function googleChannelById(home, deviceId, channelId) {
  const channels = (store.channelsByHome[home] || {})[deviceId] || [];
  return channels.find((c) => Number(c.id) === Number(channelId)) || null;
}

app.post('/google-fulfillment', (req, res) => {
  clearExpired();
  const body = req.body || {};
  const requestId = body.requestId;
  const input = (body.inputs && body.inputs[0]) || {};
  const intent = input.intent;
  const payload = input.payload || {};

  // NOTE: agentUserId must equal the home id this token/home resolves to.
  // During account linking we do not store a custom user id, so the home
  // is derived from the OAuth token when available, else from payload.
  let home = null;
  if (payload.agentUserId && /^home-[0-9a-f]{16}$/.test(payload.agentUserId)) {
    home = payload.agentUserId;
  }
  // The token is not forwarded by Google in the SYNC payload, but EXECUTE/QUERY
  // request headers don't carry it either in cloud-to-cloud; instead we rely on
  // payload.agentUserId which is set from the OAuth account during linking.

  function ok(payloadObj) {
    return res.json({ requestId, payload: payloadObj });
  }

  if (intent === 'action.devices.SYNC') {
    const channels = googleChannelsForHome(home);
    const devices = channels.map((ch) => ({
      id: `cam_${ch.deviceId}_${ch.id}`,
      type: 'action.devices.types.CAMERA',
      traits: ['action.devices.traits.CameraStream'],
      name: { name: String(ch.name || ('Camera ' + ch.id)) },
      willReportState: false,
      attributes: {
        cameraStreamSupportedProtocols: ['hls', 'rtsp'],
        cameraStreamNeedAuthToken: false,
        cameraStreamNeedDrmEncryption: false,
      },
    }));
    return ok({ agentUserId: home || 'unlinked', devices });
  }

  if (intent === 'action.devices.QUERY') {
    const ids = (payload.devices || []).map((d) => d.id);
    const devices = {};
    ids.forEach((id) => {
      const parts = /^cam_(.+)_(\d+)$/.exec(id);
      const ch = parts && googleChannelById(home, parts[1], parts[2]);
      devices[id] = ch ? { online: true, status: 'SUCCESS' } : { online: false, status: 'ERROR' };
    });
    return ok({ devices });
  }

  if (intent === 'action.devices.EXECUTE') {
    const commands = [];
    (payload.commands || []).forEach((cmd) => {
      const deviceIds = (cmd.devices || []).map((d) => d.id);
      (cmd.execution || []).forEach((exec) => {
        if (exec.command === 'action.devices.commands.GetCameraStream') {
          deviceIds.forEach((id) => {
            const parts = /^cam_(.+)_(\d+)$/.exec(id);
            const ch = parts && googleChannelById(home, parts[1], parts[2]);
            commands.push({
              ids: [id],
              status: ch ? 'SUCCESS' : 'ERROR',
              states: ch
                ? {
                    online: true,
                    cameraStreamAccessUrl: ch.rtspMain || ch.rtspSub,
                    cameraStreamAuthToken: '',
                    cameraStreamAuthTokenType: 'NONE',
                  }
                : { online: false },
            });
          });
        } else {
          deviceIds.forEach((id) => {
            commands.push({ ids: [id], status: 'ERROR', errorCode: 'NOT_SUPPORTED' });
          });
        }
      });
    });
    return ok({ commands });
  }

  res.status(400).json({ error: 'unsupported_intent' });
});

// ---------------------------------------------------------------------------
// Landing page / pairing helper
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Dahua Bridger backend</title>
    <style>body{font-family:system-ui,sans-serif;background:#101014;color:#e8e8ec;margin:0;
      padding:60px 24px;display:flex;justify-content:center}
      .wrap{max-width:640px}.card{background:#1b1b22;border:1px solid #333;border-radius:16px;padding:32px;margin-bottom:20px}
      h1{font-size:22px}code,.k{background:#0f0f13;border:1px solid #333;border-radius:8px;padding:2px 8px;font-size:13px}
      li{margin:8px 0;line-height:1.6}</style></head><body><div class="wrap">
    <div class="card"><h1>Dahua Bridger cloud backend</h1>
      <p>This server is the glue between your Android TV and Google Home.</p>
      <p><span class="k">GET /api/health</span> &mdash; health check<br/>
         <span class="k">POST /api/devices/register</span> &mdash; used by the TV app<br/>
         <span class="k">POST /google-fulfillment</span> &mdash; Google Home endpoint<br/>
         <span class="k">GET/POST /oauth/authorize</span> &mdash; Google account linking<br/>
         <span class="k">POST /oauth/token</span> &mdash; OAuth token exchange</p>
    </div></div></body></html>`);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Dahua Bridger cloud backend listening on port ${PORT}`);
  console.log(`Store file: ${STORE_FILE}`);
});