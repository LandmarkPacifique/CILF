// api/login.js
// Variables d'environnement Vercel à configurer :
//   DATABASE_URL  → ta connection string Neon
//   JWT_SECRET    → une chaîne aléatoire longue (ex: openssl rand -base64 32)

import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    // Vérifie email + mot de passe avec pgcrypto
    const result = await sql`
      SELECT id, role, name
      FROM users
      WHERE email = ${email}
        AND password_hash = crypt(${password}, password_hash)
    `;

    if (result.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = result[0];

    // Génère un JWT valable 7 jours
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({ token, role: user.role, name: user.name });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
