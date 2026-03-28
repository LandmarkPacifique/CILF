// api/reset-password.js
const { neon } = require('@neondatabase/serverless');
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Méthode non autorisée' });
  }

  const { token, password } = await parseBody(req);

  if (!token || !password) {
    return sendJSON(res, 400, { error: 'Token et nouveau mot de passe requis' });
  }
  if (password.length < 6) {
    return sendJSON(res, 400, { error: 'Le mot de passe doit contenir au moins 6 caractères' });
  }

  try {
    const rows = await sql`
      SELECT id, name, email
      FROM users
      WHERE reset_token = ${token}
        AND reset_token_expires_at > NOW()
    `;

    if (rows.length === 0) {
      return sendJSON(res, 400, { error: 'Lien invalide ou expiré. Veuillez refaire une demande.' });
    }

    const user = rows[0];

    await sql`
      UPDATE users
      SET password_hash          = crypt(${password}, gen_salt('bf')),
          reset_token            = NULL,
          reset_token_expires_at = NULL,
          updated_at             = NOW()
      WHERE id = ${user.id}
    `;

    return sendJSON(res, 200, { success: true, message: 'Mot de passe mis à jour avec succès.' });

  } catch (err) {
    console.error('Reset password error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
