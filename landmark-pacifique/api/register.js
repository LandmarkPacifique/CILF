// api/register.js
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const sql = neon(process.env.DATABASE_URL);

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    req.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => {
      try { resolve(JSON.parse(data.toString('utf-8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { name, email, password, pid, telephone, fonction } = await parseBody(req);

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nom, email et mot de passe requis' });
  }

  const userRole = 'utilisateur';
  const userFonction = ['leader_intro', 'gradue'].includes(fonction) ? fonction : null;

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
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
