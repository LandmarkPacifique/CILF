// api/forgot-password.js
//
// ✅ Correction principale : le reset token ne transite plus par le frontend.
//    L'API construit elle-même le reset_link et appelle directement le webhook
//    Make.com (via la variable d'environnement MAKE_WEBHOOK_URL) pour envoyer
//    l'email. Le frontend ne reçoit plus le token dans la réponse JSON.
//
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const sql = neon(process.env.DATABASE_URL);

const APP_URL      = process.env.APP_URL       || 'https://www.landmark-pacifique.fr';
const MAKE_URL     = process.env.MAKE_WEBHOOK_URL;                 // URL Make, côté serveur uniquement
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.landmark-pacifique.fr';

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
  // ✅ CORS restreint au domaine du site
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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

    // ✅ Réponse identique que l'email existe ou non (anti-énumération)
    if (rows.length === 0) {
      return sendJSON(res, 200, { success: true });
    }

    const user = rows[0];
    const resetToken  = crypto.randomBytes(32).toString('hex');
    const expiresAt   = new Date(Date.now() + 3600 * 1000); // 1 heure
    const resetLink   = `${APP_URL}?reset=${resetToken}`;

    // Sauvegarde du token en base
    await sql`
      UPDATE users
      SET reset_token            = ${resetToken},
          reset_token_expires_at = ${expiresAt},
          updated_at             = NOW()
      WHERE id = ${user.id}
    `;

    // ✅ Appel Make.com directement depuis le serveur — le token ne quitte pas le backend
    if (MAKE_URL) {
      try {
        await fetch(MAKE_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type:       'forgot_password',
            name:       user.name  || '',
            email:      email,
            role:       user.role  || '',
            reset_link: resetLink,
          }),
        });
      } catch (makeErr) {
        // L'email n'a pas pu être envoyé, mais on ne révèle pas le détail au client
        console.error('Make webhook error (forgot-password):', makeErr.message);
      }
    } else {
      console.error('[forgot-password] MAKE_WEBHOOK_URL non définie — email non envoyé');
    }

    // ✅ Le frontend ne reçoit plus le token ni le reset_link
    return sendJSON(res, 200, { success: true });

  } catch (err) {
    console.error('Forgot password error:', err);
    // ✅ Pas de detail: err.message (fuite d'info serveur)
    return sendJSON(res, 500, { error: 'Erreur serveur' });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
