// /api/guests.js
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const sql = neon(process.env.DATABASE_URL);
const JWT_SECRET = process.env.JWT_SECRET;

function getUser(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // S'assurer que la table existe
  await sql`
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      guest_name TEXT,
      guest_email TEXT,
      grad_name TEXT,
      grad_email TEXT,
      animateur TEXT,
      titre TEXT,
      date TEXT,
      date_tah TEXT,
      introduction_id TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── GET : récupérer tous les invités ──────────────────────────────────────
  if (req.method === 'GET') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Non autorisé' });

    try {
      let rows;
      // Un gradué ne voit que ses propres invités
      if (user.role === 'utilisateur') {
        rows = await sql`
          SELECT * FROM guests WHERE grad_email = ${user.email}
          ORDER BY timestamp DESC
        `;
      } else {
        // admin/superadmin voient tout
        rows = await sql`SELECT * FROM guests ORDER BY timestamp DESC`;
      }
      return res.status(200).json(rows);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST : ajouter un invité ───────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action } = body;

    if (action === 'add') {
      try {
        const { guest_name, guest_email, grad_name, grad_email,
                animateur, titre, date, date_tah, introduction_id, timestamp } = body;

        await sql`
          INSERT INTO guests
            (guest_name, guest_email, grad_name, grad_email, animateur, titre, date, date_tah, introduction_id, timestamp)
          VALUES
            (${guest_name||null}, ${guest_email||null}, ${grad_name||null}, ${grad_email||null},
             ${animateur||null}, ${titre||null}, ${date||null}, ${date_tah||null},
             ${introduction_id||null}, ${timestamp ? new Date(timestamp) : new Date()})
        `;
        return res.status(200).json({ success: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Action inconnue
    return res.status(400).json({ error: 'Action inconnue' });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}