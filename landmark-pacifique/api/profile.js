// api/profile.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);

export const config = { api: { bodyParser: false } };

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf-8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }

  // GET — récupère le profil
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, name, email, role, pid, telephone
        FROM users WHERE id = ${payload.id}
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
      return res.status(200).json(rows[0]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — met à jour le profil
  if (req.method === 'POST') {
    const { name, telephone, pid, password, new_password } = await parseBody(req);

    if (pid && !/^\d{7}$/.test(pid)) {
      return res.status(400).json({ error: 'Le PID doit contenir exactement 7 chiffres' });
    }

    try {
      if (new_password) {
        if (!password) return res.status(400).json({ error: 'Mot de passe actuel requis' });
        const check = await sql`
          SELECT id FROM users
          WHERE id = ${payload.id}
            AND password_hash = crypt(${password}, password_hash)
        `;
        if (check.length === 0) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
        await sql`
          UPDATE users SET
            name          = COALESCE(${name || null}, name),
            telephone     = COALESCE(${telephone || null}, telephone),
            pid           = COALESCE(${pid || null}, pid),
            password_hash = crypt(${new_password}, gen_salt('bf')),
            updated_at    = NOW()
          WHERE id = ${payload.id}
        `;
      } else {
        await sql`
          UPDATE users SET
            name      = COALESCE(${name || null}, name),
            telephone = COALESCE(${telephone || null}, telephone),
            pid       = COALESCE(${pid || null}, pid),
            updated_at = NOW()
          WHERE id = ${payload.id}
        `;
      }

      const rows = await sql`
        SELECT id, name, email, role, pid, telephone FROM users WHERE id = ${payload.id}
      `;
      return res.status(200).json({ success: true, user: rows[0] });
    } catch (err) {
      console.error('Profile update error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};
