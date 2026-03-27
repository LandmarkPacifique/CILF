// api/users.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');
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

  // Auth
  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = rawToken || req.headers['x-admin-token'] || null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  // ✏️ CHANGEMENT 1 : anciennement 'admin' || 'leader' → 'superadmin' || 'admin'
  if (payload.role !== 'superadmin' && payload.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }

  const { action, userId, name, email, password, role, pid, telephone } = req.body || {};

  // ── APPROUVER ────────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      await sql`UPDATE users SET approved = true WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Approve error:', err);
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── REFUSER ──────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Reject error:', err);
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── SUPPRIMER ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    // ✏️ CHANGEMENT 2 : anciennement 'admin' → 'superadmin'
    if (payload.role !== 'superadmin') {
      return res.status(403).json({ error: 'Seul un super admin peut supprimer un utilisateur' });
    }
    try {
      await sql`DELETE FROM users WHERE id = ${userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Delete error:', err);
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── MODIFIER ─────────────────────────────────────────────────────────────────
  if (action === 'edit') {
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    try {
      if (password) {
        const passwordHash = await bcrypt.hash(password, 10);
        await sql`
          UPDATE users SET
            name      = COALESCE(${name || null}, name),
            email     = COALESCE(${email || null}, email),
            role      = COALESCE(${role || null}, role),
            pid       = ${pid || null},
            telephone = ${telephone || null},
            password_hash = ${passwordHash}
          WHERE id = ${userId}
        `;
      } else {
        await sql`
          UPDATE users SET
            name      = COALESCE(${name || null}, name),
            email     = COALESCE(${email || null}, email),
            role      = COALESCE(${role || null}, role),
            pid       = ${pid || null},
            telephone = ${telephone || null}
          WHERE id = ${userId}
        `;
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Edit error:', err);
      return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
    }
  }

  // ── CRÉER ─────────────────────────────────────────────────────────────────────
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  // ✏️ CHANGEMENT 3 : nouveaux rôles valides + restriction superadmin
  if (!['superadmin', 'admin', 'utilisateur'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }
  if (role === 'superadmin' && payload.role !== 'superadmin') {
    return res.status(403).json({ error: 'Seul un super admin peut créer un autre super admin' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO users (email, password_hash, role, name, approved)
      VALUES (${email}, ${passwordHash}, ${role}, ${name}, true)
    `;
    return res.status(201).json({ success: true });
  } catch (err) {
    if (err.message.includes('unique')) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
