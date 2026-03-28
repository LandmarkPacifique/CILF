// api/users.js
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

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = rawToken || req.headers['x-admin-token'] || null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  if (payload.role !== 'superadmin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }

  const { action, userId, name, email, password, role, pid, telephone, fonction } = await parseBody(req);

  // ── APPROUVER ────────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      await sql`UPDATE users SET approved = true WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── REFUSER ──────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── SUPPRIMER ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── MODIFIER ─────────────────────────────────────────────────────────────────
  if (action === 'edit') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    if (!name || !email) return res.status(400).json({ error: 'Nom et email requis' });

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
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Edit error:', err);
      if (err.message.includes('unique') || err.message.includes('duplicate')) {
        return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte' });
      }
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── CRÉER ─────────────────────────────────────────────────────────────────────
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  if (!['superadmin', 'utilisateur', 'gradue'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  if (role === 'superadmin' && payload.role !== 'superadmin') {
    return res.status(403).json({ error: 'Seul un super admin peut créer un autre super admin' });
  }
  try {
    await sql`
      INSERT INTO users (email, password_hash, role, name, approved, fonction)
      VALUES (${email}, crypt(${password}, gen_salt('bf')), ${role}, ${name}, true, ${fonction || null})
    `;
    return res.status(201).json({ success: true });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
