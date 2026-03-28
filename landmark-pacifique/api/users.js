// api/users.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);

const MAKE_WEBHOOK_RESET = process.env.MAKE_WEBHOOK_RESET || 'https://hook.us2.make.com/hwd31jmdqvpo3eoq5u04rjigdm2s9nxu';
const APP_URL = process.env.APP_URL || 'https://www.landmark-pacifique.fr';

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    req.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => {
      try { resolve(JSON.parse(data.toString('utf-8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.status(status).end(body);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Méthode non autorisée' });

  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = rawToken || req.headers['x-admin-token'] || null;
  if (!token) return sendJSON(res, 401, { error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return sendJSON(res, 401, { error: 'Token invalide ou expiré' });
  }

  if (payload.role !== 'superadmin') {
    return sendJSON(res, 403, { error: 'Accès réservé aux administrateurs' });
  }

  const { action, userId, name, email, password, role, pid, telephone, fonction } = await parseBody(req);

  // ── APPROUVER ────────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    try {
      await sql`UPDATE users SET approved = true WHERE id = ${userId}`;
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── REFUSER ──────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── SUPPRIMER ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── RESET MOT DE PASSE (envoi email) ─────────────────────────────────────────
  if (action === 'reset_password') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    try {
      // Récupère l'utilisateur
      const rows = await sql`SELECT id, name, email FROM users WHERE id = ${userId}`;
      if (rows.length === 0) return sendJSON(res, 404, { error: 'Utilisateur introuvable' });
      const user = rows[0];

      // Génère un token sécurisé valable 1 heure
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600 * 1000);

      // Sauvegarde le token en base
      await sql`
        UPDATE users
        SET reset_token = ${resetToken},
            reset_token_expires_at = ${expiresAt},
            updated_at = NOW()
        WHERE id = ${user.id}
      `;

      // Construit le lien de reset
      const resetLink = `${APP_URL}?reset=${resetToken}`;

      // Appelle le webhook Make
      try {
        await fetch(MAKE_WEBHOOK_RESET, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type:       'forgot_password',
            name:       user.name,
            email:      user.email,
            reset_link: resetLink
          })
        });
      } catch (webhookErr) {
        console.error('Make webhook error:', webhookErr.message);
      }

      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('Reset password error:', err);
      return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── MODIFIER ─────────────────────────────────────────────────────────────────
  if (action === 'edit') {
    if (!userId) return sendJSON(res, 400, { error: 'userId requis' });
    if (!name || !email) return sendJSON(res, 400, { error: 'Nom et email requis' });

    try {
      if (password) {
        await sql`
          UPDATE users SET
            name          = ${name},
            email         = ${email},
            role          = COALESCE(${role || null}, role),
            pid           = ${pid || null},
            telephone     = ${telephone || null},
            fonction      = ${fonction || null},
            password_hash = crypt(${password}, gen_salt('bf'))
          WHERE id = ${userId}
        `;
      } else {
        await sql`
          UPDATE users SET
            name      = ${name},
            email     = ${email},
            role      = COALESCE(${role || null}, role),
            pid       = ${pid || null},
            telephone = ${telephone || null},
            fonction  = ${fonction || null}
          WHERE id = ${userId}
        `;
      }
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('Edit error:', err);
      if (err.message.includes('unique') || err.message.includes('duplicate')) {
        return sendJSON(res, 409, { error: 'Cet email est déjà utilisé par un autre compte' });
      }
      return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── CRÉER ─────────────────────────────────────────────────────────────────────
  if (!name || !email || !password || !role) {
    return sendJSON(res, 400, { error: 'Tous les champs sont requis' });
  }
  if (!['superadmin', 'utilisateur', 'gradue'].includes(role)) {
    return sendJSON(res, 400, { error: 'Rôle invalide' });
  }
  if (role === 'superadmin' && payload.role !== 'superadmin') {
    return sendJSON(res, 403, { error: 'Seul un super admin peut créer un autre super admin' });
  }
  try {
    await sql`
      INSERT INTO users (email, password_hash, role, name, approved, fonction)
      VALUES (${email}, crypt(${password}, gen_salt('bf')), ${role}, ${name}, true, ${fonction || null})
    `;
    return sendJSON(res, 201, { success: true });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return sendJSON(res, 409, { error: 'Cet email est déjà utilisé' });
    }
    console.error('Create user error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
