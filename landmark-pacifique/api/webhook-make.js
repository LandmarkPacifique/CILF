// api/webhook-make.js
// Proxy sécurisé vers le webhook Make.com
// L'URL Make reste côté serveur et n'est jamais exposée dans le HTML.
//
// Variable d'environnement à définir dans Vercel :
//   MAKE_WEBHOOK_URL = https://hook.us2.make.com/2njt9kkq4ovz75l0yg3otstsda4ug6ry
//
// Appels authentifiés (solo, guest, guest_self) → JWT requis dans Authorization header
// Appels publics (forgot_password) → pas de JWT (utilisateur non connecté)

const PUBLIC_TYPES = ['forgot_password'];

// Types autorisés (whitelist stricte — on rejette tout le reste)
const ALLOWED_TYPES = [
  'forgot_password',
  'solo',
  'guest',
  'guest_self',
];

export default async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.landmark-pacifique.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // ── Récupération du payload ───────────────────────────────────────────────────
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Payload invalide' });
  }

  const { type } = payload;

  // ── Whitelist des types ───────────────────────────────────────────────────────
  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: `Type non autorisé : ${type}` });
  }

  // ── Authentification JWT pour les types non-publics ──────────────────────────
  if (!PUBLIC_TYPES.includes(type)) {
    const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    // Décode le JWT sans lib externe (vérification basique de l'expiration)
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Format JWT invalide');
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

      if (!decoded.exp || Date.now() / 1000 > decoded.exp) {
        return res.status(401).json({ error: 'Token expiré' });
      }

      // Seuls les utilisateurs connectés peuvent déclencher le webhook
      if (!decoded.role) {
        return res.status(403).json({ error: 'Rôle manquant dans le token' });
      }
    } catch (e) {
      return res.status(401).json({ error: 'Token invalide' });
    }
  }

  // ── URL Make.com (variable d'environnement uniquement) ────────────────────────
  const makeUrl = process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) {
    console.error('[webhook-make] MAKE_WEBHOOK_URL non définie');
    return res.status(500).json({ error: 'Configuration serveur manquante' });
  }

  // ── Appel vers Make.com ───────────────────────────────────────────────────────
  try {
    const makeRes = await fetch(makeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Make répond généralement "Accepted" (200/204) — on relaie le statut
    const text = await makeRes.text();
    return res.status(makeRes.ok ? 200 : 502).json({
      ok: makeRes.ok,
      make_status: makeRes.status,
      make_response: text,
    });
  } catch (e) {
    console.error('[webhook-make] Erreur appel Make:', e.message);
    return res.status(502).json({ error: 'Impossible de joindre Make.com' });
  }
}
