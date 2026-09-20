require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql, initDB } = require('./db');
const cloudinary = require('cloudinary').v2;
const { sendAppMail, isMailConfigured } = require('./mailer');
const gcal = require('./googleCalendar');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors({ origin: ['https://www.landmark-pacifique.fr','https://landmark-pacifique.fr'], credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

/* ─── SERVEUR HTTP + WEBSOCKET (calendrier temps réel) ─── */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Auth JWT optionnel via query ?token=… (WebSocket ne supporte pas les headers custom côté navigateur)
  let email = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    const tok = url.searchParams.get('token');
    if (tok) email = jwt.verify(tok, JWT_SECRET).email;
  } catch {}
  ws._email = email;
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  // Ping heartbeat 30s pour garder la connexion vivante
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
setInterval(() => {
  wsClients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} wsClients.delete(ws); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload, at: Date.now() });
  wsClients.forEach(ws => { try { if (ws.readyState === 1) ws.send(msg); } catch {} });
}

/* ─── CONSTANTES CALENDRIER ─── */
const CALENDAR_ROLES = ['leader_intro', 'opm', 'room_captain', 'clinic_animator', 'translator', 'forum_expert'];
const EVENT_KINDS    = ['forum', 'advanced', 'communication', 'seminar', 'special'];

/* ─── CACHE UTILISATEUR (30s TTL) ─── */
const _userCache = new Map(); // email -> { user, at }
const USER_CACHE_TTL = 30_000;

async function getUser(email) {
  const cached = _userCache.get(email);
  if (cached && Date.now() - cached.at < USER_CACHE_TTL) return cached.user;
  const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
  const user = rows[0] || null;
  if (user) _userCache.set(email, { user, at: Date.now() });
  return user;
}

function invalidateUser(email) {
  _userCache.delete(email);
}

/* ─── ÉTAT DE MAINTENANCE (persisté en DB) ─── */
let _maintCache = { value: false, at: 0 };

async function ensureSettingsTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`.catch(() => {});
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'`.catch(() => {});
    await sql`ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'community'`.catch(() => {});
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS validated BOOLEAN DEFAULT false`.catch(() => {});
    // Marquer comme validés tous les utilisateurs déjà existants (admin, gradués, ou avec programmes)
    await sql`UPDATE users SET validated = true WHERE validated = false AND (role IN ('admin','superadmin') OR fonction != 'invité' OR (programs IS NOT NULL AND jsonb_array_length(programs) > 0))`.catch(() => {});
    // Synchronisation Google Calendar (contact@landmark-pacifique.fr)
    await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS gcal_event_id TEXT`.catch(() => {});
    await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS gcal_cc_event_id TEXT`.catch(() => {});
    await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS gcal_attendees TEXT`.catch(() => {});
    await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS gcal_graduate_events TEXT`.catch(() => {});
    await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS gcal_cc_attendees TEXT`.catch(() => {});
    await sql`ALTER TABLE creation_calls ADD COLUMN IF NOT EXISTS gcal_event_id TEXT`.catch(() => {});
  } catch (e) {
    console.error('Erreur création table settings:', e.message);
  }
}

async function getMaintenance() {
  if (Date.now() - _maintCache.at < 3000) return _maintCache.value;
  try {
    const rows = await sql`SELECT value FROM settings WHERE key = 'maintenance'`;
    const v = rows.length ? rows[0].value === 'true' : false;
    _maintCache = { value: v, at: Date.now() };
    return v;
  } catch {
    return _maintCache.value;
  }
}

async function setMaintenance(v) {
  const val = v ? 'true' : 'false';
  await sql`INSERT INTO settings (key, value) VALUES ('maintenance', ${val})
    ON CONFLICT (key) DO UPDATE SET value = ${val}`;
  _maintCache = { value: !!v, at: Date.now() };
}

/* ─── AUTH MIDDLEWARE ─── */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

/* ─── HELPERS ─── */
function isSuperAdmin(u) { return u.role === 'superadmin'; }
function isAdmin(u) { return u.role === 'admin' || u.role === 'superadmin'; }
const LEADER_FONCTIONS = ['leader', "leader d'introduction au forum", 'team leader il', 'seminar leader in training', 'seminar leader'];
function isLeader(u) { const f = (u.fonction || '').toLowerCase(); return isAdmin(u) || LEADER_FONCTIONS.includes(f) || f === 'gradué'; }
function hasPerm(u, perm) { if (isSuperAdmin(u)) return true; return !!(u.permissions && u.permissions[perm]); }

const SUPPORTED_LANGS = ['fr', 'en'];
const DEFAULT_LANG    = 'fr';
/** Retourne le code de langue supporté correspondant à `value`, sinon null. */
function normalizeLang(value) {
  const code = String(value || '').toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.includes(code) ? code : null;
}

const VALID_ROLES    = ['utilisateur', 'admin', 'superadmin'];
const VALID_FONCTIONS = ['invité', 'gradué', 'leader', 'Team Leader IL', 'Seminar Leader In Training', 'Seminar Leader', 'staff'];

/* ─── MIDDLEWARE DE MAINTENANCE ─── */
app.use('/api', async (req, res, next) => {
  const maintenanceOn = await getMaintenance();
  if (!maintenanceOn) return next();

  if (req.path === '/maintenance' && req.method === 'GET') return next();
  if (req.path === '/login' && req.method === 'POST') return next();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(503).json({ error: 'Site en maintenance', maintenance: true });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const u = await getUser(decoded.email);
    if (!u || (u.role !== 'admin' && u.role !== 'superadmin')) {
      return res.status(503).json({ error: 'Site en maintenance', maintenance: true });
    }
    next();
  } catch {
    return res.status(503).json({ error: 'Site en maintenance', maintenance: true });
  }
});

