// api/forgot-password.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);
const MAKE_WEBHOOK_RESET = process.env.MAKE_WEBHOOK_RESET || 'https://hook.us2.make.com/hwd31jmdqvpo3eoq5u04rjigdm2s9nxu';
const APP_URL = process.env.APP_URL || 'https://landmark-pacifique.vercel.app';

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
    // 1. Vérifie que l'email existe en base
    const rows = await sql`
      SELECT id, name, role FROM users WHERE LOWER(email) = LOWER(${email})
    `;

    if (rows.length === 0) {
      console.log('Email non trouvé en base:', email);
      return res.status(200).json({ success: true });
    }

    const user = rows[0];
    console.log('Utilisateur trouvé:', user.name);

    // 2. Génère un token sécurisé valable 1 heure
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600 * 1000);

    // 3. Sauvegarde le token en base
    await sql`
      UPDATE users
      SET reset_token = ${resetToken},
          reset_token_expires_at = ${expiresAt},
          updated_at = NOW()
      WHERE id = ${user.id}
    `;
    console.log('Token sauvegardé en base');

    // 4. Construit le lien de reset
    const resetLink = `${APP_URL}?reset=${resetToken}`;
    console.log('Reset link généré');

    // 5. Appelle le webhook Make
    console.log('Appel webhook Make:', MAKE_WEBHOOK_RESET);
    try {
      const webhookRes = await fetch(MAKE_WEBHOOK_RESET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type:       'forgot_password',
          name:       user.name,
          email:      email,
          role:       user.role,
          reset_link: resetLink
        })
      });
      const webhookBody = await webhookRes.text();
      console.log('Make webhook status:', webhookRes.status);
      console.log('Make webhook response:', webhookBody);
    } catch (webhookErr) {
      console.error('Make webhook fetch error:', webhookErr.message);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
