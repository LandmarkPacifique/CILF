// api/users.js
// Crée un nouvel utilisateur — réservé aux admins uniquement
// Variables d'environnement Vercel :
//   DATABASE_URL  → connection string Neon
//   JWT_SECRET    → même clé que dans login.js

import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // Vérifie le JWT et le rôle admin
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  if (payload.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }

  const { name, email, password, role } = req.body || {};

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  if (!['admin', 'leader'].includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide' });
  }

  try {
    await sql`
      INSERT INTO users (email, password_hash, role, name)
      VALUES (
        ${email},
        crypt(${password}, gen_salt('bf')),
        ${role},
        ${name}
      )
    `;
    return res.status(201).json({ success: true });
  } catch (err) {
    if (err.message.includes('unique')) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
