// api/register.js
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { name, email, password, pid, telephone, fonction } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nom, email et mot de passe requis' });
  }

  // Tous les comptes publics sont créés en "utilisateur", en attente de validation
  // La fonction (leader_intro, gradue, etc.) est stockée séparément
  const userRole = 'utilisateur';
  const userFonction = ['leader_intro', 'gradue'].includes(fonction) ? fonction : null;

  // Validation PID (7 chiffres) si fourni
  if (pid && !/^\d{7}$/.test(pid)) {
    return res.status(400).json({ error: 'Le PID doit contenir exactement 7 chiffres' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    await sql`
      INSERT INTO users (email, password_hash, role, name, pid, telephone, fonction, approved)
      VALUES (
        ${email},
        ${passwordHash},
        ${userRole},
        ${name},
        ${pid || null},
        ${telephone || null},
        ${userFonction},
        false
      )
    `;

    return res.status(201).json({
      message: 'Compte créé, en attente de validation par un administrateur.'
    });

  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
