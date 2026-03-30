// api/config.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.landmark-pacifique.fr';

// Clés autorisées en écriture (whitelist stricte)
const WRITABLE_KEYS = [
  'apps-script',
  'brevo-key',
  'maintenance',
  'make-webhook',
];

function getToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader || null;
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET); // lève une exception si invalide
}

module.exports = async function handler(req, res) {
  // ✅ CORS restreint au domaine du site
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // ✅ GET config : authentification requise (la config peut contenir des URLs sensibles)
  if (req.method === 'GET') {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    try {
      verifyToken(token);
    } catch {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }
    const rows = await sql`SELECT key, value FROM config`;
    return res.status(200).json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  }

  if (req.method === 'POST') {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }

    const allowedRoles = ['superadmin', 'admin', 'leader'];
    if (!allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const cfg = req.body;
    if (!cfg || typeof cfg !== 'object') {
      return res.status(400).json({ error: 'Payload invalide' });
    }

    // ✅ Whitelist des clés autorisées en écriture
    const invalidKeys = Object.keys(cfg).filter(k => !WRITABLE_KEYS.includes(k));
    if (invalidKeys.length > 0) {
      return res.status(400).json({ error: `Clés non autorisées : ${invalidKeys.join(', ')}` });
    }

    try {
      for (const [key, value] of Object.entries(cfg)) {
        await sql`
          INSERT INTO config (key, value) VALUES (${key}, ${String(value)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;
      }
      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Config POST error:', err);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
};
