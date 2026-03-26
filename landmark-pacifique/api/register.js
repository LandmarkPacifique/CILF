// api/register.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { name, email, password, role, pid, telephone } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nom, email et mot de passe requis' });
  }

  // Rôle par défaut : gradué
  const userRole = role || 'gradue';

  // Seul un admin peut créer un leader ou admin
  if (['admin', 'leader'].includes(userRole)) {
    const auth = req.headers['authorization'] || '';
    const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const token = rawToken || req.headers['x-admin-token'] || null;
    if (!token) return res.status(401).json({ error: 'Non autorisé' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.role !== 'admin') {
        return res.status(403).json({ error: 'Seul un admin peut créer ce rôle' });
      }
    } catch {
      return res.status(401).json({ error: 'Token invalide' });
    }
  }

  // Validation PID (7 chiffres) si fourni
  if (pid && !/^\d{7}$/.test(pid)) {
    return res.status(400).json({ error: 'Le PID doit contenir exactement 7 chiffres' });
  }

  try {
    await sql`
      INSERT INTO users (email, password_hash, role, name, pid, telephone)
      VALUES (
        ${email},
        crypt(${password}, gen_salt('bf')),
        ${userRole},
        ${name},
        ${pid || null},
        ${telephone || null}
      )
    `;

    // Génère un JWT directement pour connecter l'utilisateur
    const result = await sql`
      SELECT id, role, name FROM users WHERE email = ${email}
    `;
    const user = result[0];
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email },
      process.env.JWT_SECRET
      // Pas d'expiration
    );

    return res.status(201).json({ token, role: user.role, name: user.name });

  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
