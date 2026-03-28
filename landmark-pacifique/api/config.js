// api/config.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT key, value FROM config`;
      return res.status(200).json(Object.fromEntries(rows.map(r => [r.key, r.value])));
    }

    if (req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return res.status(401).json({ error: 'Token manquant' });
      }

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: 'Token invalide' });
      }

      // ✅ CORRECTION : ajout de 'superadmin' dans les rôles autorisés
      const allowedRoles = ['superadmin', 'admin', 'leader'];
      if (!allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }

      const cfg = req.body;
      for (const [key, value] of Object.entries(cfg)) {
        await sql`
          INSERT INTO config (key, value) VALUES (${key}, ${String(value)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;
      }
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
