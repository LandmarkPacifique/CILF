// api/forgot-password.js
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const MAKE_WEBHOOK = 'https://hook.us2.make.com/2njt9kkq4ovz75l0yg3otstsda4ug6ry';

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    // Vérifie que l'email existe
    const rows = await sql`
      SELECT id, name, role FROM users WHERE email = ${email}
    `;
    if (rows.length === 0) {
      // On répond OK pour ne pas révéler si l'email existe
      return res.status(200).json({ success: true });
    }

    const user = rows[0];
    const tempPassword = generateTempPassword();

    // Met à jour le mot de passe en base
    await sql`
      UPDATE users
      SET password_hash = crypt(${tempPassword}, gen_salt('bf')),
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    // Envoie via webhook Make
    await fetch(MAKE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'forgot_password',
        name: user.name,
        email: email,
        role: user.role,
        temp_password: tempPassword
      })
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
