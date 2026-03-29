const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

function orNull(v) {
  return (v && v.toString().trim() !== '') ? v : null;
}

const ALLOWED_ROLES = ['admin', 'leader', 'superadmin'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ────────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const slug = req.query.slug || 'cilf';

      // ?archived=true → retourne les intros archivées avec leurs guests
      if (req.query.archived === 'true') {
        const rows = await sql`
          SELECT i.id, i.animateur, i.titre, i.date, i.heure, i.heure_fin,
                 i.animateur_email, i.cc_date, i.cc_heure, i.cc_heure_fin,
                 i.zoom_intro, i.zoom_cc, i.archived_at,
                 i.modified_by, i.modified_by_id, i.modified_at
          FROM introductions i
          WHERE i.slug = ${slug} AND i.archived = true
          ORDER BY i.archived_at DESC
        `;
        const result = [];
        for (const r of rows) {
          const guests = await sql`
            SELECT id, first_name, last_name, email, telephone
            FROM guests WHERE introduction_id = ${r.id}
          `;
          result.push({
            id:             r.id,
            animateur:      r.animateur,
            titre:          r.titre,
            date:           fmtDate(r.date),
            heure:          r.heure,
            heureFin:       r.heure_fin,
            animateurEmail: r.animateur_email,
            ccDate:         fmtDate(r.cc_date),
            ccHeure:        r.cc_heure,
            ccHeureFin:     r.cc_heure_fin,
            zoomIntro:      r.zoom_intro  || null,
            zoomCC:         r.zoom_cc     || null,
            archivedAt:     r.archived_at || null,
            modified_by:    r.modified_by || null,
            guests:         guests.map(g => ({
              id:        g.id,
              prenom:    g.first_name,
              nom:       g.last_name,
              email:     g.email,
              telephone: g.telephone,
            })),
          });
        }
        return res.status(200).json(result);
      }

      // GET normal → intros actives uniquement
      const rows = await sql`
        SELECT id, animateur, titre, date, heure, heure_fin,
               animateur_email, cc_date, cc_heure, cc_heure_fin,
               zoom_intro, zoom_cc,
               modified_by, modified_by_id, modified_at
        FROM introductions
        WHERE slug = ${slug} AND archived = false
        ORDER BY id ASC
      `;
      return res.status(200).json(rows.map(r => ({
        id:             r.id,
        animateur:      r.animateur,
        titre:          r.titre,
        date:           fmtDate(r.date),
        heure:          r.heure,
        heureFin:       r.heure_fin,
        animateurEmail: r.animateur_email,
        ccDate:         fmtDate(r.cc_date),
        ccHeure:        r.cc_heure,
        ccHeureFin:     r.cc_heure_fin,
        zoomIntro:      r.zoom_intro     || null,
        zoomCC:         r.zoom_cc        || null,
        modified_by:    r.modified_by    || null,
        modified_by_id: r.modified_by_id || null,
        modified_at:    r.modified_at    || null,
      })));
    }

    // ── POST ───────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const token = rawToken
        || req.headers['x-admin-token']
        || req.query._token
        || null;

      if (!token) return res.status(401).json({ error: 'Non autorisé' });

      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Token invalide ou expiré' });
      }

      if (!ALLOWED_ROLES.includes(payload.role)) {
        return res.status(403).json({ error: `Accès non autorisé (rôle: ${payload.role})` });
      }

      const {
        slug = 'cilf',
        intros,
        modified_by    = null,
        modified_by_id = null,
        modified_at    = null,
        action,        // 'archive' | 'restore' | 'delete_permanent'
        intro_id,      // pour archive / restore / delete_permanent
      } = req.body;

      // ── ACTION : ARCHIVER une intro (avec ses guests) ──────────────────────
      if (action === 'archive' && intro_id) {
        await sql`
          UPDATE introductions
          SET archived = true, archived_at = NOW()
          WHERE id = ${intro_id} AND slug = ${slug}
        `;
        await sql`
          UPDATE guests SET archived = true
          WHERE introduction_id = ${intro_id}
        `;
        return res.status(200).json({ status: 'archived' });
      }

      // ── ACTION : RESTAURER une intro (avec ses guests) ────────────────────
      if (action === 'restore' && intro_id) {
        await sql`
          UPDATE introductions
          SET archived = false, archived_at = NULL
          WHERE id = ${intro_id} AND slug = ${slug}
        `;
        await sql`
          UPDATE guests SET archived = false
          WHERE introduction_id = ${intro_id}
        `;
        return res.status(200).json({ status: 'restored' });
      }

      // ── ACTION : SUPPRIMER DÉFINITIVEMENT une intro ───────────────────────
      if (action === 'delete_permanent' && intro_id) {
        await sql`DELETE FROM guests WHERE introduction_id = ${intro_id}`;
        await sql`DELETE FROM introductions WHERE id = ${intro_id} AND slug = ${slug}`;
        return res.status(200).json({ status: 'deleted' });
      }

      // ── SAUVEGARDE NORMALE (upsert) ────────────────────────────────────────
      if (!Array.isArray(intros))
        return res.status(400).json({ error: 'intros doit être un tableau' });

      // IDs envoyés par le frontend (intros actives après modif)
      const incomingIds = intros.filter(i => i.id).map(i => i.id);

      // Intros actives actuellement en BDD pour ce slug
      const existing = await sql`
        SELECT id FROM introductions WHERE slug = ${slug} AND archived = false
      `;
      const existingIds = existing.map(r => r.id);

      // IDs à archiver = ceux qui étaient actifs mais ne sont plus dans le tableau envoyé
      const toArchive = existingIds.filter(id => !incomingIds.includes(id));

      // Archiver les intros supprimées (avec leurs guests)
      for (const id of toArchive) {
        await sql`
          UPDATE introductions
          SET archived = true, archived_at = NOW()
          WHERE id = ${id}
        `;
        await sql`
          UPDATE guests SET archived = true
          WHERE introduction_id = ${id}
        `;
      }

      // Upsert chaque intro du tableau
      for (const intro of intros) {
        if (intro.id) {
          // Mise à jour d'une intro existante
          await sql`
            UPDATE introductions SET
              animateur       = ${intro.animateur      || ''},
              titre           = ${intro.titre          || ''},
              date            = ${orNull(intro.date)},
              heure           = ${orNull(intro.heure)},
              heure_fin       = ${orNull(intro.heureFin)},
              animateur_email = ${intro.animateurEmail || ''},
              cc_date         = ${orNull(intro.ccDate)},
              cc_heure        = ${orNull(intro.ccHeure)},
              cc_heure_fin    = ${orNull(intro.ccHeureFin)},
              zoom_intro      = ${orNull(intro.zoomIntro)},
              zoom_cc         = ${orNull(intro.zoomCC)},
              modified_by     = ${modified_by},
              modified_by_id  = ${modified_by_id},
              modified_at     = ${orNull(modified_at)},
              archived        = false
            WHERE id = ${intro.id} AND slug = ${slug}
          `;
        } else {
          // Nouvelle intro
          await sql`
            INSERT INTO introductions
              (slug, animateur, titre, date, heure, heure_fin,
               animateur_email, cc_date, cc_heure, cc_heure_fin,
               zoom_intro, zoom_cc,
               modified_by, modified_by_id, modified_at, archived)
            VALUES
              (${slug},
               ${intro.animateur      || ''},
               ${intro.titre          || ''},
               ${orNull(intro.date)},
               ${orNull(intro.heure)},
               ${orNull(intro.heureFin)},
               ${intro.animateurEmail || ''},
               ${orNull(intro.ccDate)},
               ${orNull(intro.ccHeure)},
               ${orNull(intro.ccHeureFin)},
               ${orNull(intro.zoomIntro)},
               ${orNull(intro.zoomCC)},
               ${modified_by},
               ${modified_by_id},
               ${orNull(modified_at)},
               false)
          `;
        }
      }

      return res.status(200).json({ status: 'ok', count: intros.length });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (err) {
    console.error('[intros.js]', err);
    return res.status(500).json({ error: err.message });
  }
};
