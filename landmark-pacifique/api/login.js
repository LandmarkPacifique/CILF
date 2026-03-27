// api/login.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const result = await sql`
      SELECT id, role, name, pid, telephone, status, validated
      FROM users
      WHERE email = ${email}
        AND password_hash = crypt(${password}, password_hash)
    `;

    if (result.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = result[0];

    // ✅ Vérification du statut de validation
    if (user.status !== 'approved' || !user.validated) {
      return res.status(403).json({ error: 'Votre compte est en attente de validation par un administrateur.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email },
      process.env.JWT_SECRET
    );

    return res.status(200).json({
      token,
      role: user.role,
      name: user.name,
      pid: user.pid || null,
      telephone: user.telephone || null
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
