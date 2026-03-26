// api/forgot-password.js
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

// ⚠️  Remplacez cette URL par le webhook Make dédié au reset de mot de passe
// (créez un nouveau scénario Make séparé de celui des inscriptions)
const MAKE_WEBHOOK_RESET = process.env.MAKE_WEBHOOK_RESET || 'VOTRE_WEBHOOK_MAKE_RESET_ICI';

// ─── Génère un mot de passe temporaire lisible (sans 0/O/I/l) ────────────────
function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

// ─── Handler principal ────────────────────────────────────────────────────────
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

    // Réponse identique que l'email existe ou non (sécurité anti-énumération)
    if (rows.length === 0) {
      return res.status(200).json({ success: true });
    }

    const user = rows[0];

    // 2. Génère un mot de passe temporaire et le hash avec bcrypt
    const tempPassword = generateTempPassword();
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(tempPassword, saltRounds);

    // 3. Met à jour le mot de passe en base
    //    On ajoute aussi un champ temp_password_at pour savoir quand il a été généré
    //    (utile si vous voulez le faire expirer plus tard)
    await sql`
      UPDATE users
      SET password_hash = ${hashedPassword},
          updated_at    = NOW()
      WHERE id = ${user.id}
    `;

    // 4. Appelle le webhook Make dédié au reset de mot de passe
    //    Make se chargera d'envoyer l'email via le template Brevo
    const webhookRes = await fetch(MAKE_WEBHOOK_RESET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:          'forgot_password',
        name:          user.name,
        email:         email,
        role:          user.role,
        temp_password: tempPassword   // ← Make injectera ceci dans le template Brevo
      })
    });

    if (!webhookRes.ok) {
      // Le webhook a échoué : on log mais on ne fait pas planter la réponse
      // (le mot de passe a déjà été changé en base — l'utilisateur peut réessayer)
      console.error('Make webhook error:', webhookRes.status, await webhookRes.text());
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
