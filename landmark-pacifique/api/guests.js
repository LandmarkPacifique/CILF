import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET;

function getUser(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = (auth.replace('Bearer ', '') || req.query?._token || '').trim();
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // S'assurer que la table existe avec toutes les colonnes nécessaires
  await sql`
    CREATE TABLE IF NOT EXISTS grad_guests (
      id             SERIAL PRIMARY KEY,
      type           VARCHAR(20)  DEFAULT 'guest',
      guest_name     TEXT,
      guest_email    TEXT,
      grad_name      TEXT,
      grad_email     TEXT,
      animateur      TEXT,
      titre          TEXT,
      date           TEXT,
      date_tah       TEXT,
      introduction_id TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Ajouter la colonne type si elle n'existe pas encore (migration douce)
  await sql`
    ALTER TABLE grad_guests ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'guest'
  `;

  // ── GET : récupérer les inscriptions ─────────────────────────────────────
  if (req.method === 'GET') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Non autorisé' });

    try {
      let rows;
      if (user.role === 'superadmin') {
        // Super admin : tout voir
        rows = await sql`SELECT * FROM grad_guests ORDER BY created_at DESC`;
      } else if (
        user.role === 'utilisateur' ||
        user.role === 'gradue' ||
        user.role === 'leader_intro'
      ) {
        // Gradué / leader : seulement ses propres inscriptions
        rows = await sql`
          SELECT * FROM grad_guests
          WHERE grad_email = ${user.email}
          ORDER BY created_at DESC
        `;
      } else {
        return res.status(403).json({ error: 'Accès refusé' });
      }

      return res.status(200).json(rows);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST : ajouter une inscription ───────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action } = body;

    if (action === 'add') {
      try {
        const {
          type,
          guest_name, guest_email,
          grad_name, grad_email,
          animateur, titre, date, date_tah,
          introduction_id, timestamp
        } = body;

        await sql`
          INSERT INTO grad_guests
            (type, guest_name, guest_email, grad_name, grad_email,
             animateur, titre, date, date_tah, introduction_id, created_at)
          VALUES
            (${type || 'guest'},
             ${guest_name || null}, ${guest_email || null},
             ${grad_name || null}, ${(grad_email || '').toLowerCase()},
             ${animateur || null}, ${titre || null},
             ${date || null}, ${date_tah || null},
             ${String(introduction_id || '')},
             ${timestamp ? new Date(timestamp) : new Date()})
        `;

        return res.status(200).json({ success: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Action inconnue' });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
