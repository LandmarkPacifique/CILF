// api/forgot-password.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const sql = neon(process.env.DATABASE_URL);
const APP_URL = process.env.APP_URL || 'https://www.landmark-pacifique.fr';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  }

  const { email } = await parseBody(req);
  if (!email) return sendJSON(res, 400, { error: 'Email requis' });

  try {
    const rows = await sql`
      SELECT id, name, role FROM users WHERE LOWER(email) = LOWER(${email})
    `;

    // Sécurité : ne pas révéler si l'email existe ou non
    if (rows.length === 0) return sendJSON(res, 200, { success: true });

    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 heure

    await sql`
      UPDATE users
      SET reset_token = ${resetToken},
          reset_token_expires_at = ${expiresAt},
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    // Retourne le token et les infos utilisateur au frontend
    // C'est le frontend qui appellera le webhook Make principal pour envoyer l'email
    return sendJSON(res, 200, {
      success: true,
      token: resetToken,
      name:  user.name,
      role:  user.role
    });

  } catch (err) {
    console.error('Forgot password error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
