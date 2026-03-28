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

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.status(status).end(body);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  }

  const { first_name, last_name, email, password, pid, telephone, fonction } = await parseBody(req);

  if (!first_name || !last_name || !email || !password) {
    return sendJSON(res, 400, { error: 'Prénom, nom, email et mot de passe requis' });
  }

  const fullName = `${first_name.trim()} ${last_name.trim()}`;
  const userRole = 'utilisateur';
  const userFonction = ['leader_intro', 'gradue'].includes(fonction) ? fonction : null;

  if (pid && !/^\d{7}$/.test(pid)) {
    return sendJSON(res, 400, { error: 'Le PID doit contenir exactement 7 chiffres' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO users (email, password_hash, role, name, first_name, last_name, pid, telephone, fonction, approved)
      VALUES (
        ${email},
        ${passwordHash},
        ${userRole},
        ${fullName},
        ${first_name.trim()},
        ${last_name.trim()},
        ${pid || null},
        ${telephone || null},
        ${userFonction},
        false
      )
    `;
    return sendJSON(res, 201, {
      message: 'Compte créé, en attente de validation par un administrateur.'
    });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return sendJSON(res, 409, { error: 'Cet email est déjà utilisé' });
    }
    console.error('Register error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
