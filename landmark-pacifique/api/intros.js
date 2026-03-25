// api/intros.js
// Route Vercel : GET /api/intros?slug=cilf  →  liste des intros
//               POST /api/intros            →  sauvegarde complète (remplace toutes les intros du slug)

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  // CORS – autorise ton domaine Vercel (et localhost en dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET ────────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const slug = req.query.slug || 'cilf';
      const rows = await sql`
        SELECT id, slug, animateur, titre, date, heure, heure_fin,
               zoom, zoom_id, animateur_email
        FROM   introductions
        WHERE  slug = ${slug}
        ORDER  BY id ASC
      `;

      // Reformatte pour correspondre à la structure JS existante du front
      const intros = rows.map(r => ({
        id:             r.id,
        animateur:      r.animateur,
        titre:          r.titre,
        date:           r.date,
        heure:          r.heure,
        heureFin:       r.heure_fin,
        zoom:           r.zoom,
        zoomId:         r.zoom_id,
        animateurEmail: r.animateur_email,
      }));

      return res.status(200).json(intros);
    }

    // ── POST ───────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      // Vérification du token admin
      const token = req.headers['x-admin-token'];
      if (!token || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Non autorisé' });
      }

      const { slug = 'cilf', intros } = req.body;

      if (!Array.isArray(intros)) {
        return res.status(400).json({ error: 'intros doit être un tableau' });
      }

      // Transaction : supprime les anciennes, insère les nouvelles
      await sql`DELETE FROM introductions WHERE slug = ${slug}`;

      if (intros.length > 0) {
        // Insertion en masse
        for (const intro of intros) {
          await sql`
            INSERT INTO introductions
              (slug, animateur, titre, date, heure, heure_fin, zoom, zoom_id, animateur_email)
            VALUES
              (${slug},
               ${intro.animateur  || ''},
               ${intro.titre      || ''},
               ${intro.date       || ''},
               ${intro.heure      || ''},
               ${intro.heureFin   || ''},
               ${intro.zoom       || ''},
               ${intro.zoomId     || ''},
               ${intro.animateurEmail || ''})
          `;
        }
      }

      return res.status(200).json({ status: 'ok', count: intros.length });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (err) {
    console.error('/api/intros error:', err);
    return res.status(500).json({ error: err.message });
  }
}
