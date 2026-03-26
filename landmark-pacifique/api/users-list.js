// api/users-list.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // Accepte le token depuis Authorization: Bearer OU x-admin-token
  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = rawToken || req.headers['x-admin-token'] || null;

  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  try {
    const users = await sql`
      SELECT id, name, email, pid, telephone, status, role, approved, validated
      FROM users
      ORDER BY name ASC
    `;
    return res.status(200).json(users);
  } catch (err) {
    console.error('Users list error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
