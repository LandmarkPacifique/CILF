// api/index.js
// Routeur unique — fusionne les 13 endpoints en 1 seule fonction Vercel
// Routes :
//   POST   /api/login
//   POST   /api/register
//   GET    /api/config          POST /api/config
//   GET    /api/intros          POST /api/intros
//   GET    /api/guests          POST /api/guests
//   GET    /api/users-list
//   POST   /api/users
//   GET    /api/profile         POST /api/profile
//   POST   /api/forgot-password
//   POST   /api/reset-password
//   POST   /api/webhook-make
//   GET    /api/reminders
//   POST   /api/reminders-mark

const { neon }  = require('@neondatabase/serverless');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');

const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN  || 'https://www.landmark-pacifique.fr';
const APP_URL         = process.env.APP_URL          || 'https://www.landmark-pacifique.fr';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSQL() { return neon(process.env.DATABASE_URL); }

function sendJSON(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function setCORS(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token, x-secret');
}

function getToken(req) {
  const auth = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : (auth || null);
}

function verifyJWT(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

function orNull(v) {
  return (v && v.toString().trim() !== '') ? v : null;
}

// ── Route handlers ────────────────────────────────────────────────────────────

// POST /api/login
async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return sendJSON(res, 400, { error: 'Email et mot de passe requis' });
  const sql = getSQL();
  try {
    const result = await sql`
      SELECT id, role, name, pid, telephone, fonction, approved
      FROM users
      WHERE email = ${email} AND password_hash = crypt(${password}, password_hash)
    `;
    if (result.length === 0) return sendJSON(res, 401, { error: 'Identifiants incorrects' });
    const user = result[0];
    if (user.approved === false || user.approved === null) {
      return sendJSON(res, 403, { error: 'Votre compte est en attente de validation par un administrateur.' });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    return sendJSON(res, 200, { token, role: user.role, name: user.name, pid: user.pid || null, telephone: user.telephone || null, fonction: user.fonction || null });
  } catch (err) {
    console.error('Login error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// POST /api/register
async function handleRegister(req, res) {
  const { first_name, last_name, email, password, pid, telephone, fonction } = req.body || {};
  if (!first_name || !last_name || !email || !password)
    return sendJSON(res, 400, { error: 'Prénom, nom, email et mot de passe requis' });
  if (pid && !/^\d{7}$/.test(pid))
    return sendJSON(res, 400, { error: 'Le PID doit contenir exactement 7 chiffres' });
  const fullName     = `${first_name.trim()} ${last_name.trim()}`;
  const userFonction = ['leader_intro', 'gradue'].includes(fonction) ? fonction : null;
  const sql = getSQL();
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO users (email, password_hash, role, name, first_name, last_name, pid, telephone, fonction, approved)
      VALUES (${email}, ${passwordHash}, 'utilisateur', ${fullName}, ${first_name.trim()}, ${last_name.trim()}, ${pid || null}, ${telephone || null}, ${userFonction}, false)
    `;
    return sendJSON(res, 201, { message: 'Compte créé, en attente de validation par un administrateur.' });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate'))
      return sendJSON(res, 409, { error: 'Cet email est déjà utilisé' });
    console.error('Register error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// GET|POST /api/config
async function handleConfig(req, res) {
  const WRITABLE_KEYS = ['apps-script', 'brevo-key', 'maintenance', 'make-webhook'];
  const sql = getSQL();
  const token = getToken(req);
  if (!token) return sendJSON(res, 401, { error: 'Token manquant' });
  let payload;
  try { payload = verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Token invalide ou expiré' }); }

  if (req.method === 'GET') {
    const rows = await sql`SELECT key, value FROM config`;
    return sendJSON(res, 200, Object.fromEntries(rows.map(r => [r.key, r.value])));
  }
  if (req.method === 'POST') {
    if (!['superadmin', 'admin', 'leader'].includes(payload.role))
      return sendJSON(res, 403, { error: 'Accès refusé' });
    const cfg = req.body;
    if (!cfg || typeof cfg !== 'object') return sendJSON(res, 400, { error: 'Payload invalide' });
    const invalidKeys = Object.keys(cfg).filter(k => !WRITABLE_KEYS.includes(k));
    if (invalidKeys.length > 0) return sendJSON(res, 400, { error: `Clés non autorisées : ${invalidKeys.join(', ')}` });
    try {
      for (const [key, value] of Object.entries(cfg)) {
        await sql`INSERT INTO config (key, value) VALUES (${key}, ${String(value)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      }
      return sendJSON(res, 200, { status: 'ok' });
    } catch (err) {
      console.error('Config POST error:', err);
      return sendJSON(res, 500, { error: 'Erreur serveur' });
    }
  }
}

// GET|POST /api/intros
async function handleIntros(req, res) {
  const sql = getSQL();
  const ALLOWED_ROLES = ['admin', 'leader', 'superadmin'];

  if (req.method === 'GET') {
    const slug = req.query.slug || 'cilf';
    if (req.query.archived === 'true') {
      const rows = await sql`
        SELECT i.id, i.animateur, i.titre, i.date, i.heure, i.heure_fin,
               i.animateur_email, i.cc_date, i.cc_heure, i.cc_heure_fin,
               i.zoom_intro, i.zoom_cc, i.archived_at, i.archived_by,
               i.archive_reason, i.archive_reason_text, i.modified_by, i.modified_by_id, i.modified_at
        FROM introductions i WHERE i.slug = ${slug} AND i.archived = true ORDER BY i.archived_at DESC
      `;
      const result = [];
      for (const r of rows) {
        const guests = await sql`SELECT id, nom, email FROM guests WHERE introduction_id = ${r.id}`;
        result.push({
          id: r.id, animateur: r.animateur, titre: r.titre, date: fmtDate(r.date),
          heure: r.heure, heureFin: r.heure_fin, animateurEmail: r.animateur_email,
          ccDate: fmtDate(r.cc_date), ccHeure: r.cc_heure, ccHeureFin: r.cc_heure_fin,
          zoomIntro: r.zoom_intro || null, zoomCC: r.zoom_cc || null,
          archivedAt: r.archived_at || null, archivedBy: r.archived_by || null,
          archive_reason: r.archive_reason || null, archive_reason_text: r.archive_reason_text || null,
          modified_by: r.modified_by || null,
          guests: guests.map(g => ({ id: g.id, nom: g.nom, email: g.email })),
        });
      }
      return sendJSON(res, 200, result);
    }
    const rows = await sql`
      SELECT id, animateur, titre, date, heure, heure_fin, animateur_email,
             cc_date, cc_heure, cc_heure_fin, zoom_intro, zoom_cc,
             modified_by, modified_by_id, modified_at
      FROM introductions WHERE slug = ${slug} AND archived = false ORDER BY id ASC
    `;
    return sendJSON(res, 200, rows.map(r => ({
      id: r.id, animateur: r.animateur, titre: r.titre, date: fmtDate(r.date),
      heure: r.heure, heureFin: r.heure_fin, animateurEmail: r.animateur_email,
      ccDate: fmtDate(r.cc_date), ccHeure: r.cc_heure, ccHeureFin: r.cc_heure_fin,
      zoomIntro: r.zoom_intro || null, zoomCC: r.zoom_cc || null,
      modified_by: r.modified_by || null, modified_by_id: r.modified_by_id || null, modified_at: r.modified_at || null,
    })));
  }

  if (req.method === 'POST') {
    const token = getToken(req);
    if (!token) return sendJSON(res, 401, { error: 'Non autorisé' });
    let payload;
    try { payload = verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Token invalide ou expiré' }); }
    if (!ALLOWED_ROLES.includes(payload.role))
      return sendJSON(res, 403, { error: `Accès non autorisé (rôle: ${payload.role})` });

    const { slug = 'cilf', intros, modified_by = null, modified_by_id = null, modified_at = null, action, intro_id } = req.body || {};

    if (action === 'archive' && intro_id) {
      const { reason = null, reason_text = null } = req.body;
      const archivedBy = payload.name || payload.email || null;
      await sql`UPDATE introductions SET archived = true, archived_at = NOW(), archive_reason = ${reason}, archive_reason_text = ${reason_text}, archived_by = ${archivedBy} WHERE id = ${intro_id} AND slug = ${slug}`;
      await sql`UPDATE guests SET archived = true WHERE introduction_id = ${intro_id}`;
      return sendJSON(res, 200, { status: 'archived' });
    }
    if (action === 'restore' && intro_id) {
      await sql`UPDATE introductions SET archived = false, archived_at = NULL WHERE id = ${intro_id} AND slug = ${slug}`;
      await sql`UPDATE guests SET archived = false WHERE introduction_id = ${intro_id}`;
      return sendJSON(res, 200, { status: 'restored' });
    }
    if (action === 'delete_permanent' && intro_id) {
      await sql`DELETE FROM guests WHERE introduction_id = ${intro_id}`;
      await sql`DELETE FROM introductions WHERE id = ${intro_id} AND slug = ${slug}`;
      return sendJSON(res, 200, { status: 'deleted' });
    }
    if (!Array.isArray(intros)) return sendJSON(res, 400, { error: 'intros doit être un tableau' });
    const isRealId = (id) => id && Number(id) < 1_000_000_000_000;
    const incomingIds = intros.filter(i => isRealId(i.id)).map(i => i.id);
    const existing = await sql`SELECT id FROM introductions WHERE slug = ${slug} AND archived = false`;
    const toArchive = existing.map(r => r.id).filter(id => !incomingIds.includes(id));
    for (const id of toArchive) {
      await sql`UPDATE introductions SET archived = true, archived_at = NOW() WHERE id = ${id}`;
      await sql`UPDATE guests SET archived = true WHERE introduction_id = ${id}`;
    }
    for (const intro of intros) {
      if (isRealId(intro.id)) {
        await sql`
          UPDATE introductions SET
            animateur = ${intro.animateur || ''}, titre = ${intro.titre || ''},
            date = ${orNull(intro.date)}, heure = ${orNull(intro.heure)}, heure_fin = ${orNull(intro.heureFin)},
            animateur_email = ${intro.animateurEmail || ''}, cc_date = ${orNull(intro.ccDate)},
            cc_heure = ${orNull(intro.ccHeure)}, cc_heure_fin = ${orNull(intro.ccHeureFin)},
            zoom_intro = ${orNull(intro.zoomIntro)}, zoom_cc = ${orNull(intro.zoomCC)},
            modified_by = ${modified_by}, modified_by_id = ${modified_by_id}, modified_at = ${orNull(modified_at)}, archived = false
          WHERE id = ${intro.id} AND slug = ${slug}
        `;
      } else {
        await sql`
          INSERT INTO introductions (slug, animateur, titre, date, heure, heure_fin, animateur_email, cc_date, cc_heure, cc_heure_fin, zoom_intro, zoom_cc, modified_by, modified_by_id, modified_at, archived)
          VALUES (${slug}, ${intro.animateur || ''}, ${intro.titre || ''}, ${orNull(intro.date)}, ${orNull(intro.heure)}, ${orNull(intro.heureFin)}, ${intro.animateurEmail || ''}, ${orNull(intro.ccDate)}, ${orNull(intro.ccHeure)}, ${orNull(intro.ccHeureFin)}, ${orNull(intro.zoomIntro)}, ${orNull(intro.zoomCC)}, ${modified_by}, ${modified_by_id}, ${orNull(modified_at)}, false)
        `;
      }
    }
    return sendJSON(res, 200, { status: 'ok', count: intros.length });
  }
}

// GET|POST /api/guests
async function handleGuests(req, res) {
  const sql = getSQL();
  await sql`CREATE TABLE IF NOT EXISTS grad_guests (id SERIAL PRIMARY KEY, type VARCHAR(20) DEFAULT 'guest', guest_name TEXT, guest_email TEXT, grad_name TEXT, grad_email TEXT, animateur TEXT, titre TEXT, date TEXT, date_tah TEXT, introduction_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`ALTER TABLE grad_guests ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'guest'`;

  if (req.method === 'GET') {
    const token = getToken(req);
    let user = null;
    try { user = verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Non autorisé' }); }
    try {
      let rows;
      if (user.role === 'superadmin') {
        rows = await sql`SELECT gg.*, COALESCE(i.archived, false) AS intro_archived FROM grad_guests gg LEFT JOIN introductions i ON i.id::text = gg.introduction_id ORDER BY gg.created_at DESC`;
      } else if (['utilisateur', 'gradue', 'leader_intro'].includes(user.role)) {
        rows = await sql`SELECT gg.*, COALESCE(i.archived, false) AS intro_archived FROM grad_guests gg LEFT JOIN introductions i ON i.id::text = gg.introduction_id WHERE gg.grad_email = ${user.email} ORDER BY gg.created_at DESC`;
      } else {
        return sendJSON(res, 403, { error: 'Accès refusé' });
      }
      return sendJSON(res, 200, rows);
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.action === 'add') {
      try {
        const { type, guest_name, guest_email, grad_name, grad_email, animateur, titre, date, date_tah, introduction_id, timestamp } = body;
        await sql`
          INSERT INTO grad_guests (type, guest_name, guest_email, grad_name, grad_email, animateur, titre, date, date_tah, introduction_id, created_at)
          VALUES (${type || 'guest'}, ${guest_name || null}, ${guest_email || null}, ${grad_name || null}, ${(grad_email || '').toLowerCase()}, ${animateur || null}, ${titre || null}, ${date || null}, ${date_tah || null}, ${String(introduction_id || '')}, ${timestamp ? new Date(timestamp) : new Date()})
        `;
        return sendJSON(res, 200, { success: true });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    }
    return sendJSON(res, 400, { error: 'Action inconnue' });
  }
}

// GET|POST /api/profile
async function handleProfile(req, res) {
  const sql = getSQL();
  const token = getToken(req);
  if (!token) return sendJSON(res, 401, { error: 'Non authentifié' });
  let payload;
  try { payload = verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Token invalide' }); }

  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT id, name, first_name, last_name, email, role, pid, telephone FROM users WHERE id = ${payload.id}`;
      if (rows.length === 0) return sendJSON(res, 404, { error: 'Utilisateur introuvable' });
      const u = rows[0];
      if (!u.first_name && u.name) {
        const parts = u.name.trim().split(' ');
        u.first_name = parts[0] || ''; u.last_name = parts.slice(1).join(' ') || '';
      }
      return sendJSON(res, 200, u);
    } catch (err) { return sendJSON(res, 500, { error: err.message }); }
  }

  if (req.method === 'POST') {
    const { first_name, last_name, name: bodyName, telephone, pid, password, new_password } = req.body || {};
    const name = first_name && last_name ? `${first_name.trim()} ${last_name.trim()}`.trim() : (bodyName || null);
    const fn = first_name ? first_name.trim() : null;
    const ln = last_name  ? last_name.trim()  : null;
    if (pid && !/^\d{7}$/.test(pid)) return sendJSON(res, 400, { error: 'Le PID doit contenir exactement 7 chiffres' });
    try {
      if (new_password) {
        if (!password) return sendJSON(res, 400, { error: 'Mot de passe actuel requis' });
        const check = await sql`SELECT id FROM users WHERE id = ${payload.id} AND password_hash = crypt(${password}, password_hash)`;
        if (check.length === 0) return sendJSON(res, 401, { error: 'Mot de passe actuel incorrect' });
        await sql`UPDATE users SET name = COALESCE(${name}, name), first_name = COALESCE(${fn}, first_name), last_name = COALESCE(${ln}, last_name), telephone = COALESCE(${telephone || null}, telephone), pid = COALESCE(${pid || null}, pid), password_hash = crypt(${new_password}, gen_salt('bf')), updated_at = NOW() WHERE id = ${payload.id}`;
      } else {
        await sql`UPDATE users SET name = COALESCE(${name}, name), first_name = COALESCE(${fn}, first_name), last_name = COALESCE(${ln}, last_name), telephone = COALESCE(${telephone || null}, telephone), pid = COALESCE(${pid || null}, pid), updated_at = NOW() WHERE id = ${payload.id}`;
      }
      const rows = await sql`SELECT id, name, first_name, last_name, email, role, pid, telephone FROM users WHERE id = ${payload.id}`;
      return sendJSON(res, 200, { success: true, user: rows[0] });
    } catch (err) {
      console.error('Profile update error:', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }
}

// GET /api/users-list
async function handleUsersList(req, res) {
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const token = getToken(req);
  if (!token) return sendJSON(res, 401, { error: 'Non authentifié' });
  try { verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Token invalide ou expiré' }); }
  const sql = getSQL();
  try {
    const users = await sql`SELECT * FROM users ORDER BY name ASC`;
    const safe = users.map(u => {
      const { password, password_hash, reset_token, reset_token_expires_at, ...rest } = u;
      return rest;
    });
    return sendJSON(res, 200, safe);
  } catch (err) {
    console.error('Users list error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// POST /api/users
async function handleUsers(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const token = getToken(req);
  if (!token) return sendJSON(res, 401, { error: 'Non authentifié' });
  let payload;
  try { payload = verifyJWT(token); } catch { return sendJSON(res, 401, { error: 'Token invalide ou expiré' }); }
  if (payload.role !== 'superadmin') return sendJSON(res, 403, { error: 'Accès réservé aux administrateurs' });

  const { action, userId, first_name, last_name, email, password, role, pid, telephone, fonction } = req.body || {};
  const fullName = (first_name && last_name) ? `${first_name.trim()} ${last_name.trim()}` : (first_name || last_name || '');
  const sql = getSQL();

  if (action === 'approve') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    await sql`UPDATE users SET approved = true WHERE id = ${userId}`;
    return sendJSON(res, 200, { success: true });
  }
  if (action === 'reject' || action === 'delete') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    await sql`DELETE FROM users WHERE id = ${userId}`;
    return sendJSON(res, 200, { success: true });
  }
  if (action === 'reset_password') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    const rows = await sql`SELECT id, name, email FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return sendJSON(res, 404, { error: 'Utilisateur introuvable' });
    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + 3600 * 1000);
    await sql`UPDATE users SET reset_token = ${resetToken}, reset_token_expires_at = ${expiresAt}, updated_at = NOW() WHERE id = ${user.id}`;
    const resetLink = `${APP_URL}?reset=${resetToken}`;
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'forgot_password', name: user.name, email: user.email, reset_link: resetLink }) });
      } catch (e) { console.error('Make webhook error (reset_password):', e.message); }
    }
    return sendJSON(res, 200, { success: true });
  }
  if (action === 'edit') {
    if (!userId || !first_name || !last_name || !email) return sendJSON(res, 400, { error: 'Prénom, nom et email requis' });
    try {
      await sql`UPDATE users SET first_name = ${first_name.trim()}, last_name = ${last_name.trim()}, name = ${fullName}, email = ${email}, role = COALESCE(${role || null}, role), pid = ${pid || null}, telephone = ${telephone || null}, fonction = ${fonction || null}, updated_at = NOW() WHERE id = ${userId}`;
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      if (err.message.includes('unique') || err.message.includes('duplicate'))
        return sendJSON(res, 409, { error: 'Cet email est déjà utilisé par un autre compte' });
      return sendJSON(res, 500, { error: 'Erreur serveur' });
    }
  }
  // Créer
  if (!first_name || !last_name || !email || !password || !role) return sendJSON(res, 400, { error: 'Prénom, nom, email, mot de passe et rôle requis' });
  if (!['superadmin', 'utilisateur', 'gradue'].includes(role)) return sendJSON(res, 400, { error: 'Rôle invalide' });
  try {
    await sql`INSERT INTO users (email, password_hash, role, name, first_name, last_name, approved, fonction) VALUES (${email}, crypt(${password}, gen_salt('bf')), ${role}, ${fullName}, ${first_name.trim()}, ${last_name.trim()}, true, ${fonction || null})`;
    return sendJSON(res, 201, { success: true });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate'))
      return sendJSON(res, 409, { error: 'Cet email est déjà utilisé' });
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// POST /api/forgot-password
async function handleForgotPassword(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const { email } = req.body || {};
  if (!email) return sendJSON(res, 400, { error: 'Email requis' });
  const sql = getSQL();
  try {
    const rows = await sql`SELECT id, name, role FROM users WHERE LOWER(email) = LOWER(${email})`;
    if (rows.length === 0) return sendJSON(res, 200, { success: true }); // anti-énumération
    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + 3600 * 1000);
    const resetLink  = `${APP_URL}?reset=${resetToken}`;
    await sql`UPDATE users SET reset_token = ${resetToken}, reset_token_expires_at = ${expiresAt}, updated_at = NOW() WHERE id = ${user.id}`;
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'forgot_password', name: user.name || '', email, role: user.role || '', reset_link: resetLink }) });
      } catch (e) { console.error('Make webhook error (forgot-password):', e.message); }
    }
    return sendJSON(res, 200, { success: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// POST /api/reset-password
async function handleResetPassword(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const { token, password } = req.body || {};
  if (!token || !password) return sendJSON(res, 400, { error: 'Token et nouveau mot de passe requis' });
  if (password.length < 6) return sendJSON(res, 400, { error: 'Le mot de passe doit contenir au moins 6 caractères' });
  const sql = getSQL();
  try {
    const rows = await sql`SELECT id FROM users WHERE reset_token = ${token} AND reset_token_expires_at > NOW()`;
    if (rows.length === 0) return sendJSON(res, 400, { error: 'Lien invalide ou expiré. Veuillez refaire une demande.' });
    await sql`UPDATE users SET password_hash = crypt(${password}, gen_salt('bf')), reset_token = NULL, reset_token_expires_at = NULL, updated_at = NOW() WHERE id = ${rows[0].id}`;
    return sendJSON(res, 200, { success: true, message: 'Mot de passe mis à jour avec succès.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

// POST /api/webhook-make
async function handleWebhookMake(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const PUBLIC_TYPES  = ['forgot_password'];
  const ALLOWED_TYPES = ['forgot_password', 'solo', 'guest', 'guest_self'];
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return sendJSON(res, 400, { error: 'Payload invalide' });
  const { type } = payload;
  if (!ALLOWED_TYPES.includes(type)) return sendJSON(res, 400, { error: `Type non autorisé : ${type}` });
  if (!PUBLIC_TYPES.includes(type)) {
    const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token) return sendJSON(res, 401, { error: 'Token manquant' });
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Format JWT invalide');
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      if (!decoded.exp || Date.now() / 1000 > decoded.exp) return sendJSON(res, 401, { error: 'Token expiré' });
      if (!decoded.role) return sendJSON(res, 403, { error: 'Rôle manquant dans le token' });
    } catch { return sendJSON(res, 401, { error: 'Token invalide' }); }
  }
  if (!MAKE_WEBHOOK_URL) {
    console.error('[webhook-make] MAKE_WEBHOOK_URL non définie');
    return sendJSON(res, 500, { error: 'Configuration serveur manquante' });
  }
  try {
    const makeRes = await fetch(MAKE_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await makeRes.text();
    return sendJSON(res, makeRes.ok ? 200 : 502, { ok: makeRes.ok, make_status: makeRes.status, make_response: text });
  } catch (e) {
    console.error('[webhook-make] Erreur appel Make:', e.message);
    return sendJSON(res, 502, { error: 'Impossible de joindre Make.com' });
  }
}

// GET /api/reminders
async function handleReminders(req, res) {
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== process.env.REMINDERS_SECRET) return sendJSON(res, 401, { error: 'Non autorisé' });
  const sql = getSQL();
  try {
    const nowUTC   = Date.now();
    const tahOffset = -10 * 60 * 60000;
    const tahNow   = new Date(nowUTC + tahOffset);
    const tahHour  = tahNow.getUTCHours();
    const tahMin   = tahNow.getUTCMinutes();
    const todayTAH = tahNow.toISOString().slice(0, 10);
    const matinResults = [], preIntroResults = [];

    const isMatinWindow = (tahHour === 6 && tahMin >= 50) || (tahHour === 7 && tahMin <= 10);
    if (isMatinWindow) {
      const rows = await sql`
        SELECT g.id AS guest_id, g.email, g.nom, i.id AS intro_id, i.titre, i.date, i.heure, i.heure_fin,
               i.animateur, i.animateur_email, i.zoom_intro, i.zoom_cc, i.cc_date, i.cc_heure, i.cc_heure_fin, i.slug
        FROM guests g JOIN introductions i ON i.id = g.introduction_id
        WHERE g.rappel_matin_envoye = false AND g.archived = false AND i.archived = false AND i.date = ${todayTAH}
      `;
      for (const r of rows) {
        matinResults.push({ type: 'rappel_matin', guest_id: r.guest_id, email: r.email, nom: r.nom,
          titre: r.titre || '', date: r.date ? r.date.toISOString().slice(0,10) : '', heure: r.heure || '',
          heure_fin: r.heure_fin || '', animateur: r.animateur || '', animateur_email: r.animateur_email || '',
          zoom_intro: r.zoom_intro || '', zoom_cc: r.zoom_cc || '',
          cc_date: r.cc_date ? r.cc_date.toISOString().slice(0,10) : '', cc_heure: r.cc_heure || '',
          cc_heure_fin: r.cc_heure_fin || '', slug: r.slug || '' });
      }
    }

    const rows40 = await sql`
      SELECT g.id AS guest_id, g.email, g.nom, i.id AS intro_id, i.titre, i.date, i.heure, i.heure_fin,
             i.animateur, i.animateur_email, i.zoom_intro, i.zoom_cc, i.cc_date, i.cc_heure, i.cc_heure_fin, i.slug
      FROM guests g JOIN introductions i ON i.id = g.introduction_id
      WHERE g.rappel_40min_envoye = false AND g.archived = false AND i.archived = false AND i.date = ${todayTAH}
    `;
    for (const r of rows40) {
      if (!r.heure) continue;
      const dateStr = r.date ? r.date.toISOString().slice(0,10) : '';
      if (!dateStr) continue;
      const [hh, mm] = r.heure.split(':').map(Number);
      const introUTC = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00Z`).getTime() + 10 * 3600000;
      const diffMin  = (introUTC - nowUTC) / 60000;
      if (diffMin < 35 || diffMin > 45) continue;
      preIntroResults.push({ type: 'rappel_40min', guest_id: r.guest_id, email: r.email, nom: r.nom,
        titre: r.titre || '', date: dateStr, heure: r.heure || '', heure_fin: r.heure_fin || '',
        animateur: r.animateur || '', animateur_email: r.animateur_email || '',
        zoom_intro: r.zoom_intro || '', zoom_cc: r.zoom_cc || '',
        cc_date: r.cc_date ? r.cc_date.toISOString().slice(0,10) : '', cc_heure: r.cc_heure || '',
        cc_heure_fin: r.cc_heure_fin || '', slug: r.slug || '' });
    }

    const toSend = [...matinResults, ...preIntroResults];
    return sendJSON(res, 200, { count: toSend.length, guests: toSend });
  } catch (e) {
    console.error('[reminders]', e);
    return sendJSON(res, 500, { error: e.message });
  }
}

// POST /api/reminders-mark
async function handleRemindersMark(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== process.env.REMINDERS_SECRET) return sendJSON(res, 401, { error: 'Non autorisé' });
  const { guest_id, type } = req.body || {};
  if (!guest_id) return sendJSON(res, 400, { error: 'guest_id requis' });
  if (!type)     return sendJSON(res, 400, { error: 'type requis (rappel_matin ou rappel_40min)' });
  const sql = getSQL();
  try {
    if (type === 'rappel_matin') {
      await sql`UPDATE guests SET rappel_matin_envoye = true WHERE id = ${guest_id}`;
    } else if (type === 'rappel_40min') {
      await sql`UPDATE guests SET rappel_40min_envoye = true WHERE id = ${guest_id}`;
    } else {
      return sendJSON(res, 400, { error: 'type invalide — utiliser rappel_matin ou rappel_40min' });
    }
    return sendJSON(res, 200, { success: true, guest_id, type });
  } catch (e) {
    console.error('[reminders-mark]', e);
    return sendJSON(res, 500, { error: e.message });
  }
}

// ── Routeur principal ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Extrait le nom de la route depuis l'URL
  // /api/login → 'login'  |  /api/intros?slug=cilf → 'intros'
  const url   = req.url || '';
  const route = url.replace(/^\/api\//, '').split('?')[0].split('/')[0];

  try {
    switch (route) {
      case 'login':           return await handleLogin(req, res);
      case 'register':        return await handleRegister(req, res);
      case 'config':          return await handleConfig(req, res);
      case 'intros':          return await handleIntros(req, res);
      case 'guests':          return await handleGuests(req, res);
      case 'profile':         return await handleProfile(req, res);
      case 'users-list':      return await handleUsersList(req, res);
      case 'users':           return await handleUsers(req, res);
      case 'forgot-password': return await handleForgotPassword(req, res);
      case 'reset-password':  return await handleResetPassword(req, res);
      case 'webhook-make':    return await handleWebhookMake(req, res);
      case 'reminders':       return await handleReminders(req, res);
      case 'reminders-mark':  return await handleRemindersMark(req, res);
      default:
        return sendJSON(res, 404, { error: `Route inconnue : /api/${route}` });
    }
  } catch (err) {
    console.error(`[api/${route}]`, err);
    return sendJSON(res, 500, { error: 'Erreur serveur inattendue' });
  }
};