/* ─── TIMEZONE & DATE HELPERS ─── */
function lastSunday(year, month) {
  const d = new Date(year, month + 1, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}
function firstSunday(year, month) {
  const d = new Date(year, month, 1);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}
function isFranceSummer(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const y = d.getFullYear();
  return d >= lastSunday(y, 2) && d < lastSunday(y, 9);
}
// Heure d'été NZ (NZDT) : de fin septembre à début avril (hémisphère sud, saisons inversées).
function isNZSummer(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const y = d.getFullYear();
  return d >= lastSunday(y, 8) || d < firstSunday(y, 3);
}
function addHours(timeStr, diff) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  let total = h * 60 + m + diff * 60;
  total = ((total % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
function fmtDateLong(dateStr, locale = 'fr-FR') {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
}
function computeTimezones(intro, locale = 'fr-FR') {
  const frDiff   = isFranceSummer(intro.date)    ? 12 : 11;
  const frDiffCC = isFranceSummer(intro.cc_date) ? 12 : 11;
  const nzDiff   = isNZSummer(intro.date)    ? 23 : 22;
  const nzDiffCC = isNZSummer(intro.cc_date) ? 23 : 22;

  function dateWithOffset(dateStr, timeStr, diffHours) {
    if (!dateStr || !timeStr) return dateStr || '';
    const d = new Date(dateStr + 'T' + timeStr + ':00');
    d.setMinutes(d.getMinutes() + diffHours * 60);
    return d.toISOString().slice(0, 10);
  }

  const dateNC   = dateWithOffset(intro.date,    intro.heure,    21);
  const dateFR   = dateWithOffset(intro.date,    intro.heure,    frDiff);
  const dateNZ   = dateWithOffset(intro.date,    intro.heure,    nzDiff);
  const ccDateNC = dateWithOffset(intro.cc_date, intro.cc_heure, 21);
  const ccDateFR = dateWithOffset(intro.cc_date, intro.cc_heure, frDiffCC);
  const ccDateNZ = dateWithOffset(intro.cc_date, intro.cc_heure, nzDiffCC);

  return {
    heure_tahiti:     intro.heure     || '',
    heure_nc:         addHours(intro.heure, 21),
    heure_fr:         addHours(intro.heure, frDiff),
    heure_nz:         addHours(intro.heure, nzDiff),
    heure_fin_tahiti: intro.heure_fin || '',
    heure_fin_nc:     intro.heure_fin ? addHours(intro.heure_fin, 21)     : '',
    heure_fin_fr:     intro.heure_fin ? addHours(intro.heure_fin, frDiff) : '',
    heure_fin_nz:     intro.heure_fin ? addHours(intro.heure_fin, nzDiff) : '',
    date_long:        fmtDateLong(intro.date, locale),
    date_long_nc:     fmtDateLong(dateNC, locale),
    date_long_fr:     fmtDateLong(dateFR, locale),
    date_long_nz:     fmtDateLong(dateNZ, locale),
    date_iso:         intro.date || '',
    cc_date_iso:      intro.cc_date  || '',
    cc_date_long:     fmtDateLong(intro.cc_date, locale),
    cc_date_long_nc:  fmtDateLong(ccDateNC, locale),
    cc_date_long_fr:  fmtDateLong(ccDateFR, locale),
    cc_date_long_nz:  fmtDateLong(ccDateNZ, locale),
    cc_heure_tahiti:  intro.cc_heure || '',
    cc_heure_nc:      intro.cc_heure ? addHours(intro.cc_heure, 21)       : '',
    cc_heure_fr:      intro.cc_heure ? addHours(intro.cc_heure, frDiffCC) : '',
    cc_heure_nz:      intro.cc_heure ? addHours(intro.cc_heure, nzDiffCC) : '',
    zoom_cc:          intro.zoom_cc  || '',
  };
}

/* ════════════════════════════════════════
   INIT DB
════════════════════════════════════════ */
app.get('/api/init', async (req, res) => {
  try {
    await initDB();
    res.json({ ok: true, message: 'DB initialisée avec succès' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// La table invitation_tokens est créée dans initDB() (db.js)
async function ensureInvitationTokensTable() { /* no-op : créée au démarrage */ }

/* ════════════════════════════════════════
   WEBHOOK BREVO (statut de livraison des emails d'invitation)
   À configurer dans Brevo → Transactional → Settings → Webhooks,
   sur l'URL : {APP_URL}/api/webhooks/brevo?key={BREVO_WEBHOOK_SECRET}
════════════════════════════════════════ */
const BREVO_EVENT_TO_STATUS = {
  delivered: 'delivered',
  hard_bounce: 'bounced',
  soft_bounce: 'bounced',
  blocked: 'blocked',
  invalid_email: 'invalid',
  spam: 'spam',
  unsubscribed: 'unsubscribed',
  error: 'error',
  opened: 'opened',
  unique_opened: 'opened',
};

app.post('/api/webhooks/brevo', async (req, res) => {
  // Toujours répondre 200 (sinon Brevo retente et finit par désactiver le webhook),
  // mais ignorer l'appel si le secret ne correspond pas.
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (secret && req.query.key !== secret) return res.status(200).json({ ignored: true });

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    await Promise.all(events.map(async (evt) => {
      if (!evt || !evt['message-id']) return;
      const status = BREVO_EVENT_TO_STATUS[evt.event];
      if (!status) return;
      await sql`
        UPDATE invitation_tokens
        SET email_status = ${status}, email_status_at = ${Date.now()}
        WHERE message_id = ${evt['message-id']}
      `.catch(() => {});
    }));
    res.json({ ok: true });
  } catch (e) {
    console.error('Brevo webhook error:', e.message);
    res.status(200).json({ ok: false });
  }
});

/* ════════════════════════════════════════
   INVITATION (page de confirmation invité)
════════════════════════════════════════ */

app.get('/api/invitation/:token', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM invitation_tokens WHERE token = ${req.params.token}`;
    if (!rows.length) return res.status(404).json({ error: 'Invitation introuvable ou expirée' });
    const inv = rows[0];
    const introRows = await sql`SELECT * FROM intros WHERE id = ${inv.intro_id}`;
    if (!introRows.length) return res.status(404).json({ error: 'Événement introuvable' });
    const intro = introRows[0];
    res.json({
      token: inv.token,
      used: inv.used,
      guest: { firstname: inv.guest_firstname, lastname: inv.guest_lastname, email: inv.guest_email, phone: inv.guest_phone },
      graduate: { name: inv.graduate_name, email: inv.graduate_email },
      intro
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invitation/:token/confirm', async (req, res) => {
  try {
    // 1 seule requête : invitation + intro via JOIN
    const rows = await sql`
      SELECT t.*, row_to_json(i.*) AS intro_json
      FROM invitation_tokens t
      LEFT JOIN intros i ON i.id = t.intro_id
      WHERE t.token = ${req.params.token}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Invitation introuvable' });
    const inv = rows[0];
    if (inv.used) return res.status(400).json({ error: 'Cette invitation a déjà été utilisée' });
    const randomPassword = uuidv4();
    const hash = bcrypt.hashSync(randomPassword, 10);
    // 1 seule requête : UPSERT + RETURNING remplace SELECT + INSERT/UPDATE + SELECT
    const userRows = await sql`
      INSERT INTO users (email, password, name, role, fonction, programs, permissions, graduate_email, validated)
      VALUES (${inv.guest_email.toLowerCase()}, ${hash}, ${inv.guest_firstname + ' ' + inv.guest_lastname}, 'utilisateur', 'invité', '[]', '{}', ${inv.graduate_email || null}, true)
      ON CONFLICT (email) DO UPDATE SET graduate_email = COALESCE(users.graduate_email, EXCLUDED.graduate_email), validated = true
      RETURNING *
    `;
    invalidateUser(inv.guest_email.toLowerCase());
    await sql`UPDATE invitation_tokens SET used = true WHERE token = ${req.params.token}`;
    try {
      const intro2 = inv.intro_json;
      if (intro2) {
        const regs2 = intro2.registrations || [];
        const idx = regs2.findIndex(r => r.email && r.email.toLowerCase() === inv.guest_email.toLowerCase());
        if (idx !== -1) {
          regs2[idx].confirmed = true;
          regs2[idx].confirmed_at = new Date().toISOString();
          await sql`UPDATE intros SET registrations = ${JSON.stringify(regs2)} WHERE id = ${inv.intro_id}`;
          // Google Calendar : met à jour le statut de l'invité (Confirmé) sur l'évènement, fire-and-forget
          gcal.syncIntroAttendeesAndDescription({ ...intro2, registrations: regs2 }).catch(gcalErr => console.error('GCal confirm sync error:', gcalErr.message));
        }
        if (inv.graduate_email) {
          await createNotification(inv.graduate_email, 'confirm', `✅ ${inv.guest_firstname} ${inv.guest_lastname} a confirmé sa présence à "${intro2.titre}"`, '#my-guests');
        }
        if (intro2.type === 'special') {
          try {
            const tz = computeTimezones(intro2);
            await sendAppMail({
              type: 'special_event_guest_confirmed',
              to_email: inv.guest_email,
              to_name: inv.guest_firstname + ' ' + inv.guest_lastname,
              guest: { firstname: inv.guest_firstname, lastname: inv.guest_lastname, email: inv.guest_email, phone: inv.guest_phone },
              graduate: { name: inv.graduate_name, email: inv.graduate_email },
              event: {
                id: intro2.id, titre: intro2.titre,
                date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
                date_iso: tz.date_iso,
                heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
                heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
                format: intro2.format, location: intro2.location, zoom_url: intro2.zoom_url, animateur: intro2.animateur, theme: intro2.theme || '',
                cc_date_iso: tz.cc_date_iso,
                cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
                cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
                zoom_cc: tz.zoom_cc
              }
            });
          } catch (whErr) { console.error('Email confirm special error:', whErr.message); }
        }
      }
    } catch(e2) { console.error('Confirm reg update error:', e2.message); }
    const u = userRows[0];
    const { password: _, ...safeUser } = u;
    safeUser.programs = safeUser.programs || [];
    safeUser.permissions = safeUser.permissions || {};
    const jwtToken = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token: jwtToken, user: safeUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   AUTH
════════════════════════════════════════ */

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, name, lang } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Champs requis manquants' });
    const hash = bcrypt.hashSync(password, 10);
    const userLang = normalizeLang(lang) || DEFAULT_LANG;
    // 1 seule requête : INSERT ON CONFLICT remplace SELECT + INSERT
    const inserted = await sql`
      INSERT INTO users (email, password, name, role, fonction, programs, permissions, lang)
      VALUES (${email.toLowerCase()}, ${hash}, ${name}, 'utilisateur', 'invité', '[]', '{}', ${userLang})
      ON CONFLICT (email) DO NOTHING RETURNING email`;
    if (!inserted.length) return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    try {
      // 1 seule requête batch : INSERT des notifications pour tous les superadmins
      const msg = `🆕 Nouvelle inscription : ${name} (${email.toLowerCase()})`;
      await sql`
        INSERT INTO notifications (recipient_email, type, message, link, read, created_at)
        SELECT email, 'signup', ${msg}, '#admin', false, NOW()
        FROM users WHERE role = 'superadmin'`;
    } catch(notifErr) { console.error('Notif signup superadmin error:', notifErr.message); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
    if (!rows.length) return res.status(401).json({ error: 'Identifiants invalides' });
    const u = rows[0];
    const valid = bcrypt.compareSync(password, u.password);
    if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = u;
    safeUser.programs = safeUser.programs || [];
    safeUser.permissions = safeUser.permissions || {};
    safeUser.name = safeUser.name || (safeUser.first_name + ' ' + safeUser.last_name).trim();
    res.json({ token, user: safeUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── AUTH GOOGLE OAuth ─── */
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://www.landmark-pacifique.fr/api/auth/google/callback';

app.get('/api/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  const appUrl = process.env.APP_URL || 'https://www.landmark-pacifique.fr';
  if(error || !code) return res.redirect(appUrl + '/?google_error=1');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' })
    });
    const tokenData = await tokenRes.json();
    if(!tokenData.access_token) throw new Error('Token invalide');
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
    const profile = await profileRes.json();
    const email = (profile.email || '').toLowerCase();
    const name = profile.name || email;
    if(!email) throw new Error('Email introuvable');
    const tempToken = jwt.sign({ email, name, type: 'google_temp' }, JWT_SECRET, { expiresIn: '5m' });
    res.redirect(appUrl + '/?google_token=' + tempToken);
  } catch(e) {
    console.error('Google callback error:', e.message);
    res.redirect((process.env.APP_URL || 'https://www.landmark-pacifique.fr') + '/?google_error=1');
  }
});

app.post('/api/auth/google/exchange', async (req, res) => {
  try {
    const { google_token } = req.body;
    if(!google_token) return res.status(400).json({ error: 'Token manquant' });
    let decoded;
    try { decoded = jwt.verify(google_token, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Token expiré' }); }
    if(decoded.type !== 'google_temp') return res.status(401).json({ error: 'Token invalide' });
    const { email, name } = decoded;
    let rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    if(!rows.length) {
      await sql`INSERT INTO users (email, name, role, fonction, programs, permissions, validated) VALUES (${email}, ${name}, 'utilisateur', 'invité', '[]', '{}', false) ON CONFLICT (email) DO NOTHING`;
      rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    }
    const u = rows[0];
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safeUser } = u;
    safeUser.programs = safeUser.programs || [];
    safeUser.permissions = safeUser.permissions || {};
    res.json({ token, user: safeUser });
  } catch(e) {
    console.error('Google exchange error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const rows = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
    if (!rows.length) return res.status(404).json({ error: 'Aucun compte trouvé' });
    const u = rows[0];
    const token = uuidv4();
    const expires = Date.now() + 60 * 60 * 1000;
    await sql`
      INSERT INTO reset_tokens (token, email, expires)
      VALUES (${token}, ${email.toLowerCase()}, ${expires})
      ON CONFLICT (email) DO UPDATE SET token = ${token}, expires = ${expires}
    `;
    const resetLink = `${process.env.APP_URL || 'https://landmark-pacifique.fr'}/?token=${token}`;
    await sendAppMail({ type: 'forgot_password', to_email: email, to_name: u.name, reset_link: resetLink });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token et mot de passe requis' });
    const rows = await sql`SELECT * FROM reset_tokens WHERE token = ${token}`;
    if (!rows.length) return res.status(400).json({ error: 'Lien invalide ou déjà utilisé' });
    const reset = rows[0];
    if (reset.expires < Date.now()) {
      await sql`DELETE FROM reset_tokens WHERE token = ${token}`;
      return res.status(400).json({ error: 'Lien expiré, veuillez faire une nouvelle demande' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await sql`UPDATE users SET password = ${hash} WHERE email = ${reset.email}`;
    await sql`DELETE FROM reset_tokens WHERE token = ${token}`;
    invalidateUser(reset.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM users WHERE email = ${req.user.email}`;
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const { password: _, ...safeUser } = rows[0];
    safeUser.programs = safeUser.programs || [];
    safeUser.permissions = safeUser.permissions || {};
    safeUser.name = safeUser.name || (safeUser.first_name + ' ' + safeUser.last_name).trim();
    res.json(safeUser);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/public/graduate-by-email/:email', async (req, res) => {
  try {
    const email = String(req.params.email || '').toLowerCase();
    const rows = await sql`SELECT name FROM users WHERE LOWER(email) = ${email}`;
    if (!rows.length) return res.status(404).json({ error: 'Gradué introuvable' });
    res.json({ name: rows[0].name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users/:email/name', auth, async (req, res) => {
  try {
    const rows = await sql`SELECT name, pid FROM users WHERE email = ${req.params.email}`;
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ name: rows[0].name, pid: rows[0].pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── AVATARS ─── */
app.get('/api/users/avatars', auth, async (req, res) => {
  try {
    const emails = (req.query.emails || '').split(',').map(e => e.trim()).filter(Boolean).slice(0, 50);
    if (!emails.length) return res.json({});
    const rows = await sql`SELECT email, avatar FROM users WHERE email = ANY(${emails})`;
    const map = {};
    rows.forEach(r => { if (r.avatar) map[r.email] = r.avatar; });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/me/avatar', auth, async (req, res) => {
  try {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: 'Avatar requis' });
    if (avatar.length > 600000) return res.status(400).json({ error: 'Image trop lourde (max ~450 Ko)' });
    if (!avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Format invalide' });
    // ALTER TABLE déjà fait au démarrage dans ensureSettingsTable()
    await sql`UPDATE users SET avatar = ${avatar} WHERE email = ${req.user.email}`;
    invalidateUser(req.user.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/me', auth, async (req, res) => {
  try {
    const { name, email, phone, location, pid, graduate_pid } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if (pid && !/^\d{7}$/.test(pid)) return res.status(400).json({ error: 'PID invalide' });
    if (graduate_pid && !/^\d{7}$/.test(graduate_pid)) return res.status(400).json({ error: 'PID gradué invalide (7 chiffres)' });
    const newEmail = email.toLowerCase();
    // Parallélisation des vérifications préalables
    const [existingRows, gradRows] = await Promise.all([
      (newEmail !== req.user.email) ? sql`SELECT email FROM users WHERE email = ${newEmail}` : Promise.resolve([]),
      graduate_pid ? sql`SELECT email, name FROM users WHERE pid = ${graduate_pid}` : Promise.resolve([])
    ]);
    if (newEmail !== req.user.email && existingRows.length) return res.status(400).json({ error: 'Email déjà utilisé' });
    let resolvedGradEmail = null;
    let resolvedGradName = null;
    if (graduate_pid) {
      if (!gradRows.length) return res.status(400).json({ error: 'Aucun gradué trouvé avec ce PID' });
      resolvedGradEmail = gradRows[0].email;
      resolvedGradName = gradRows[0].name;
    }
    // 1 seule requête : UPDATE + RETURNING remplace UPDATE + SELECT
    const rows = await sql`UPDATE users SET name=${name}, email=${newEmail}, phone=${phone||''}, location=${location||''}, pid=${pid||''}, graduate_pid=${graduate_pid||null}, graduate_email=${resolvedGradEmail} WHERE email=${req.user.email} RETURNING *`;
    invalidateUser(req.user.email);
    invalidateUser(newEmail);
    const { password: _, ...safeUser } = rows[0];
    const newToken = jwt.sign({ email: newEmail }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: safeUser, token: newToken, graduate_name: resolvedGradName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/me/lang', auth, async (req, res) => {
  try {
    const lang = normalizeLang(req.body.lang);
    if (!lang) return res.status(400).json({ error: 'Langue invalide' });
    await sql`UPDATE users SET lang = ${lang} WHERE email = ${req.user.email}`;
    invalidateUser(req.user.email);
    res.json({ ok: true, lang });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/me/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const rows = await sql`SELECT password FROM users WHERE email = ${req.user.email}`;
    if (!bcrypt.compareSync(currentPassword, rows[0].password)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = bcrypt.hashSync(newPassword, 10);
    await sql`UPDATE users SET password = ${hash} WHERE email = ${req.user.email}`;
    invalidateUser(req.user.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Onboarding : l'utilisateur déclare lui-même les programmes qu'il a complétés
app.put('/api/me/programs', auth, async (req, res) => {
  try {
    const { programs } = req.body;
    const progs = Array.isArray(programs) ? programs.filter(p => typeof p === 'string') : [];
    // Vérifier que tous les programmes existent en base
    if (progs.length) {
      const validRows = await sql`SELECT key FROM programs WHERE key = ANY(${progs})`;
      const validKeys = new Set(validRows.map(r => r.key));
      const invalid = progs.filter(p => !validKeys.has(p));
      if (invalid.length) return res.status(400).json({ error: 'Programme(s) inconnu(s) : ' + invalid.join(', ') });
    }
    // Déterminer automatiquement la fonction : gradué si au moins 1 programme, sinon invité
    const newFonction = progs.length > 0 ? 'gradué' : 'invité';
    const rows = await sql`UPDATE users SET programs=${JSON.stringify(progs)}::jsonb, fonction=${newFonction} WHERE email=${req.user.email} RETURNING *`;
    invalidateUser(req.user.email);
    const { password: _, ...safeUser } = rows[0];
    res.json({ ok: true, user: safeUser });
  } catch (e) {
    console.error('PUT /me/programs error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   PROGRAMS
════════════════════════════════════════ */

app.get('/api/programs', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM programs ORDER BY sort_order ASC, key ASC`;
    const map = {};
    rows.forEach(r => {
      map[r.key] = { label: r.label, icon: r.icon, desc: r.desc, prereq: r.prereq, prereqMode: r.prereq_mode, badge: r.badge, isSeminar: r.is_seminar, sortOrder: r.sort_order };
    });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/programs', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u) && !hasPerm(u, 'canManagePrograms')) return res.status(403).json({ error: 'Accès refusé' });
    const { key, label, icon, desc, badge } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'Clé et nom requis' });
    await sql`INSERT INTO programs (key, label, icon, desc, prereq, badge) VALUES (${key}, ${label}, ${icon||'📌'}, ${desc||''}, '[]', ${badge||key})`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/programs/:key', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u) && !hasPerm(u, 'canManagePrograms')) return res.status(403).json({ error: 'Accès refusé' });
    const { label, icon, desc, badge } = req.body;
    await sql`UPDATE programs SET label=${label}, icon=${icon}, "desc"=${desc}, badge=${badge} WHERE key=${req.params.key}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/programs/:key', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`DELETE FROM programs WHERE key = ${req.params.key}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   UPLOAD (Cloudinary)
════════════════════════════════════════ */

app.post('/api/upload', auth, async (req, res) => {
  try {
    const { data, name, type } = req.body;
    if (!data) return res.status(400).json({ error: 'Données manquantes' });
    const isVideo = type && type.startsWith('video/');
    const isPdf   = type && type.includes('pdf');
    const resourceType = isVideo ? 'video' : (isPdf ? 'raw' : 'image');
    const result = await cloudinary.uploader.upload(data, {
      resource_type: resourceType,
      folder: 'landmark-pacifique',
      public_id: uuidv4().slice(0, 12),
      use_filename: false,
    });
    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    res.status(500).json({ error: 'Erreur upload: ' + e.message });
  }
});

/* ════════════════════════════════════════
   POSTS
════════════════════════════════════════ */

app.get('/api/posts', auth, async (req, res) => {
  try {
    const { section } = req.query;
    const rows = section
      ? await sql`SELECT * FROM posts WHERE section = ${section} ORDER BY created_at DESC`
      : await sql`SELECT * FROM posts ORDER BY created_at DESC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const { section, title, body, tag, attachments } = req.body;
    if (!body) return res.status(400).json({ error: 'Corps du post requis' });
    if (section !== 'guest' && !u.programs.includes(section)) return res.status(403).json({ error: 'Accès refusé' });
    const id = 'p' + uuidv4().slice(0, 8);
    const now = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const atts = Array.isArray(attachments) ? attachments : [];
    const totalSize = atts.reduce((s, a) => s + (a.data ? a.data.length : 0), 0);
    if (totalSize > 50 * 1024 * 1024) return res.status(400).json({ error: 'Pièces jointes trop lourdes (max 50 Mo total)' });
    // 1 seule requête : INSERT + RETURNING remplace INSERT + SELECT
    const rows = await sql`INSERT INTO posts (id, section, author, author_email, title, body, tag, date, reactions, comments, attachments) VALUES (${id}, ${section}, ${u.name}, ${u.email}, ${title||null}, ${body}, ${tag||null}, ${now}, '{}', '[]', ${JSON.stringify(atts)}::jsonb) RETURNING *`;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/posts/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const rows = await sql`SELECT * FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    const post = rows[0];
    if (post.author_email !== u.email && !isAdmin(u) && !hasPerm(u, 'canManageFeed')) return res.status(403).json({ error: 'Accès refusé' });
    const { title, body, attachments } = req.body;
    if (!body) return res.status(400).json({ error: 'Corps du post requis' });
    const atts = Array.isArray(attachments) ? attachments : (post.attachments || []);
    await sql`UPDATE posts SET title=${title||null}, body=${body}, attachments=${JSON.stringify(atts)}::jsonb WHERE id=${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const rows = await sql`SELECT * FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    const post = rows[0];
    if (post.author_email !== u.email && !isAdmin(u) && !hasPerm(u, 'canManageFeed')) return res.status(403).json({ error: 'Accès refusé' });
    await sql`DELETE FROM posts WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/posts/:id/react', auth, async (req, res) => {
  try {
    const { key } = req.body;
    const rows = await sql`SELECT reactions FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    let reactions = rows[0].reactions || {};
    if (!reactions[key]) reactions[key] = [];
    const idx = reactions[key].indexOf(req.user.email);
    if (idx === -1) reactions[key].push(req.user.email);
    else reactions[key].splice(idx, 1);
    await sql`UPDATE posts SET reactions = ${JSON.stringify(reactions)}::jsonb WHERE id = ${req.params.id}`;
    res.json({ ok: true, reactions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'Commentaire vide' });
    const rows = await sql`SELECT comments FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    const comments = rows[0].comments || [];
    comments.push({ author: u.name, author_email: u.email, body, date: new Date().toISOString() });
    await sql`UPDATE posts SET comments = ${JSON.stringify(comments)}::jsonb WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/posts/:id/comments/:index', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'Commentaire vide' });
    const rows = await sql`SELECT comments FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    const comments = rows[0].comments || [];
    const idx = parseInt(req.params.index);
    if (!comments[idx]) return res.status(404).json({ error: 'Commentaire introuvable' });
    if (comments[idx].author_email !== u.email && !isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    comments[idx].body = body;
    await sql`UPDATE posts SET comments = ${JSON.stringify(comments)}::jsonb WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/posts/:id/comments/:index', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const rows = await sql`SELECT comments FROM posts WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Post introuvable' });
    const comments = rows[0].comments || [];
    const idx = parseInt(req.params.index);
    if (!comments[idx]) return res.status(404).json({ error: 'Commentaire introuvable' });
    if (comments[idx].author_email !== u.email && !isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    comments.splice(idx, 1);
    await sql`UPDATE posts SET comments = ${JSON.stringify(comments)}::jsonb WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   INTRO TYPES
════════════════════════════════════════ */

app.get('/api/intro-types', async (req, res) => {
  try {
    // Table + seed déjà créés au démarrage dans initDB()
    const rows = await sql`SELECT * FROM intro_types ORDER BY sort_order ASC, key ASC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/intro-types', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const { key, label, color } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'Clé et label requis' });
    const safeKey = key.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    await sql`INSERT INTO intro_types (key, label, color, is_default, sort_order)
      VALUES (${safeKey}, ${label}, ${color||'#6B7A90'}, false, 99)
      ON CONFLICT (key) DO UPDATE SET label=${label}, color=${color||'#6B7A90'}`;
    res.json({ ok: true, key: safeKey });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/intro-types/:key', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`DELETE FROM intro_types WHERE key = ${req.params.key} AND is_default = false`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   INTROS
════════════════════════════════════════ */

app.get('/api/intros', async (req, res) => {
  try {
    // ── Archives : accessible aux admins et superadmins ──
    if (req.query.archived === 'true') {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      let canViewArchives = false;
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const u = await getUser(decoded.email);
        canViewArchives = u && isAdmin(u);
      } catch {}
      if (!canViewArchives) return res.status(403).json({ error: 'Accès refusé' });
      const rows = await sql`SELECT * FROM intros WHERE archived = true ORDER BY archived_at DESC`;
      return res.json(rows);
    }

    const rows = await sql`SELECT * FROM intros WHERE archived = false ORDER BY date ASC`;

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    let userEmail = null;
    if (token) {
      try { const decoded = jwt.verify(token, JWT_SECRET); userEmail = decoded.email; } catch {}
    }

    const nowUTC = Date.now();

    // ── Auto-archivage batch (1 seule requête au lieu de N) ──
    const toAutoArchive = rows.filter(intro => {
      if (!intro.date) return false;
      const midnightTahitiUTC = new Date(`${intro.date}T24:00:00-10:00`).getTime();
      return nowUTC >= midnightTahitiUTC;
    });
    if (toAutoArchive.length > 0) {
      const ids = toAutoArchive.map(i => i.id);
      await sql`UPDATE intros SET archived = true, archived_at = NOW(), archived_by = 'system' WHERE id = ANY(${ids})`.catch(() => {});
      console.log(`✅ Auto-archivé ${toAutoArchive.length} introduction(s) passée(s)`);
    }

    const activeRows = rows.filter(intro => !toAutoArchive.find(a => a.id === intro.id));

    // Parallélisation : user + programs en 1 batch au lieu de 2 requêtes séquentielles
    const [uRows, progRows] = await Promise.all([
      userEmail ? sql`SELECT programs, role, fonction, permissions FROM users WHERE email = ${userEmail}` : Promise.resolve([]),
      sql`SELECT key, prereq FROM programs`
    ]);

    let userPrograms = [];
    let userRole = null;
    let userFonction = 'invité';
    if (uRows.length) { userPrograms = uRows[0].programs || []; userRole = uRows[0].role; userFonction = uRows[0].fonction || 'invité'; }
    const fLow = (userFonction || '').toLowerCase();
    const isLeaderOrAdmin = ['admin', 'superadmin'].includes(userRole) || LEADER_FONCTIONS.includes(fLow) || fLow === 'gradué';

    const filtered = activeRows.filter(intro => {
      if (!intro.date || !intro.heure) return true;
      const eventStartUTC = new Date(`${intro.date}T${intro.heure}:00-10:00`).getTime();
      const midnightTahitiUTC = new Date(`${intro.date}T24:00:00-10:00`).getTime();
      const oneHourBeforeUTC = eventStartUTC - 60 * 60 * 1000;
      if (isLeaderOrAdmin) return nowUTC < midnightTahitiUTC;
      const regs = intro.registrations || [];
      const isRegistered = userEmail && regs.some(r => r.email && r.email.toLowerCase() === userEmail.toLowerCase());
      if (isRegistered) return nowUTC < midnightTahitiUTC;
      else return nowUTC < oneHourBeforeUTC;
    });

    let prereqMap = {};
    progRows.forEach(p => { prereqMap[p.key] = p.prereq || []; });

    const visibleIntros = filtered.filter(intro => {
      if (!intro.target_program || intro.target_program === 'Forum') return true;
      if (isLeaderOrAdmin) return true;
      const prereqs = prereqMap[intro.target_program] || [];
      if (prereqs.length === 0) return true;
      return prereqs.some(prereq => userPrograms.includes(prereq));
    });

    // ─── Restriction gradué : ne voit que les événements de ses programmes ───
    // ─── Masquage de la liste des inscrits selon permissions ───
    const isGrad = fLow === 'gradué';
    const fullUser = uRows.length ? { role: userRole, fonction: userFonction, programs: userPrograms, permissions: (uRows[0].permissions || {}) } : null;
    let finalIntros = visibleIntros;
    if (fullUser && isGrad) {
      finalIntros = visibleIntros.filter(intro => canGraduateSeeEvent(fullUser, intro.target_program));
    }
    if (fullUser && !isLeaderOrAdmin || (fullUser && isGrad)) {
      // Pour les gradués : masquer la liste détaillée si pas la permission, garder uniquement le compteur
      finalIntros = finalIntros.map(intro => {
        if (isLeaderOrAdmin && !isGrad) return intro;
        if (canSeeParticipants(fullUser, intro.target_program)) return intro;
        const regs = intro.registrations || [];
        return { ...intro, registrations: [], regs_count_hidden: regs.length };
      });
    }

    res.json(finalIntros);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/intros', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const isGrad = (u.fonction || '').toLowerCase() === 'gradué';
    // Gradués peuvent créer des intros Forum ; leaders/admins peuvent tout créer
    const canCreate = isAdmin(u) || hasPerm(u, 'canAddIntro') || isLeader(u) || isGrad;
    if (!canCreate) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    if (!d.titre || !d.date) return res.status(400).json({ error: 'Titre et date requis' });

    // Intros Forum : leaders, admins, et gradués autorisés
    if ((!d.targetProgram || d.targetProgram === 'Forum') && !isAdmin(u) && !LEADER_FONCTIONS.includes(u.fonction) && !isGrad) {
      return res.status(403).json({ error: 'Seuls les leaders ou gradués peuvent créer une introduction au Forum' });
    }
    if (d.targetProgram && d.targetProgram !== 'Forum' && !isAdmin(u)) {
      const userPrograms = u.programs || [];
      if (!userPrograms.includes(d.targetProgram)) {
        return res.status(403).json({ error: `Vous devez avoir complété le programme "${d.targetProgram}" pour créer cette introduction` });
      }
    }

    const id = 'i' + Date.now();
    await sql`INSERT INTO intros (id, type, titre, theme, date, heure, heure_fin, format, location, zoom_url, animateur, animateur_email, rc_name, opm_name, cc_date, cc_heure, zoom_cc, capacite, media_url, target_program, registrations)
      VALUES (${id}, ${d.type||'forum'}, ${d.titre}, ${d.theme||''}, ${d.date}, ${d.heure||''}, ${d.heureFin||''}, ${d.format||'presentiel'}, ${d.location||''}, ${d.zoomUrl||''}, ${d.animateur||''}, ${d.animateurEmail||''}, ${d.rcName||''}, ${d.opmName||''}, ${d.ccDate||''}, ${d.ccHeure||''}, ${d.zoomCC||''}, ${d.capacite||null}, ${d.mediaUrl||null}, ${d.targetProgram||null}, '[]')`;

    // Notifications en parallèle (fire-and-forget)
    Promise.resolve().then(async () => {
      try {
        // Parallélisation : programs + users en 1 batch
        const [progRows, allUsers] = await Promise.all([
          sql`SELECT key, prereq FROM programs`,
          sql`SELECT email, programs, role, fonction FROM users`
        ]);
        const prereqMap = {};
        progRows.forEach(p => { prereqMap[p.key] = p.prereq || []; });
        const targetProg = d.targetProgram || null;
        // Batch notification insert en 1 seule requête
        const recipients = allUsers
          .filter(member => member.email !== u.email)
          .filter(member => {
            const memberRole     = member.role;
            const memberFonction = member.fonction || 'invité';
            const memberPrograms = member.programs || [];
            const isLeaderOrAdmin = ['admin', 'superadmin'].includes(memberRole) || LEADER_FONCTIONS.includes(memberFonction) || memberFonction === 'gradué';
            if (!targetProg) return true;
            if (isLeaderOrAdmin) return true;
            const prereqs = prereqMap[targetProg] || [];
            return prereqs.length === 0 || prereqs.some(prereq => memberPrograms.includes(prereq));
          })
          .map(m => m.email);
        if (recipients.length) {
          const msg = `Nouvel évènement : "${d.titre}" le ${d.date}`;
          await sql`
            INSERT INTO notifications (recipient_email, type, message, link, read, created_at)
            SELECT email, 'event', ${msg}, '#events', false, NOW()
            FROM unnest(${recipients}::text[]) AS t(email)`;
        }
      } catch(notifErr) { console.error('Notif intro error:', notifErr.message); }
    });

    // Google Calendar (contact@landmark-pacifique.fr) : intro + creation call, fire-and-forget
    Promise.resolve().then(async () => {
      try {
        const updates = await gcal.syncIntroCalendarEvents({
          id, titre: d.titre, date: d.date, heure: d.heure || '', heure_fin: d.heureFin || '',
          zoom_url: d.zoomUrl || '', location: d.location || '', animateur: d.animateur || '',
          animateur_email: d.animateurEmail || '', rc_name: d.rcName || '', opm_name: d.opmName || '',
          cc_date: d.ccDate || '', cc_heure: d.ccHeure || '', zoom_cc: d.zoomCC || '',
        });
        if (updates.gcal_event_id || updates.gcal_cc_event_id) {
          await sql`UPDATE intros SET
              gcal_event_id = COALESCE(${updates.gcal_event_id || null}, gcal_event_id),
              gcal_cc_event_id = COALESCE(${updates.gcal_cc_event_id || null}, gcal_cc_event_id),
              gcal_attendees = COALESCE(${updates.gcal_attendees || null}, gcal_attendees),
              gcal_cc_attendees = COALESCE(${updates.gcal_cc_attendees || null}, gcal_cc_attendees)
            WHERE id = ${id}`;
        }
      } catch (gcalErr) { console.error('GCal intro error:', gcalErr.message); }
    });

    broadcast('intro_created', { id, titre: d.titre, date: d.date });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/intros/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!hasPerm(u, 'canEditIntro') && !isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;

    if ((!d.targetProgram || d.targetProgram === 'Forum') && !isAdmin(u) && !LEADER_FONCTIONS.includes(u.fonction)) {
      return res.status(403).json({ error: 'Seuls les leaders d\'introduction peuvent modifier une introduction au Forum' });
    }
    if (d.targetProgram && d.targetProgram !== 'Forum' && !isAdmin(u)) {
      const userPrograms = u.programs || [];
      if (!userPrograms.includes(d.targetProgram)) {
        return res.status(403).json({ error: `Vous devez avoir complété le programme "${d.targetProgram}" pour modifier cette introduction` });
      }
    }

    const beforeRows = await sql`SELECT date, heure, heure_fin, cc_date, cc_heure FROM intros WHERE id = ${req.params.id}`;
    const before = beforeRows[0] || {};

    await sql`UPDATE intros SET type=${d.type}, titre=${d.titre}, theme=${d.theme||''}, date=${d.date}, heure=${d.heure||''}, heure_fin=${d.heureFin||''}, format=${d.format||'presentiel'}, location=${d.location||''}, zoom_url=${d.zoomUrl||''}, animateur=${d.animateur||''}, animateur_email=${d.animateurEmail||''}, rc_name=${d.rcName||''}, opm_name=${d.opmName||''}, cc_date=${d.ccDate||''}, cc_heure=${d.ccHeure||''}, zoom_cc=${d.zoomCC||''}, capacite=${d.capacite||null}, media_url=${d.mediaUrl||null}, target_program=${d.targetProgram||null} WHERE id=${req.params.id}`;

    // Un changement de date/heure (intro ou creation call) doit renvoyer une mise à
    // jour de l'invitation aux invités déjà notifiés (Google Calendar + email).
    const timeChanged = !!before.date && (
      before.date !== d.date ||
      (before.heure || '') !== (d.heure || '') ||
      (before.heure_fin || '') !== (d.heureFin || '') ||
      (before.cc_date || '') !== (d.ccDate || '') ||
      (before.cc_heure || '') !== (d.ccHeure || '')
    );

    // Google Calendar : si l'animateur/RC/OPM ont été renseignés ou modifiés ici, il faut
    // (re)créer/mettre à jour l'invitation Google Calendar en conséquence, fire-and-forget.
    // Si l'horaire a changé, on notifie aussi par email les invités (guests) qui ne sont
    // pas sur Google Calendar.
    Promise.resolve().then(async () => {
      try {
        const rows = await sql`SELECT * FROM intros WHERE id = ${req.params.id}`;
        const intro = rows[0];
        if (!intro) return;
        if (!intro.gcal_event_id) {
          const updates = await gcal.syncIntroCalendarEvents(intro);
          if (updates.gcal_event_id || updates.gcal_cc_event_id) {
            await sql`UPDATE intros SET
                gcal_event_id = COALESCE(${updates.gcal_event_id || null}, gcal_event_id),
                gcal_cc_event_id = COALESCE(${updates.gcal_cc_event_id || null}, gcal_cc_event_id),
                gcal_attendees = COALESCE(${updates.gcal_attendees || null}, gcal_attendees),
                gcal_cc_attendees = COALESCE(${updates.gcal_cc_attendees || null}, gcal_cc_attendees)
              WHERE id = ${req.params.id}`;
          }
        } else {
          await gcal.syncIntroAttendeesAndDescription(intro, timeChanged);
        }

        if (timeChanged) {
          const guests = (intro.registrations || []).filter(r => !r.isGraduate && r.email);
          if (guests.length) {
            const tz = computeTimezones(intro);
            await Promise.all(guests.map(async (reg) => {
              try {
                const tokenRows = await sql`SELECT token FROM invitation_tokens WHERE intro_id = ${req.params.id} AND guest_email = ${reg.email.toLowerCase()} ORDER BY created_at DESC LIMIT 1`;
                const invitationLink = tokenRows.length
                  ? `${process.env.APP_URL || 'https://landmark-pacifique.fr'}/#invitation/${tokenRows[0].token}`
                  : null;
                await sendAppMail({
                  type: 'guest_update',
                  to_email: reg.email,
                  to_name: `${reg.firstname || ''} ${reg.lastname || ''}`.trim(),
                  invitation_link: invitationLink,
                  guest: { firstname: reg.firstname, lastname: reg.lastname, email: reg.email, phone: reg.phone },
                  graduate: { name: reg.invitedBy || '', email: reg.invitedByEmail || '' },
                  event: {
                    id: intro.id, titre: intro.titre,
                    date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
                    date_iso: tz.date_iso,
                    heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
                    heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
                    format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
                    cc_date_iso: tz.cc_date_iso,
                    cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
                    cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
                    zoom_cc: tz.zoom_cc
                  }
                });
              } catch (mailErr) { console.error('Email guest_update error:', mailErr.message); }
            }));
          }
        }
      } catch (gcalErr) { console.error('GCal update intro error:', gcalErr.message); }
    });

    broadcast('intro_updated', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/intros/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!hasPerm(u, 'canDeleteIntro') && !isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    // Récupère l'intro avant archivage pour pouvoir annuler ses invitations Google Calendar.
    const introRows = await sql`SELECT * FROM intros WHERE id = ${req.params.id} AND archived = false`;
    if (!introRows.length) return res.status(404).json({ error: 'Introduction introuvable' });
    const intro = introRows[0];
    const reason = ((req.body && req.body.reason) || '').trim() || null;
    await sql`UPDATE intros SET archived = true, archived_at = NOW(), archived_by = ${u.email}, cancel_reason = ${reason} WHERE id = ${req.params.id}`;
    broadcast('intro_deleted', { id: req.params.id });
    res.json({ ok: true, archived: true });

    // Archivage manuel : retire les invitations déjà envoyées (Google Calendar +
    // liens d'invitation email), fire-and-forget.
    Promise.resolve().then(async () => {
      try { await gcal.cancelIntroCalendarEvents(intro); }
      catch (gcalErr) { console.error('GCal cancel intro on archive error:', gcalErr.message); }
      try { await sql`DELETE FROM invitation_tokens WHERE intro_id = ${req.params.id} AND used = false`; }
      catch (tokenErr) { console.error('Invitation tokens cleanup on archive error:', tokenErr.message); }

      // Annulation avec raison : prévenir le leader de l'introduction, les team leaders et le staff par email.
      if (reason) {
        try {
          const recipients = [];
          const seenEmails = new Set();
          if (intro.animateur_email) { recipients.push({ email: intro.animateur_email, name: intro.animateur || '' }); seenEmails.add(intro.animateur_email.toLowerCase()); }
          const teamRows = await sql`SELECT email, name FROM users WHERE LOWER(fonction) IN ('team leader il', 'staff')`;
          for (const row of teamRows) {
            if (!seenEmails.has(row.email.toLowerCase())) { recipients.push({ email: row.email, name: row.name }); seenEmails.add(row.email.toLowerCase()); }
          }
          const tzFr = computeTimezones(intro, 'fr-FR');
          const tzEn = computeTimezones(intro, 'en-US');
          const buildEvent = tz => ({
            titre: intro.titre,
            date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr, date_long_nz: tz.date_long_nz,
            heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr, heure_nz: tz.heure_nz,
            format: intro.format, location: intro.location,
          });
          for (const r of recipients) {
            await sendAppMail({
              type: 'intro_cancelled',
              to_email: r.email,
              to_name: r.name,
              event_fr: buildEvent(tzFr),
              event_en: buildEvent(tzEn),
              reason,
            });
          }
        } catch (mailErr) { console.error('Intro cancellation email error:', mailErr.message); }
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/intros/:id/unarchive', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!hasPerm(u, 'canDeleteIntro') && !isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    // 1 seule requête : UPDATE + RETURNING remplace SELECT + UPDATE
    const rows = await sql`UPDATE intros SET archived = false, archived_at = NULL, archived_by = NULL WHERE id = ${req.params.id} AND archived = true RETURNING id`;
    if (!rows.length) return res.status(404).json({ error: 'Introduction introuvable ou non archivée' });
    res.json({ ok: true, unarchived: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/intros/:id/permanent', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé — superadmin uniquement' });
    await sql`DELETE FROM intros WHERE id = ${req.params.id}`;
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   REGISTER
════════════════════════════════════════ */

async function performIntroRegistration(introId, body, callerToken) {
  const { firstname, lastname, phone, invitedBy, isGraduate, graduatePid, selfRegister } = body;
  // Email normalisé (minuscules, sans espaces) : c'est celui du compte créé à l'activation,
  // le site retrouve ainsi l'inscription de l'invité quelle que soit sa saisie.
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
  const invitedByEmail = body.invitedByEmail ? body.invitedByEmail.toLowerCase() : body.invitedByEmail;
  if (!firstname || !lastname || !email) { const err = new Error('Champs obligatoires manquants'); err.status = 400; throw err; }
  if (!phone && !selfRegister) { const err = new Error('Champs obligatoires manquants'); err.status = 400; throw err; }

  if (invitedBy && callerToken) {
    try {
      const decoded = jwt.verify(callerToken, JWT_SECRET);
      const callerRows = await sql`SELECT role, fonction FROM users WHERE email = ${decoded.email}`;
      if (callerRows.length && !isLeader(callerRows[0])) {
        const err = new Error('Seuls les gradués et leaders peuvent inviter des participants'); err.status = 403; throw err;
      }
    } catch (e) { if (e.status) throw e; }
  }

  if (!invitedBy && !graduatePid && !selfRegister) {
    const err = new Error('Le numéro PID de votre gradué est obligatoire'); err.status = 400; throw err;
  }
  if (graduatePid && !/^\d{7}$/.test(graduatePid)) {
    const err = new Error('PID invalide (7 chiffres requis)'); err.status = 400; throw err;
  }

  let resolvedGraduateEmail = invitedByEmail || null;
  let resolvedGraduateName = invitedBy || null;
  let resolvedGraduatePid = graduatePid || null;

  // Parallélisation : résolution gradué + fetch intro lancés ensemble
  const introPromise = sql`SELECT * FROM intros WHERE id = ${introId}`;
  let gradResolvePromise;
  if (graduatePid) {
    gradResolvePromise = sql`SELECT email, name FROM users WHERE pid = ${graduatePid}`;
  } else if (invitedByEmail) {
    gradResolvePromise = sql`SELECT name FROM users WHERE email = ${invitedByEmail}`;
  } else if (selfRegister) {
    // 1 seule requête combinée : member + gradué (par email ou pid) via LEFT JOIN
    gradResolvePromise = sql`
      SELECT m.graduate_email, m.graduate_pid,
             COALESCE(g1.name, g2.name) AS grad_name,
             COALESCE(g1.email, g2.email) AS grad_resolved_email
      FROM users m
      LEFT JOIN users g1 ON g1.email = m.graduate_email
      LEFT JOIN users g2 ON g2.pid = m.graduate_pid AND m.graduate_email IS NULL
      WHERE m.email = ${email.toLowerCase()}`;
  } else {
    gradResolvePromise = Promise.resolve([]);
  }

  const [gradResolveRows, rows] = await Promise.all([gradResolvePromise, introPromise]);

  if (graduatePid) {
    if (!gradResolveRows.length) { const err = new Error('Aucun gradué trouvé avec ce PID'); err.status = 400; throw err; }
    resolvedGraduateEmail = gradResolveRows[0].email;
    resolvedGraduateName = gradResolveRows[0].name;
  } else if (invitedByEmail) {
    if (gradResolveRows.length) resolvedGraduateName = gradResolveRows[0].name;
  } else if (selfRegister && gradResolveRows.length) {
    const m = gradResolveRows[0];
    if (m.graduate_email) {
      resolvedGraduateEmail = m.graduate_email;
      resolvedGraduatePid = m.graduate_pid || null;
      if (m.grad_name) resolvedGraduateName = m.grad_name;
    } else if (m.graduate_pid) {
      resolvedGraduatePid = m.graduate_pid;
      if (m.grad_resolved_email) {
        resolvedGraduateEmail = m.grad_resolved_email;
        resolvedGraduateName = m.grad_name;
      }
    }
  }

  if (!rows.length) { const err = new Error('Introduction introuvable'); err.status = 404; throw err; }
  const intro = rows[0];
    const regs = intro.registrations || [];
    if (regs.find(r => r.email && r.email.toLowerCase() === email.toLowerCase())) {
      const err = new Error('Déjà inscrit·e à cette introduction'); err.status = 400; throw err;
    }

    // Toute inscription est confirmée d'emblée. Pour un invité inscrit par un gradué, l'email
    // (token d'invitation) ne sert plus qu'à activer son compte, pas à confirmer sa place.
    const confirmedNow = true;
    const accountActivationPending = !!invitedBy && !selfRegister;

    regs.push({
      id: 'r' + uuidv4().slice(0, 8),
      firstname, lastname, email, phone,
      invitedBy: resolvedGraduateName || null,
      invitedByEmail: resolvedGraduateEmail,
      graduatePid: resolvedGraduatePid,
      isGraduate: !!isGraduate,
      confirmed: confirmedNow,
      confirmed_at: confirmedNow ? new Date().toISOString() : null,
      date: new Date().toISOString()
    });
    // Parallélisation : UPDATE intros + UPDATE users graduate en 1 batch
    await Promise.all([
      sql`UPDATE intros SET registrations = ${JSON.stringify(regs)} WHERE id = ${introId}`,
      resolvedGraduateEmail
        ? sql`UPDATE users SET graduate_pid = ${resolvedGraduatePid}, graduate_email = ${resolvedGraduateEmail} WHERE email = ${email.toLowerCase()}`.catch(() => {})
        : Promise.resolve()
    ]);

    // Google Calendar : rafraîchit la description et invite les nouveaux gradués/OPM/RC, fire-and-forget
    gcal.syncIntroAttendeesAndDescription({ ...intro, registrations: regs }).catch(gcalErr => console.error('GCal guest count error:', gcalErr.message));

    // ── AUTO-ENROLL : si l'intro a un appel de création associé, inscrire automatiquement ──
    try {
      const linkedCCs = await sql`SELECT id, titre, date, heure, zoom_url, location, format FROM creation_calls WHERE intro_id = ${introId} AND archived = false`;
      if (linkedCCs.length) {
        const cc = linkedCCs[0];
        await sql`INSERT INTO event_registrations (event_type, event_id, user_email, user_name, source, parent_intro_id)
          VALUES ('creation_call', ${cc.id}, ${email.toLowerCase()}, ${firstname + ' ' + lastname}, 'auto', ${introId})
          ON CONFLICT (event_type, event_id, user_email) DO NOTHING`;
        broadcast('creation_call_registered', { id: cc.id, email: email.toLowerCase(), source: 'auto', intro_id: introId });
        // Email dédié auto-enroll
        sendAppMail({
          type: 'creation_call_auto_enroll',
          to_email: email, to_name: firstname + ' ' + lastname,
          intro: { id: intro.id, titre: intro.titre, date: intro.date, heure: intro.heure },
          creation_call: { id: cc.id, titre: cc.titre, date: cc.date, heure: cc.heure, zoom_url: cc.zoom_url, location: cc.location, format: cc.format },
          message: "Tu es inscrit à l'introduction. Merci de participer à l'appel de création avec au moins un invité confirmé."
        }).catch(err => console.error('Email auto-enroll CC:', err.message));
      }
    } catch(autoErr){ console.error('Auto-enroll CC error:', autoErr.message); }

    broadcast('intro_registered', { intro_id: introId, email: email.toLowerCase() });

    // ── Email 1 : invitation par un gradué connecté ──
    if (invitedBy) {
      try {
        const invitationToken = uuidv4();
        await ensureInvitationTokensTable();
        await sql`
          INSERT INTO invitation_tokens (token, intro_id, guest_firstname, guest_lastname, guest_email, guest_phone, graduate_name, graduate_email, used, created_at)
          VALUES (${invitationToken}, ${introId}, ${firstname}, ${lastname}, ${email}, ${phone||''}, ${resolvedGraduateName || ''}, ${resolvedGraduateEmail || ''}, false, ${Date.now()})
          ON CONFLICT (token) DO NOTHING
        `;
        const invitationLink = `${process.env.APP_URL || 'https://landmark-pacifique.fr'}/#invitation/${invitationToken}`;
        const isComm = intro.type && intro.type.toLowerCase().includes('comm');
        const webhookType = intro.type === 'special'
          ? 'invite_special_event_guest'
          : (isComm ? 'guest_com' : 'guest');
        const tz = computeTimezones(intro);
        const mailResult = await sendAppMail({
          type: webhookType,
          to_email: email,
          to_name: firstname + ' ' + lastname,
          invitation_link: invitationLink,
          guest: { firstname, lastname, email, phone },
          graduate: { name: resolvedGraduateName || '', email: resolvedGraduateEmail || '' },
          event: {
            id: intro.id, titre: intro.titre,
            date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
            date_iso: tz.date_iso,
            heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
            heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
            format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
            cc_date_iso: tz.cc_date_iso,
            cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
            cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
            zoom_cc: tz.zoom_cc
          }
        });
        if (mailResult && mailResult.messageId) {
          await sql`UPDATE invitation_tokens SET message_id = ${mailResult.messageId} WHERE token = ${invitationToken}`.catch(() => {});
        } else {
          await sql`UPDATE invitation_tokens SET email_status = 'failed', email_status_at = ${Date.now()} WHERE token = ${invitationToken}`.catch(() => {});
        }
      } catch (webhookErr) {
        console.error('Email guest error:', webhookErr.message);
      }
    }

    // ── Email 2 : auto-inscription d'un membre connecté (selfRegister) ──
    if (!invitedBy && selfRegister) {
      try {
        const tz = computeTimezones(intro);
        // Réutilise les valeurs déjà résolues (plus de SELECT répétés)
        const gradInfo = { name: resolvedGraduateName || '', email: resolvedGraduateEmail || '' };
        const webhookType = intro.type === 'special' ? (isGraduate ? 'special_event_grad_confirmed' : 'special_event_guest_confirmed') : (isGraduate ? 'solo' : 'guest_self');
        await sendAppMail({
          type: webhookType,
          to_email: email,
          to_name: firstname + ' ' + lastname,
          guest: { firstname, lastname, email, phone },
          graduate: gradInfo,
          event: {
            id: intro.id, titre: intro.titre,
            date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
            date_iso: tz.date_iso,
            heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
            heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
            format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
            cc_date_iso: tz.cc_date_iso,
            cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
            cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
            zoom_cc: tz.zoom_cc
          }
        });
      } catch (webhookErr) {
        console.error('Email self-register error:', webhookErr.message);
      }
    }

    // ── Email 3 : inscription via PID (formulaire public, sans compte) ──
    if (!invitedBy && !selfRegister && graduatePid) {
      try {
        const tz = computeTimezones(intro);
        const webhookType = intro.type === 'special' ? 'special_event_pid_register' : 'guest_pid';
        await sendAppMail({
          type: webhookType,
          to_email: email,
          to_name: firstname + ' ' + lastname,
          guest: { firstname, lastname, email, phone },
          graduate: { name: resolvedGraduateName || '', email: resolvedGraduateEmail || '' },
          event: {
            id: intro.id, titre: intro.titre,
            date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
            date_iso: tz.date_iso,
            heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
            heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
            format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
            cc_date_iso: tz.cc_date_iso,
            cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
            cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
            zoom_cc: tz.zoom_cc
          }
        });
      } catch (webhookErr) {
        console.error('Email pid-register error:', webhookErr.message);
      }
    }

    // ── Email 4 : auto-inscription d'un gradué sur une intro solo ──
    if (isGraduate && selfRegister && intro.type === 'solo') {
      try {
        const tz = computeTimezones(intro);
        await sendAppMail({
          type: 'solo',
          to_email: email,
          to_name: firstname + ' ' + lastname,
          graduate: { firstname, lastname, email, phone },
          event: {
            id: intro.id, titre: intro.titre,
            date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
            date_iso: tz.date_iso,
            heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
            heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
            format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
            cc_date_iso: tz.cc_date_iso,
            cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
            cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
            zoom_cc: tz.zoom_cc
          }
        });
      } catch (webhookErr) {
        console.error('Email solo error:', webhookErr.message);
      }
    }

  return {
    ok: true,
    confirmed: confirmedNow,
    account_activation_pending: accountActivationPending,
    intro: {
      id: intro.id, titre: intro.titre, type: intro.type, theme: intro.theme || '',
      date: intro.date, heure: intro.heure, heure_fin: intro.heure_fin, format: intro.format,
      location: intro.location, animateur: intro.animateur
    }
  };
}

app.post('/api/intros/:id/register', async (req, res) => {
  try {
    const callerToken = (req.headers.authorization || '').replace('Bearer ', '');
    const result = await performIntroRegistration(req.params.id, req.body, callerToken);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Inscription via API key (utilisée par un site tiers) — même logique métier que l'inscription publique
app.post('/api/v1/intros/:id/register', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.register_intros) {
      await logApiKeyAudit({
        ...getAuditInfo(req),
        action: 'register_intro_denied',
        resourceType: 'intros',
        resourceId: req.params.id,
        requestBody: req.body,
        responseStatus: 403
      });
      return res.status(403).json({ error: 'Permission refusée: register_intros' });
    }

    const result = await performIntroRegistration(req.params.id, req.body);

    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'register_intro',
      resourceType: 'intros',
      resourceId: req.params.id,
      requestBody: req.body,
      responseStatus: 200
    });

    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'register_intro_failed',
      resourceType: 'intros',
      resourceId: req.params.id,
      requestBody: req.body,
      responseStatus: status
    });
    res.status(status).json({ error: e.message });
  }
});

app.delete('/api/intros/:id/register/:email', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (req.params.email !== u.email && !isLeader(u)) return res.status(403).json({ error: 'Accès refusé' });
    // 1 seule requête : UPDATE avec filtrage JSONB + RETURNING
    const rows = await sql`
      UPDATE intros
      SET registrations = COALESCE((
        SELECT jsonb_agg(r) FROM jsonb_array_elements(registrations) r
        WHERE r->>'email' <> ${req.params.email}
      ), '[]'::jsonb)
      WHERE id = ${req.params.id}
      RETURNING id`;
    if (!rows.length) return res.status(404).json({ error: 'Introduction introuvable' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── REMINDER ─── */
app.post('/api/intros/:id/reminder/:email', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isLeader(u)) return res.status(403).json({ error: 'Accès refusé' });
    if (!isMailConfigured()) return res.status(500).json({ error: 'Envoi d\'emails non configuré' });

    const guestEmail = req.params.email.toLowerCase();
    // Parallélisation : intro + token fetch lancés ensemble
    const [rows, tokenRows] = await Promise.all([
      sql`SELECT * FROM intros WHERE id = ${req.params.id}`,
      sql`SELECT token, used FROM invitation_tokens WHERE intro_id = ${req.params.id} AND guest_email = ${guestEmail} ORDER BY created_at DESC LIMIT 1`
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Introduction introuvable' });
    const intro = rows[0];

    const reg = (intro.registrations || []).find(r => r.email && r.email.toLowerCase() === guestEmail);
    if (!reg) return res.status(404).json({ error: 'Invité introuvable' });
    // Un rappel n'a de sens que tant que le compte de l'invité n'est pas activé (lien non cliqué).
    // Sans token (anciennes inscriptions), on retombe sur l'état « confirmé ».
    const accountActivated = tokenRows.length ? tokenRows[0].used : reg.confirmed;
    if (accountActivated) return res.status(400).json({ error: 'Cet invité a déjà activé son compte' });

    let invitationToken = tokenRows.length ? tokenRows[0].token : null;
    if (!invitationToken) {
      invitationToken = uuidv4();
      await sql`
        INSERT INTO invitation_tokens (token, intro_id, guest_firstname, guest_lastname, guest_email, guest_phone, graduate_name, graduate_email, used, created_at)
        VALUES (${invitationToken}, ${req.params.id}, ${reg.firstname||''}, ${reg.lastname||''}, ${guestEmail}, ${reg.phone||''}, ${reg.invitedBy||''}, ${reg.invitedByEmail||''}, false, ${Date.now()})
        ON CONFLICT (token) DO NOTHING
      `;
    }

    const invitationLink = `${process.env.APP_URL || 'https://landmark-pacifique.fr'}/#invitation/${invitationToken}`;
    const tz = computeTimezones(intro);
    const mailResult = await sendAppMail({
      type: 'guest_reminder',
      to_email: guestEmail,
      to_name: (reg.firstname || '') + ' ' + (reg.lastname || ''),
      invitation_link: invitationLink,
      guest: { firstname: reg.firstname, lastname: reg.lastname, email: guestEmail, phone: reg.phone },
      graduate: { name: reg.invitedBy || '', email: reg.invitedByEmail || '' },
      event: {
        id: intro.id, titre: intro.titre,
        date_long: tz.date_long, date_long_nc: tz.date_long_nc, date_long_fr: tz.date_long_fr,
        date_iso: tz.date_iso,
        heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr,
        heure_fin_tahiti: tz.heure_fin_tahiti, heure_fin_nc: tz.heure_fin_nc, heure_fin_fr: tz.heure_fin_fr,
        format: intro.format, location: intro.location, zoom_url: intro.zoom_url, animateur: intro.animateur, theme: intro.theme || '',
        cc_date_iso: tz.cc_date_iso,
        cc_date_long: tz.cc_date_long, cc_date_long_nc: tz.cc_date_long_nc, cc_date_long_fr: tz.cc_date_long_fr,
        cc_heure_tahiti: tz.cc_heure_tahiti, cc_heure_nc: tz.cc_heure_nc, cc_heure_fr: tz.cc_heure_fr,
        zoom_cc: tz.zoom_cc
      }
    });
    if (mailResult && mailResult.messageId) {
      await sql`UPDATE invitation_tokens SET message_id = ${mailResult.messageId}, email_status = 'sent', email_status_at = ${Date.now()} WHERE token = ${invitationToken}`.catch(() => {});
    } else {
      await sql`UPDATE invitation_tokens SET email_status = 'failed', email_status_at = ${Date.now()} WHERE token = ${invitationToken}`.catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Statut d'envoi des invitations pour "Mes invités" ───
   Renvoie, pour chaque invité de l'utilisateur connecté, l'état de livraison
   de l'email d'invitation (sent/delivered/opened/bounced/blocked/...). */
app.get('/api/my-guest-invitations', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT intro_id, guest_email, email_status, email_status_at, used
      FROM invitation_tokens
      WHERE graduate_email = ${req.user.email}
      ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Statut d'envoi des invitations pour "Liste des inscrits" (vue leader) ───
   Contrairement à /api/my-guest-invitations, pas filtré par graduate_email :
   un leader voit le statut de TOUS les invités d'une intro, comme il voit déjà
   toute la liste des inscrits dans ce même modal. */
app.get('/api/intros/:id/invitation-status', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isLeader(u)) return res.status(403).json({ error: 'Accès refusé' });
    const rows = await sql`
      SELECT guest_email, email_status, email_status_at, used
      FROM invitation_tokens
      WHERE intro_id = ${req.params.id}
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/members', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const rows = await sql`SELECT email, name, role, fonction, programs, permissions, phone, location, pid, lang, created_at, validated FROM users ORDER BY created_at ASC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/members/:email', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u) && !hasPerm(u, 'canManageMembers')) return res.status(403).json({ error: 'Accès refusé' });
    const { role, fonction, programs, permissions, name, email: newEmail, phone, pid, location, graduate_pid, graduate_email, lang } = req.body;
    const progs = Array.isArray(programs) ? programs : [];
    const perms = permissions && typeof permissions === 'object' ? permissions : {};
    if (pid && !/^\d{7}$/.test(pid)) return res.status(400).json({ error: 'PID invalide (7 chiffres requis)' });
    if (graduate_pid && !/^\d{7}$/.test(graduate_pid)) return res.status(400).json({ error: 'PID gradué invalide (7 chiffres requis)' });
    const finalRole    = VALID_ROLES.includes(role) ? role : 'utilisateur';
    const finalFonction = VALID_FONCTIONS.includes(fonction) ? fonction : 'invité';
    const ALL_PERM_KEYS = ['canOPM','canAddIntro','canEditIntro','canDeleteIntro','canManageMembers','canManagePrograms','canManageTestimonials','canManageFeed'];
    if (LEADER_FONCTIONS.includes(finalFonction) || isAdmin({ role: finalRole })) perms.canOPM = true;
    if (finalRole === 'superadmin') { ALL_PERM_KEYS.forEach(k => { perms[k] = true; }); }
    // ─── Persistance permission "voir liste participants" par programme ───
    if (Array.isArray(permissions?.visibleParticipantsPrograms)) {
      perms.visibleParticipantsPrograms = permissions.visibleParticipantsPrograms;
    }
    const targetEmail = req.params.email.toLowerCase();
    const finalEmail = newEmail ? newEmail.toLowerCase() : targetEmail;
    // Parallélisation : check email + resolve graduate_pid en 1 batch
    const [existingRows, gradRows] = await Promise.all([
      (finalEmail !== targetEmail) ? sql`SELECT email FROM users WHERE email = ${finalEmail}` : Promise.resolve([]),
      graduate_pid ? sql`SELECT email FROM users WHERE pid = ${graduate_pid}` : Promise.resolve([])
    ]);
    if (finalEmail !== targetEmail && existingRows.length) return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    let resolvedGradEmail = graduate_email || null;
    if (graduate_pid) {
      if (!gradRows.length) return res.status(400).json({ error: 'Aucun gradué trouvé avec ce PID' });
      resolvedGradEmail = gradRows[0].email;
    }
    await sql`UPDATE users SET
      role=${finalRole},
      fonction=${finalFonction},
      programs=${JSON.stringify(progs)}::jsonb,
      permissions=${JSON.stringify(perms)}::jsonb,
      name=${name||''},
      email=${finalEmail},
      phone=${phone||''},
      pid=${pid||''},
      location=${location||''},
      graduate_pid=${graduate_pid||null},
      graduate_email=${resolvedGradEmail},
      lang=COALESCE(${normalizeLang(lang)}, lang),
      validated=true
      WHERE email=${targetEmail}`;
    invalidateUser(targetEmail);
    invalidateUser(finalEmail);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /members error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/members/:email/lang', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u) && !hasPerm(u, 'canManageMembers')) return res.status(403).json({ error: 'Accès refusé' });
    const lang = normalizeLang(req.body.lang);
    if (!lang) return res.status(400).json({ error: 'Langue invalide' });
    const targetEmail = req.params.email.toLowerCase();
    const updated = await sql`UPDATE users SET lang = ${lang} WHERE email = ${targetEmail} RETURNING email`;
    if (!updated.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    invalidateUser(targetEmail);
    res.json({ ok: true, lang });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/members/:email', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    // 1 seule requête : DELETE + RETURNING avec filtre remplace getUser + DELETE
    const rows = await sql`DELETE FROM users WHERE email = ${req.params.email} AND role <> 'superadmin' RETURNING email`;
    if (!rows.length) return res.status(403).json({ error: 'Utilisateur introuvable ou suppression interdite (super admin)' });
    invalidateUser(req.params.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Validation rapide d'une nouvelle inscription (marque validated=true sans rien modifier d'autre)
app.post('/api/members/:email/validate', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u) && !hasPerm(u, 'canManageMembers')) return res.status(403).json({ error: 'Accès refusé' });
    const targetEmail = req.params.email.toLowerCase();
    await sql`UPDATE users SET validated = true WHERE email = ${targetEmail}`;
    invalidateUser(targetEmail);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/members/:email/reset-password', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const rows = await sql`SELECT name, email FROM users WHERE email = ${req.params.email}`;
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const target = rows[0];
    const token = uuidv4();
    const expires = Date.now() + 60 * 60 * 1000;
    await sql`
      INSERT INTO reset_tokens (token, email, expires)
      VALUES (${token}, ${target.email}, ${expires})
      ON CONFLICT (email) DO UPDATE SET token = ${token}, expires = ${expires}
    `;
    const resetLink = `${process.env.APP_URL || 'https://landmark-pacifique.fr'}/?token=${token}`;
    await sendAppMail({ type: 'forgot_password', to_email: target.email, to_name: target.name, reset_link: resetLink });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   MAINTENANCE
════════════════════════════════════════ */

app.get('/api/maintenance', async (req, res) => {
  const m = await getMaintenance();
  res.json({ maintenance: m });
});

app.post('/api/maintenance', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    await setMaintenance(!!req.body.maintenance);
    res.json({ ok: true, maintenance: !!req.body.maintenance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   CALENDRIER UNIFIÉ — vue différenciée leader / gradué
════════════════════════════════════════ */
function isGraduate(u){ return (u.fonction||'').toLowerCase() === 'gradué'; }
function canManageCalendar(u){ return isAdmin(u) || LEADER_FONCTIONS.includes((u.fonction||'').toLowerCase()); }

// ─── Visibilité gradué : voit les événements liés aux programmes qu'il a suivis ───
// Admins/leaders : voient tout (rien à filtrer)
// Gradué : voit l'événement si target_program est dans ses programmes (ou si pas de target_program)
// Invité : pas concerné (filtres existants)
function canGraduateSeeEvent(u, targetProgram){
  if (isAdmin(u) || LEADER_FONCTIONS.includes((u.fonction||'').toLowerCase())) return true;
  if (!isGraduate(u)) return true; // invité : on ne change pas le comportement existant
  if (!targetProgram || targetProgram === 'Forum') return true; // Forum : programme d'entrée, jamais listé dans u.programs
  const userProgs = Array.isArray(u.programs) ? u.programs : [];
  return userProgs.includes(targetProgram);
}

// ─── Permission "voir liste participants" par programme ───
// permissions.visibleParticipantsPrograms = ['Forum','ATP', ...]
// Admins/leaders : voient toujours. Gradué : seulement les programmes cochés.
function canSeeParticipants(u, targetProgram){
  if (isAdmin(u) || LEADER_FONCTIONS.includes((u.fonction||'').toLowerCase())) return true;
  const allowed = (u.permissions && Array.isArray(u.permissions.visibleParticipantsPrograms))
    ? u.permissions.visibleParticipantsPrograms : [];
  if (!targetProgram) return allowed.length > 0; // événement sans programme : visible si au moins un programme autorisé
  return allowed.includes(targetProgram);
}

// Fenêtre de visibilité gradué sur appels de création : 48h avant jusqu'à minuit Tahiti du jour CC
function ccVisibleToGraduate(cc){
  if (!cc.date) return false;
  const now = Date.now();
  const start = new Date(`${cc.date}T${cc.heure||'00:00'}:00-10:00`).getTime();
  const end   = new Date(`${cc.date}T24:00:00-10:00`).getTime();
  return now >= (start - 48*3600*1000) && now < end;
}
function eventPassed(dateStr, heureStr){
  if (!dateStr) return false;
  const midnight = new Date(`${dateStr}T24:00:00-10:00`).getTime();
  return Date.now() >= midnight;
}

app.get('/api/calendar', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!u) return res.status(401).json({ error: 'Non authentifié' });

    const [intros, events, ccs, clinics, roles, regs] = await Promise.all([
      sql`SELECT * FROM intros WHERE archived = false ORDER BY date ASC`,
      sql`SELECT * FROM events WHERE archived = false ORDER BY date ASC`,
      sql`SELECT * FROM creation_calls WHERE archived = false ORDER BY date ASC`,
      sql`SELECT * FROM clinic_calls WHERE archived = false ORDER BY date ASC`,
      sql`SELECT event_type, event_id, role, user_email, user_name FROM event_roles`,
      sql`SELECT event_type, event_id, user_email FROM event_registrations`
    ]);

    const rolesByKey = {};
    roles.forEach(r => {
      const k = r.event_type + ':' + r.event_id;
      (rolesByKey[k] = rolesByKey[k] || []).push({ role: r.role, email: r.user_email, name: r.user_name });
    });
    const regsByKey = {};
    regs.forEach(r => {
      const k = r.event_type + ':' + r.event_id;
      (regsByKey[k] = regsByKey[k] || []).push(r.user_email);
    });

    const isLeaderLike = canManageCalendar(u);
    const grad = isGraduate(u);
    const userEmail = (u.email||'').toLowerCase();
    const result = [];

    // ── INTROS ──
    intros.forEach(i => {
      if (eventPassed(i.date, i.heure)) return;
      if (!canGraduateSeeEvent(u, i.target_program)) return;
      const isReg = (i.registrations||[]).some(r => (r.email||'').toLowerCase() === userEmail);
      const showRegs = canSeeParticipants(u, i.target_program);
      result.push({
        type: 'intro', id: i.id,
        titre: i.titre, theme: i.theme || '', kind: i.type || 'forum',
        date: i.date, heure: i.heure, heure_fin: i.heure_fin,
        format: i.format, location: i.location, zoom_url: i.zoom_url,
        target_program: i.target_program,
        roles: rolesByKey['intro:'+i.id] || [],
        regs_count: (i.registrations||[]).length,
        registered: isReg,
        can_edit: isLeaderLike,
        can_see_participants: showRegs
      });
    });

    // ── EVENTS (Forum/CA/Communication/Séminaires/Special) ──
    events.forEach(e => {
      if (eventPassed(e.date, e.heure)) return;
      if (!canGraduateSeeEvent(u, e.target_program)) return;
      const showRegs = isLeaderLike || canSeeParticipants(u, e.target_program);
      result.push({
        type: 'event', id: e.id,
        titre: e.titre, kind: e.kind, seminar_name: e.seminar_name,
        description: e.description || '',
        date: e.date, heure: e.heure, heure_fin: e.heure_fin,
        format: e.format, location: e.location, zoom_url: e.zoom_url,
        capacite: e.capacite, media_url: e.media_url, target_program: e.target_program,
        roles: rolesByKey['event:'+e.id] || [],
        regs_count: (regsByKey['event:'+e.id]||[]).length,
        registered: (regsByKey['event:'+e.id]||[]).map(x=>x.toLowerCase()).includes(userEmail),
        can_edit: isLeaderLike,
        can_see_participants: showRegs
      });
    });

    // ── CREATION CALLS ──
    // Récupérer les intro_id où l'utilisateur est inscrit
    const userIntroIds = new Set(
      intros
        .filter(i => (i.registrations||[]).some(r => (r.email||'').toLowerCase() === userEmail))
        .map(i => i.id)
    );

    ccs.forEach(cc => {
      if (eventPassed(cc.date, cc.heure)) return;
      if (!isLeaderLike) {
        const isLinkedToUserIntro = cc.intro_id && userIntroIds.has(cc.intro_id);
        if (!isLinkedToUserIntro && !ccVisibleToGraduate(cc)) return;
      }
      result.push({
        type: 'creation_call', id: cc.id,
        titre: cc.titre, kind: 'creation_call',
        intro_id: cc.intro_id,
        date: cc.date, heure: cc.heure, heure_fin: cc.heure_fin,
        format: cc.format, location: cc.location, zoom_url: cc.zoom_url,
        roles: rolesByKey['creation_call:'+cc.id] || [],
        regs_count: (regsByKey['creation_call:'+cc.id]||[]).length,
        registered: (regsByKey['creation_call:'+cc.id]||[]).map(x=>x.toLowerCase()).includes(userEmail),
        can_edit: isLeaderLike,
        can_see_participants: isLeaderLike
      });
    });

    // ── CLINIC CALLS ──
    clinics.forEach(cl => {
      if (eventPassed(cl.date, cl.heure)) return;
      result.push({
        type: 'clinic_call', id: cl.id,
        titre: cl.titre || cl.theme, kind: 'clinic_call', theme: cl.theme,
        description: cl.description || '',
        date: cl.date, heure: cl.heure, heure_fin: cl.heure_fin,
        format: cl.format, location: cl.location, zoom_url: cl.zoom_url,
        roles: rolesByKey['clinic_call:'+cl.id] || [],
        regs_count: (regsByKey['clinic_call:'+cl.id]||[]).length,
        registered: (regsByKey['clinic_call:'+cl.id]||[]).map(x=>x.toLowerCase()).includes(userEmail),
        can_edit: isLeaderLike,
        can_see_participants: isLeaderLike
      });
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Endpoint public (pas d'auth) pour un site externe : uniquement les dates/heures
   des intros à venir, sans titre, thème, invités ni aucune autre info. */
app.get('/api/public/intro-dates', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const intros = await sql`SELECT date, heure, heure_fin FROM intros WHERE archived = false ORDER BY date ASC`;
    const result = intros
      .filter(i => !eventPassed(i.date, i.heure))
      .map(i => ({ date: i.date, heure: i.heure, heure_fin: i.heure_fin }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/* ════════════════════════════════════════
   EVENTS (Forum, Advanced Course, Communication, Séminaires, Special)
════════════════════════════════════════ */
app.post('/api/events', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    if (!d.titre || !d.date || !d.kind) return res.status(400).json({ error: 'Titre, date et type requis' });
    if (!EVENT_KINDS.includes(d.kind)) return res.status(400).json({ error: 'Type invalide' });
    const id = 'e' + Date.now();
    await sql`INSERT INTO events (id, kind, seminar_name, titre, description, date, heure, heure_fin, format, location, zoom_url, capacite, media_url, target_program, created_by)
      VALUES (${id}, ${d.kind}, ${d.seminar_name||null}, ${d.titre}, ${d.description||''}, ${d.date}, ${d.heure||''}, ${d.heure_fin||''}, ${d.format||'presentiel'}, ${d.location||''}, ${d.zoom_url||''}, ${d.capacite||null}, ${d.media_url||null}, ${d.target_program||null}, ${u.email})`;
    broadcast('event_created', { id, kind: d.kind, titre: d.titre, date: d.date });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    await sql`UPDATE events SET kind=${d.kind}, seminar_name=${d.seminar_name||null}, titre=${d.titre}, description=${d.description||''}, date=${d.date}, heure=${d.heure||''}, heure_fin=${d.heure_fin||''}, format=${d.format||'presentiel'}, location=${d.location||''}, zoom_url=${d.zoom_url||''}, capacite=${d.capacite||null}, media_url=${d.media_url||null}, target_program=${d.target_program||null} WHERE id=${req.params.id}`;
    broadcast('event_updated', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`UPDATE events SET archived=true, archived_at=NOW(), archived_by=${u.email} WHERE id=${req.params.id}`;
    broadcast('event_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   CREATION CALLS
════════════════════════════════════════ */
app.post('/api/creation-calls', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    if (!d.titre || !d.date) return res.status(400).json({ error: 'Titre et date requis' });
    const id = 'cc' + Date.now();
    await sql`INSERT INTO creation_calls (id, intro_id, titre, date, heure, heure_fin, format, location, zoom_url, created_by)
      VALUES (${id}, ${d.intro_id||null}, ${d.titre}, ${d.date}, ${d.heure||''}, ${d.heure_fin||''}, ${d.format||'zoom'}, ${d.location||''}, ${d.zoom_url||''}, ${u.email})`;

    // Google Calendar (contact@landmark-pacifique.fr), fire-and-forget
    Promise.resolve().then(async () => {
      try {
        const gcalId = await gcal.syncCreationCallCalendarEvent({
          id, titre: d.titre, date: d.date, heure: d.heure || '', heure_fin: d.heure_fin || '',
          zoom_url: d.zoom_url || '', location: d.location || '',
        });
        if (gcalId) await sql`UPDATE creation_calls SET gcal_event_id = ${gcalId} WHERE id = ${id}`;
      } catch (gcalErr) { console.error('GCal creation_call error:', gcalErr.message); }
    });

    broadcast('creation_call_created', { id, intro_id: d.intro_id||null });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/creation-calls/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    await sql`UPDATE creation_calls SET intro_id=${d.intro_id||null}, titre=${d.titre}, date=${d.date}, heure=${d.heure||''}, heure_fin=${d.heure_fin||''}, format=${d.format||'zoom'}, location=${d.location||''}, zoom_url=${d.zoom_url||''} WHERE id=${req.params.id}`;
    broadcast('creation_call_updated', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/creation-calls/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`UPDATE creation_calls SET archived=true WHERE id=${req.params.id}`;
    broadcast('creation_call_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/creation-calls/:id/register', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const rows = await sql`SELECT * FROM creation_calls WHERE id=${req.params.id} AND archived=false`;
    if (!rows.length) return res.status(404).json({ error: 'Appel de création introuvable' });
    const cc = rows[0];
    await sql`INSERT INTO event_registrations (event_type, event_id, user_email, user_name, source)
      VALUES ('creation_call', ${cc.id}, ${u.email}, ${u.name}, 'manual')
      ON CONFLICT (event_type, event_id, user_email) DO NOTHING`;
    broadcast('creation_call_registered', { id: cc.id, email: u.email });

    try {
      await sendAppMail({
        type: 'creation_call_register',
        to_email: u.email, to_name: u.name,
        event: { id: cc.id, titre: cc.titre, date: cc.date, heure: cc.heure, zoom_url: cc.zoom_url, location: cc.location, format: cc.format }
      });
    } catch(err){ console.error('Email CC register:', err.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/creation-calls/:id/register', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    await sql`DELETE FROM event_registrations WHERE event_type='creation_call' AND event_id=${req.params.id} AND user_email=${u.email}`;
    broadcast('creation_call_unregistered', { id: req.params.id, email: u.email });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   CLINIC CALLS
════════════════════════════════════════ */
app.post('/api/clinic-calls', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    if (!d.theme || !d.date) return res.status(400).json({ error: 'Thème et date requis' });
    const id = 'cl' + Date.now();
    await sql`INSERT INTO clinic_calls (id, theme, titre, description, date, heure, heure_fin, format, location, zoom_url, created_by)
      VALUES (${id}, ${d.theme}, ${d.titre||d.theme}, ${d.description||''}, ${d.date}, ${d.heure||''}, ${d.heure_fin||''}, ${d.format||'zoom'}, ${d.location||''}, ${d.zoom_url||''}, ${u.email})`;
    broadcast('clinic_call_created', { id, theme: d.theme });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clinic-calls/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    const d = req.body;
    await sql`UPDATE clinic_calls SET theme=${d.theme}, titre=${d.titre||d.theme}, description=${d.description||''}, date=${d.date}, heure=${d.heure||''}, heure_fin=${d.heure_fin||''}, format=${d.format||'zoom'}, location=${d.location||''}, zoom_url=${d.zoom_url||''} WHERE id=${req.params.id}`;
    broadcast('clinic_call_updated', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clinic-calls/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`UPDATE clinic_calls SET archived=true WHERE id=${req.params.id}`;
    broadcast('clinic_call_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clinic-calls/:id/register', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const rows = await sql`SELECT * FROM clinic_calls WHERE id=${req.params.id} AND archived=false`;
    if (!rows.length) return res.status(404).json({ error: 'Clinique call introuvable' });
    const cl = rows[0];
    await sql`INSERT INTO event_registrations (event_type, event_id, user_email, user_name, source)
      VALUES ('clinic_call', ${cl.id}, ${u.email}, ${u.name}, 'manual')
      ON CONFLICT (event_type, event_id, user_email) DO NOTHING`;
    broadcast('clinic_call_registered', { id: cl.id, email: u.email });
    try {
      await sendAppMail({
        type: 'clinic_call_register',
        to_email: u.email, to_name: u.name,
        event: { id: cl.id, titre: cl.titre, theme: cl.theme, date: cl.date, heure: cl.heure, zoom_url: cl.zoom_url, location: cl.location, format: cl.format }
      });
    } catch(err){ console.error('Email clinic register:', err.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clinic-calls/:id/register', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    await sql`DELETE FROM event_registrations WHERE event_type='clinic_call' AND event_id=${req.params.id} AND user_email=${u.email}`;
    broadcast('clinic_call_unregistered', { id: req.params.id, email: u.email });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   EVENT ROLES — positionnement leader sur un rôle d'événement
   event_type ∈ intro|event|creation_call|clinic_call
   role       ∈ leader_intro|opm|room_captain|clinic_animator|translator|forum_expert
════════════════════════════════════════ */
app.get('/api/event-roles/:event_type/:event_id', auth, async (req, res) => {
  try {
    const { event_type, event_id } = req.params;
    const rows = await sql`SELECT role, user_email, user_name, created_at FROM event_roles WHERE event_type=${event_type} AND event_id=${event_id} ORDER BY created_at ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/event-roles', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!canManageCalendar(u)) return res.status(403).json({ error: 'Seuls les leaders peuvent se positionner sur un rôle' });
    const { event_type, event_id, role } = req.body;
    if (!event_type || !event_id || !role) return res.status(400).json({ error: 'Champs requis manquants' });
    if (!CALENDAR_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    if (!['intro','event','creation_call','clinic_call'].includes(event_type)) return res.status(400).json({ error: 'Type d\'événement invalide' });
    await sql`INSERT INTO event_roles (event_type, event_id, role, user_email, user_name)
      VALUES (${event_type}, ${event_id}, ${role}, ${u.email}, ${u.name})
      ON CONFLICT (event_type, event_id, role, user_email) DO NOTHING`;
    broadcast('role_assigned', { event_type, event_id, role, email: u.email, name: u.name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/event-roles', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    const { event_type, event_id, role, email } = req.body;
    const target = (email && canManageCalendar(u) && isAdmin(u)) ? email : u.email;
    await sql`DELETE FROM event_roles WHERE event_type=${event_type} AND event_id=${event_id} AND role=${role} AND user_email=${target}`;
    broadcast('role_unassigned', { event_type, event_id, role, email: target });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════
   TESTIMONIALS
════════════════════════════════════════ */

app.get('/api/testimonials', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM testimonials ORDER BY id ASC`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/testimonials', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!hasPerm(u, 'canManageTestimonials') && !isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const { text, author, role, category } = req.body;
    if (!text || !author) return res.status(400).json({ error: 'Texte et auteur requis' });
    await sql`INSERT INTO testimonials (text, author, role, category) VALUES (${text}, ${author}, ${role||''}, ${category||'community'})`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/testimonials/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!hasPerm(u, 'canManageTestimonials') && !isSuperAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    await sql`DELETE FROM testimonials WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   NOTIFICATIONS
════════════════════════════════════════ */

async function createNotification(recipientEmail, type, message, link = null) {
  try {
    if (!recipientEmail) return;
    await sql`INSERT INTO notifications (recipient_email, type, message, link, read, created_at)
      VALUES (${recipientEmail}, ${type}, ${message}, ${link}, false, NOW())`;
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM notifications WHERE recipient_email = ${req.user.email} ORDER BY created_at DESC LIMIT 50`;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/notifications/read', auth, async (req, res) => {
  try {
    await sql`UPDATE notifications SET read = true WHERE recipient_email = ${req.user.email}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await sql`UPDATE notifications SET read = true WHERE id = ${req.params.id} AND recipient_email = ${req.user.email}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   PENSÉE DU JOUR
════════════════════════════════════════ */

async function fetchPenseeduJour() {
  try {
    const res = await fetch('https://www.souffledor.fr/pensee-du-jour', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LandmarkPacifique/1.0)' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const parts = html.split(/Eileen\s+Caddy/i);
    if (parts.length < 2) return null;
    const after = parts[parts.length - 1].split(/En\s+savoir\s+plus/i)[0];
    if (!after) return null;
    const text = after
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#[0-9]+;/g, '')
      .replace(/\s+/g, ' ').trim();
    return text || null;
  } catch (e) {
    console.error('fetchPenseeduJour error:', e.message);
    return null;
  }
}

function getTahitiDateStr() {
  return new Date().toLocaleDateString('fr-FR', {
    timeZone: 'Pacific/Tahiti', day: 'numeric', month: 'long'
  });
}

async function reformulateLandmarkStyle(originalText) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return originalText;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 300,
        messages: [{
          role: 'system',
          content: `Tu es un formateur Landmark Education. Reformule la pensée du jour d'Eileen Caddy dans le style Landmark : langage de la transformation, de la création, de la possibilité et de l'être. Utilise des mots comme "création", "possibilité", "être", "engagement", "transformation", "puissance", "présence". 3 à 5 phrases max. Réponds uniquement avec le texte reformulé, sans introduction ni guillemets.`
        }, {
          role: 'user',
          content: originalText
        }]
      })
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || originalText;
  } catch (e) {
    console.error('reformulateLandmarkStyle error:', e.message);
    return originalText;
  }
}

async function postPenseeduJour(force = false) {
  try {
    const today = getTahitiDateStr();
    if (!force) {
      const existing = await sql`
        SELECT id FROM posts WHERE section = 'guest' AND author = 'Pensée du jour' AND date = ${today} LIMIT 1`;
      if (existing.length) return;
    } else {
      await sql`DELETE FROM posts WHERE section = 'guest' AND author = 'Pensée du jour' AND date = ${today}`;
    }
    const raw = await fetchPenseeduJour();
    if (!raw) { console.log('Pensée du jour: texte non trouvé'); return; }
    const text = await reformulateLandmarkStyle(raw);
    const id = 'p' + uuidv4().slice(0, 8);
    await sql`INSERT INTO posts (id, section, author, author_email, title, body, tag, date, reactions, comments, attachments)
      VALUES (${id}, 'guest', 'Pensée du jour', 'system@landmark.pf',
              ${'🌸 Pensée du jour — ' + today}, ${text}, 'Inspiration',
              ${today}, '{}', '[]', '[]')`;
    console.log('✅ Pensée du jour postée :', today);
  } catch (e) {
    console.error('postPenseeduJour error:', e.message);
  }
}

function schedulePenseeAt08hTahiti() { /* no-op serverless */ }

/* ─── RAPPELS AUTOMATIQUES AUX INVITÉS (lien Zoom, la veille + 1h avant) ───
   Process persistant (LWS/Passenger) : vérifié toutes les 15 min via setInterval.
   L'état d'envoi est stocké directement sur chaque inscription (registrations JSONB)
   pour ne jamais renvoyer deux fois le même rappel. */
async function checkIntroReminders() {
  try {
    const rows = await sql`SELECT * FROM intros WHERE archived = false AND zoom_url IS NOT NULL AND zoom_url <> ''`;
    const now = Date.now();
    for (const intro of rows) {
      if (!intro.date || !intro.heure) continue;
      const startMs = new Date(`${intro.date}T${intro.heure}:00-10:00`).getTime(); // Tahiti = UTC-10, sans heure d'été
      if (Number.isNaN(startMs)) continue;
      const hoursUntil = (startMs - now) / 3600000;
      const regs = intro.registrations || [];
      let changed = false;
      for (const reg of regs) {
        if (!reg.email) continue;
        const tz = computeTimezones(intro);
        const payload = {
          to_email: reg.email,
          to_name: (reg.firstname || '') + ' ' + (reg.lastname || ''),
          graduate: { name: reg.invitedBy || '', email: reg.invitedByEmail || '' },
          event: { heure_tahiti: tz.heure_tahiti, heure_nc: tz.heure_nc, heure_fr: tz.heure_fr, zoom_url: intro.zoom_url },
        };
        if (hoursUntil <= 25 && hoursUntil > 23 && !reg.reminderDayBeforeSent) {
          await sendAppMail({ ...payload, type: 'guest_intro_reminder_day_before' });
          reg.reminderDayBeforeSent = true;
          changed = true;
        }
        if (hoursUntil <= 1.25 && hoursUntil > 0 && !reg.reminder1hSent) {
          await sendAppMail({ ...payload, type: 'guest_intro_reminder_1h' });
          reg.reminder1hSent = true;
          changed = true;
        }
      }
      if (changed) {
        await sql`UPDATE intros SET registrations = ${JSON.stringify(regs)} WHERE id = ${intro.id}`;
      }
    }
  } catch (e) {
    console.error('checkIntroReminders error:', e.message);
  }
}

app.post('/api/pensee-du-jour', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    const raw = await fetchPenseeduJour();
    if (!raw) return res.status(502).json({ error: 'Impossible de récupérer la pensée du jour' });
    const text = await reformulateLandmarkStyle(raw);
    const today = getTahitiDateStr();
    await sql`DELETE FROM posts WHERE section = 'guest' AND author = 'Pensée du jour' AND date = ${today}`;
    const id = 'p' + uuidv4().slice(0, 8);
    await sql`INSERT INTO posts (id, section, author, author_email, title, body, tag, date, reactions, comments, attachments)
      VALUES (${id}, 'guest', 'Pensée du jour', 'system@landmark.pf',
              ${'🌸 Pensée du jour — ' + today}, ${text}, 'Inspiration',
              ${today}, '{}', '[]', '[]')`;
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pensee-du-jour-cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await postPenseeduJour();
  res.json({ ok: true });
});

/* ─── GOOGLE CALENDAR : connexion (setup une fois) + rattrapage ───
   Routes protégées par GOOGLE_CALENDAR_SETUP_KEY (même logique que CRON_SECRET) :
   pas de session JWT possible sur une redirection Google, donc secret partagé côté serveur. */
app.get('/api/admin/google-calendar/connect', (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.query.key !== key) return res.status(403).send('Accès refusé');
  res.redirect(gcal.getConnectUrl());
});

app.get('/api/admin/google-calendar/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send('Autorisation Google refusée ou annulée.');
  try {
    await gcal.exchangeCodeForRefreshToken(code);
    res.send('✅ Google Calendar connecté pour contact@landmark-pacifique.fr. Vous pouvez fermer cette page.');
  } catch (e) {
    console.error('GCal callback error:', e.message);
    res.status(500).send('Erreur : ' + e.message);
  }
});

app.post('/api/admin/google-calendar/backfill', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const result = await gcal.backfillUpcomingEvents();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/google-calendar/calendars', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const calendars = await gcal.listCalendars();
    res.json({ ok: true, calendars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/set-calendar', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId requis' });
  try {
    await gcal.setTargetCalendar(calendarId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/migrate', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const result = await gcal.migrateExistingEvents();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/resync-descriptions', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const result = await gcal.resyncIntroDescriptions();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/force-recreate', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const result = await gcal.forceRecreateAllIntroEvents();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/set-graduate-calendar', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId requis' });
  try {
    await gcal.setGraduateCalendar(calendarId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/google-calendar/migrate-graduate-events', async (req, res) => {
  const key = process.env.GOOGLE_CALENDAR_SETUP_KEY;
  if (!key || req.headers['x-setup-key'] !== key) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const result = await gcal.migrateGraduateEventsToOwnCalendar();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function removeCommProgram() {
  try {
    // 'Cours de communication' n'est plus un programme : c'est uniquement un programme cible d'introductions (CAPO & CPCO)
    await sql`DELETE FROM programs WHERE key = 'Cours de communication'`;
  } catch(e) { console.error('removeCommProgram:', e.message); }
}

/* ════════════════════════════════════════
   LEADER ANALYTICS DASHBOARD
════════════════════════════════════════ */

// Middleware pour vérifier que l'utilisateur est leader
function requireLeader(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    getUser(decoded.email).then(u => {
      if (!u) return res.status(401).json({ error: 'Utilisateur introuvable' });
      if (!isLeader(u)) return res.status(403).json({ error: 'Accès réservé aux leaders' });
      req.dbUser = u;
      next();
    }).catch(e => res.status(500).json({ error: e.message }));
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

app.get('/api/leader/analytics', requireLeader, async (req, res) => {
  try {
    const [totalIntros, totalUsers, totalPosts, upcomingIntros, registrationsStats, recentActivity] = await Promise.all([
      // Total intros (actives + archivées)
      sql`SELECT COUNT(*) as total, 
              COUNT(*) FILTER (WHERE archived = false) as active,
              COUNT(*) FILTER (WHERE archived = true) as archived
       FROM intros`,
      // Total utilisateurs
      sql`SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE role = 'utilisateur') as members,
              COUNT(*) FILTER (WHERE role = 'admin') as admins,
              COUNT(*) FILTER (WHERE role = 'superadmin') as superadmins
       FROM users`,
      // Total posts
      sql`SELECT COUNT(*) as total FROM posts`,
      // Intros à venir (prochains 30 jours)
      sql`SELECT * FROM intros 
       WHERE archived = false AND date >= CURRENT_DATE::text 
       ORDER BY date ASC, heure ASC 
       LIMIT 10`,
      // Stats d'inscriptions par intro (top 10)
      sql`SELECT id, titre, date, type,
              jsonb_array_length(registrations) as registration_count
       FROM intros 
       WHERE archived = false 
       ORDER BY jsonb_array_length(registrations) DESC 
       LIMIT 10`,
      // Activité récente (dernières 7 jours)
      sql`SELECT COUNT(*) as new_users
       FROM users 
       WHERE created_at >= NOW() - INTERVAL '7 days'`
    ]);

    // Calculer le taux de participation moyen
    const avgParticipation = registrationsStats.length > 0
      ? Math.round(registrationsStats.reduce((sum, r) => sum + (r.registration_count || 0), 0) / registrationsStats.length)
      : 0;

    // Intros par type
    const introsByType = await sql`
      SELECT type, COUNT(*) as count 
      FROM intros 
      WHERE archived = false 
      GROUP BY type 
      ORDER BY count DESC
    `;

    // Intros par mois (6 derniers mois)
    const introsByMonth = await sql`
      SELECT TO_CHAR(TO_DATE(date, 'YYYY-MM-DD'), 'YYYY-MM') as month,
              COUNT(*) as count
       FROM intros 
       WHERE date >= (CURRENT_DATE - INTERVAL '6 months')::text
       GROUP BY month 
       ORDER BY month ASC
    `;

    res.json({
      overview: {
        total_intros: parseInt(totalIntros[0].total),
        active_intros: parseInt(totalIntros[0].active),
        archived_intros: parseInt(totalIntros[0].archived),
        total_users: parseInt(totalUsers[0].total),
        members: parseInt(totalUsers[0].members),
        admins: parseInt(totalUsers[0].admins),
        superadmins: parseInt(totalUsers[0].superadmins),
        total_posts: parseInt(totalPosts[0].total),
        avg_participation: avgParticipation,
        new_users_7d: parseInt(recentActivity[0].new_users)
      },
      upcoming_intros: upcomingIntros,
      top_intros_by_registrations: registrationsStats.map(r => ({
        id: r.id, titre: r.titre, date: r.date, type: r.type,
        registrations: r.registration_count
      })),
      intros_by_type: introsByType,
      intros_by_month: introsByMonth
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leader/analytics/intro/:id', requireLeader, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM intros WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Intro introuvable' });
    const intro = rows[0];
    const regs = intro.registrations || [];

    // Stats détaillées pour cette intro
    res.json({
      intro,
      stats: {
        total_registrations: regs.length,
        confirmed: regs.filter(r => r.confirmed).length,
        pending: regs.filter(r => !r.confirmed).length,
        with_guest: regs.filter(r => r.guest).length,
        reminders_sent: regs.filter(r => r.reminderDayBeforeSent).length
      },
      registrations: regs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   API KEYS MANAGEMENT (pour sites externes)
════════════════════════════════════════ */

// Helper: générer une clé API sécurisée
function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'lp_';
  for (let i = 0; i < 48; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// Helper: hasher une clé API
function hashApiKey(key) {
  return bcrypt.hashSync(key, 10);
}

// Helper: enregistrer un log d'audit
async function logApiKeyAudit({ apiKeyId, apiKeyName, action, endpoint, method, resourceType, resourceId, requestBody, responseStatus, ipAddress, userAgent }) {
  try {
    await sql`
      INSERT INTO api_key_audit_logs 
        (api_key_id, api_key_name, action, endpoint, method, resource_type, resource_id, request_body, response_status, ip_address, user_agent)
      VALUES 
        (${apiKeyId}, ${apiKeyName}, ${action}, ${endpoint}, ${method}, ${resourceType || null}, ${resourceId || null}, ${requestBody ? JSON.stringify(requestBody) : null}, ${responseStatus || null}, ${ipAddress || null}, ${userAgent || null})
    `;
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// Vérifier une clé API (pour les routes publiques)
async function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'Clé API requise' });
  
  // On ne peut pas comparer un hash directement, on cherche par prefixe
  // Pour la sécurité, on stocke les clés hashées et on les vérifie
  const rows = await sql`SELECT * FROM api_keys WHERE active = true`;
  let validKey = null;
  
  for (const row of rows) {
    if (bcrypt.compareSync(apiKey, row.key_hash)) {
      validKey = row;
      break;
    }
  }
  
  if (!validKey) {
    // Log la tentative échouée
    await logApiKeyAudit({
      apiKeyId: null,
      apiKeyName: 'UNKNOWN',
      action: 'auth_failed',
      endpoint: req.originalUrl,
      method: req.method,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'],
      responseStatus: 401
    });
    return res.status(401).json({ error: 'Clé API invalide ou inactive' });
  }
  
  // Mettre à jour last_used_at
  await sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${validKey.id}`;
  
  req.apiKey = validKey;
  req.apiPermissions = validKey.permissions;
  next();
}

// CRUD API Keys (admin seulement)
app.get('/api/admin/api-keys', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    const keys = await sql`
      SELECT id, name, permissions, active, last_used_at, created_at, created_by 
      FROM api_keys 
      ORDER BY created_at DESC
    `;
    res.json(keys);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/api-keys', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    const { name, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    
    const plainKey = generateApiKey();
    const keyHash = hashApiKey(plainKey);
    
    await sql`
      INSERT INTO api_keys (name, key_hash, permissions, created_by)
      VALUES (${name}, ${keyHash}, ${JSON.stringify(permissions || { read_intros: true })}, ${u.email})
    `;
    
    // Retourner la clé en clair UNIQUEMENT à la création
    res.json({ ok: true, key: plainKey, message: '⚠️ Sauvegardez cette clé, elle ne sera plus affichée!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/api-keys/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    const { name, permissions, active } = req.body;
    await sql`
      UPDATE api_keys 
      SET name = COALESCE(${name}, name),
          permissions = COALESCE(${permissions ? JSON.stringify(permissions) : null}, permissions),
          active = COALESCE(${active}, active)
      WHERE id = ${req.params.id}
    `;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/api-keys/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    await sql`DELETE FROM api_keys WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── ROUTES PUBLIQUES API (authentification par API key) ─── */

// Helper: construire les infos d'audit depuis la requête
function getAuditInfo(req) {
  return {
    apiKeyId: req.apiKey?.id,
    apiKeyName: req.apiKey?.name || 'UNKNOWN',
    endpoint: req.originalUrl,
    method: req.method,
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent']
  };
}

// Lire les intros (publique avec clé API)
app.get('/api/v1/intros', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.read_intros) {
      return res.status(403).json({ error: 'Permission refusée: read_intros' });
    }
    
    const { type, archived, limit = 50, offset = 0 } = req.query;
    
    let query = sql`SELECT * FROM intros WHERE 1=1`;
    
    if (type) query = sql`${query} AND type = ${type}`;
    if (archived !== undefined) query = sql`${query} AND archived = ${archived === 'true'}`;
    
    query = sql`${query} ORDER BY date DESC, heure DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
    
    const intros = await query;
    const total = await sql`SELECT COUNT(*) FROM intros WHERE archived = false`;
    
    // Log d'audit
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'list_intros',
      resourceType: 'intros',
      responseStatus: 200
    });
    
    res.json({
      intros,
      pagination: {
        total: parseInt(total[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lire une intro spécifique
app.get('/api/v1/intros/:id', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.read_intros) {
      return res.status(403).json({ error: 'Permission refusée: read_intros' });
    }
    
    const rows = await sql`SELECT * FROM intros WHERE id = ${req.params.id}`;
    if (!rows.length) {
      await logApiKeyAudit({
        ...getAuditInfo(req),
        action: 'read_intro',
        resourceType: 'intros',
        resourceId: req.params.id,
        responseStatus: 404
      });
      return res.status(404).json({ error: 'Intro introuvable' });
    }
    
    // Log d'audit
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'read_intro',
      resourceType: 'intros',
      resourceId: req.params.id,
      responseStatus: 200
    });
    
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Créer une intro (avec clé API + permission)
app.post('/api/v1/intros', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.create_intros) {
      await logApiKeyAudit({
        ...getAuditInfo(req),
        action: 'create_intro_denied',
        resourceType: 'intros',
        requestBody: req.body,
        responseStatus: 403
      });
      return res.status(403).json({ error: 'Permission refusée: create_intros' });
    }
    
    const d = req.body;
    if (!d.titre || !d.date) return res.status(400).json({ error: 'titre et date requis' });
    
    const id = 'ext_' + Date.now() + '_' + uuidv4().slice(0, 8);
    await sql`
      INSERT INTO intros (id, type, titre, theme, date, heure, heure_fin, format, location, zoom_url, animateur, animateur_email)
      VALUES (${id}, ${d.type || 'forum'}, ${d.titre}, ${d.theme || ''}, ${d.date}, ${d.heure || ''}, ${d.heure_fin || ''}, ${d.format || 'zoom'}, ${d.location || ''}, ${d.zoom_url || ''}, ${d.animateur || ''}, ${d.animateur_email || ''})
    `;
    
    // Log d'audit
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'create_intro',
      resourceType: 'intros',
      resourceId: id,
      requestBody: req.body,
      responseStatus: 200
    });
    
    broadcast('intro_created', { id, source: 'api', api_key_name: req.apiKey.name });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mettre à jour une intro
app.put('/api/v1/intros/:id', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.update_intros) {
      await logApiKeyAudit({
        ...getAuditInfo(req),
        action: 'update_intro_denied',
        resourceType: 'intros',
        resourceId: req.params.id,
        requestBody: req.body,
        responseStatus: 403
      });
      return res.status(403).json({ error: 'Permission refusée: update_intros' });
    }
    
    const d = req.body;
    await sql`
      UPDATE intros 
      SET type = COALESCE(${d.type}, type),
          titre = COALESCE(${d.titre}, titre),
          theme = COALESCE(${d.theme}, theme),
          date = COALESCE(${d.date}, date),
          heure = COALESCE(${d.heure}, heure),
          heure_fin = COALESCE(${d.heure_fin}, heure_fin),
          format = COALESCE(${d.format}, format),
          location = COALESCE(${d.location}, location),
          zoom_url = COALESCE(${d.zoom_url}, zoom_url),
          animateur = COALESCE(${d.animateur}, animateur),
          animateur_email = COALESCE(${d.animateur_email}, animateur_email)
      WHERE id = ${req.params.id}
    `;
    
    // Log d'audit
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'update_intro',
      resourceType: 'intros',
      resourceId: req.params.id,
      requestBody: req.body,
      responseStatus: 200
    });
    
    broadcast('intro_updated', { id: req.params.id, source: 'api' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer (archiver) une intro
app.delete('/api/v1/intros/:id', verifyApiKey, async (req, res) => {
  try {
    if (!req.apiPermissions.delete_intros) {
      await logApiKeyAudit({
        ...getAuditInfo(req),
        action: 'delete_intro_denied',
        resourceType: 'intros',
        resourceId: req.params.id,
        responseStatus: 403
      });
      return res.status(403).json({ error: 'Permission refusée: delete_intros' });
    }
    
    await sql`UPDATE intros SET archived = true, archived_at = NOW() WHERE id = ${req.params.id}`;
    
    // Log d'audit
    await logApiKeyAudit({
      ...getAuditInfo(req),
      action: 'delete_intro',
      resourceType: 'intros',
      resourceId: req.params.id,
      responseStatus: 200
    });
    
    broadcast('intro_deleted', { id: req.params.id, source: 'api' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   ADMIN: LOGS D'AUDIT API KEYS
════════════════════════════════════════ */

// Lister les logs d'audit (admin seulement)
app.get('/api/admin/api-key-logs', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    const { api_key_id, action, limit = 100, offset = 0, from, to } = req.query;
    
    let query = sql`SELECT l.*, k.name as key_name FROM api_key_audit_logs l LEFT JOIN api_keys k ON k.id = l.api_key_id WHERE 1=1`;
    
    if (api_key_id) query = sql`${query} AND l.api_key_id = ${parseInt(api_key_id)}`;
    if (action) query = sql`${query} AND l.action = ${action}`;
    if (from) query = sql`${query} AND l.created_at >= ${from}`;
    if (to) query = sql`${query} AND l.created_at <= ${to}`;
    
    query = sql`${query} ORDER BY l.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
    
    const logs = await query;
    const total = await sql`SELECT COUNT(*) FROM api_key_audit_logs`;
    
    res.json({
      logs,
      pagination: {
        total: parseInt(total[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Statistiques d'audit (admin seulement)
app.get('/api/admin/api-key-logs/stats', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isAdmin(u)) return res.status(403).json({ error: 'Accès refusé' });
    
    const [byAction, byKey, recentFailed, dailyActivity] = await Promise.all([
      // Actions les plus fréquentes
      sql`SELECT action, COUNT(*) as count 
          FROM api_key_audit_logs 
          GROUP BY action 
          ORDER BY count DESC 
          LIMIT 10`,
      // Utilisation par clé API
      sql`SELECT api_key_name, COUNT(*) as count, MAX(created_at) as last_used 
          FROM api_key_audit_logs 
          WHERE api_key_name != 'UNKNOWN' 
          GROUP BY api_key_name 
          ORDER BY count DESC`,
      // Tentatives échouées (24h)
      sql`SELECT COUNT(*) as count 
          FROM api_key_audit_logs 
          WHERE action = 'auth_failed' 
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      // Activité par jour (7 derniers jours)
      sql`SELECT DATE(created_at) as day, COUNT(*) as count 
          FROM api_key_audit_logs 
          WHERE created_at >= NOW() - INTERVAL '7 days' 
          GROUP BY day 
          ORDER BY day ASC`
    ]);
    
    res.json({
      by_action: byAction,
      by_key: byKey,
      failed_24h: parseInt(recentFailed[0].count),
      daily_activity: dailyActivity
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Supprimer les logs d'audit anciens (admin seulement, > 90 jours)
app.delete('/api/admin/api-key-logs/cleanup', auth, async (req, res) => {
  try {
    const u = await getUser(req.user.email);
    if (!isSuperAdmin(u)) return res.status(403).json({ error: 'Accès réservé aux superadmins' });
    
    const result = await sql`DELETE FROM api_key_audit_logs WHERE created_at < NOW() - INTERVAL '90 days'`;
    res.json({ ok: true, deleted: result.count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── START ───
   Process Node persistant (LWS/Passenger) : le serveur est démarré ici avec .listen(). */
initDB().then(() => ensureInvitationTokensTable()).then(() => ensureSettingsTable()).then(() => removeCommProgram()).then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`✅ Landmark Pacifique API + WS — port ${PORT}`));
  schedulePenseeAt08hTahiti();
  checkIntroReminders();
  setInterval(checkIntroReminders, 15 * 60 * 1000);
}).catch(e => {
  console.error('❌ DB init failed:', e.message);
  process.exit(1);
});

module.exports = app;
