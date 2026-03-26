// api/reset-password.js
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { token, new_password } = req.body || {};
  if (!token || !new_password) {
    return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
  }

  try {
    // 1. Vérifie que le token existe et n'est pas expiré
    const rows = await sql`
      SELECT id, name, email FROM users
      WHERE reset_token = ${token}
        AND reset_token_expires_at > NOW()
    `;

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Lien invalide ou expiré' });
    }

    const user = rows[0];

    // 2. Hash le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // 3. Met à jour le mot de passe et supprime le token
    await sql`
      UPDATE users
      SET password_hash = ${hashedPassword},
          reset_token = NULL,
          reset_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
