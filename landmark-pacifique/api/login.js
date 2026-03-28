const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
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

  const { email, password } = await parseBody(req);
  if (!email || !password) {
    return sendJSON(res, 400, { error: 'Email et mot de passe requis' });
  }

  try {
    const result = await sql`
      SELECT id, role, name, pid, telephone, fonction, approved
      FROM users
      WHERE email = ${email}
        AND password_hash = crypt(${password}, password_hash)
    `;

    if (result.length === 0) {
      return sendJSON(res, 401, { error: 'Identifiants incorrects' });
    }

    const user = result[0];

    if (user.approved === false || user.approved === null) {
      return sendJSON(res, 403, {
        error: 'Votre compte est en attente de validation par un administrateur.'
      });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return sendJSON(res, 200, {
      token,
      role: user.role,
      name: user.name,
      pid: user.pid || null,
      telephone: user.telephone || null,
      fonction: user.fonction || null
    });

  } catch (err) {
    console.error('Login error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
