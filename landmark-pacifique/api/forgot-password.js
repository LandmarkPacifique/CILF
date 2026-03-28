// api/forgot-password.js
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const sql = neon(process.env.DATABASE_URL);

const MAKE_WEBHOOK_RESET = process.env.MAKE_WEBHOOK_RESET || 'https://hook.us2.make.com/hwd31jmdqvpo3eoq5u04rjigdm2s9nxu';
const APP_URL = process.env.APP_URL || 'https://project-pajuk.vercel.app';

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
    if (rows.length === 0) return sendJSON(res, 200, { success: true });

    const user = rows[0];

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600 * 1000);

    await sql`
      UPDATE users
      SET reset_token = ${resetToken},
          reset_token_expires_at = ${expiresAt},
          updated_at = NOW()
      WHERE id = ${user.id}
    `;

    const resetLink = `${APP_URL}?reset=${resetToken}`;

    try {
      await fetch(MAKE_WEBHOOK_RESET, {
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
    } catch (webhookErr) {
      console.error('Make webhook error:', webhookErr.message);
    }

    return sendJSON(res, 200, { success: true });

  } catch (err) {
    console.error('Forgot password error:', err);
    return sendJSON(res, 500, { error: 'Erreur serveur', detail: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
