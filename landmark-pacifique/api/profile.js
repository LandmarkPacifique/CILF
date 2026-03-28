const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const sql = neon(process.env.DATABASE_URL);

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

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return raw || req.headers['x-admin-token'] || null;
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.status(status).end(body);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getToken(req);
  if (!token) return sendJSON(res, 401, { error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return sendJSON(res, 401, { error: 'Token invalide' });
  }

  // GET — récupère le profil
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, name, first_name, last_name, email, role, pid, telephone
        FROM users WHERE id = ${payload.id}
      `;
      if (rows.length === 0) return sendJSON(res, 404, { error: 'Utilisateur introuvable' });
      const u = rows[0];
      // Fallback : si first_name/last_name vides, on les déduit de name
      if (!u.first_name && u.name) {
        const parts = u.name.trim().split(' ');
        u.first_name = parts[0] || '';
        u.last_name  = parts.slice(1).join(' ') || '';
      }
      return sendJSON(res, 200, u);
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // POST — met à jour le profil
  if (req.method === 'POST') {
    const body = await parseBody(req);
    const { first_name, last_name, name: bodyName, telephone, pid, password, new_password } = body;

    // Reconstruit name depuis first_name/last_name si fournis
    const name = first_name && last_name
      ? `${first_name.trim()} ${last_name.trim()}`.trim()
      : (bodyName || null);

    const fn = first_name ? first_name.trim() : null;
    const ln = last_name  ? last_name.trim()  : null;

    if (pid && !/^\d{7}$/.test(pid)) {
      return sendJSON(res, 400, { error: 'Le PID doit contenir exactement 7 chiffres' });
    }

    try {
      if (new_password) {
        if (!password) return sendJSON(res, 400, { error: 'Mot de passe actuel requis' });
        const check = await sql`
          SELECT id FROM users
          WHERE id = ${payload.id}
            AND password_hash = crypt(${password}, password_hash)
        `;
        if (check.length === 0) return sendJSON(res, 401, { error: 'Mot de passe actuel incorrect' });
        await sql`
          UPDATE users SET
            name          = COALESCE(${name}, name),
            first_name    = COALESCE(${fn}, first_name),
            last_name     = COALESCE(${ln}, last_name),
            telephone     = COALESCE(${telephone || null}, telephone),
            pid           = COALESCE(${pid || null}, pid),
            password_hash = crypt(${new_password}, gen_salt('bf')),
            updated_at    = NOW()
          WHERE id = ${payload.id}
        `;
      } else {
        await sql`
          UPDATE users SET
            name       = COALESCE(${name}, name),
            first_name = COALESCE(${fn}, first_name),
            last_name  = COALESCE(${ln}, last_name),
            telephone  = COALESCE(${telephone || null}, telephone),
            pid        = COALESCE(${pid || null}, pid),
            updated_at = NOW()
          WHERE id = ${payload.id}
        `;
      }
      const rows = await sql`
        SELECT id, name, first_name, last_name, email, role, pid, telephone
        FROM users WHERE id = ${payload.id}
      `;
      return sendJSON(res, 200, { success: true, user: rows[0] });
    } catch (err) {
      console.error('Profile update error:', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  return sendJSON(res, 405, { error: 'Méthode non autorisée' });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
