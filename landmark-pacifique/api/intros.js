const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10);
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
      const rows = await sql`
        SELECT id, animateur, titre, date, heure, heure_fin,
               animateur_email, cc_date, cc_heure, cc_heure_fin,
               zoom_intro, zoom_cc,
               modified_by, modified_by_id, modified_at
        FROM introductions WHERE slug = ${slug} ORDER BY id ASC
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
      // Accepte Authorization: Bearer <jwt> OU x-admin-token: <jwt> OU ?_token=
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

      // ✅ FIX : superadmin ajouté à la liste des rôles autorisés
      if (!ALLOWED_ROLES.includes(payload.role)) {
        return res.status(403).json({ error: `Accès non autorisé (rôle: ${payload.role})` });
      }

      const {
        slug = 'cilf',
        intros,
        modified_by    = null,
        modified_by_id = null,
        modified_at    = null,
      } = req.body;

      if (!Array.isArray(intros))
        return res.status(400).json({ error: 'intros doit être un tableau' });

      await sql`DELETE FROM introductions WHERE slug = ${slug}`;

      for (const intro of intros) {
        await sql`
          INSERT INTO introductions
            (slug, animateur, titre, date, heure, heure_fin,
             animateur_email, cc_date, cc_heure, cc_heure_fin,
             zoom_intro, zoom_cc,
             modified_by, modified_by_id, modified_at)
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
             ${orNull(modified_at)})
        `;
      }

      return res.status(200).json({ status: 'ok', count: intros.length });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (err) {
    console.error('[intros.js]', err);
    return res.status(500).json({ error: err.message });
  }
};
