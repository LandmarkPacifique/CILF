const { neon } = require('@neondatabase/serverless');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const slug = req.query.slug || 'cilf';
      const rows = await sql`
        SELECT id, animateur, titre, date, heure, heure_fin,
               zoom, zoom_id, animateur_email
        FROM introductions WHERE slug = ${slug} ORDER BY id ASC
      `;
      return res.status(200).json(rows.map(r => ({
        id: r.id,
        animateur: r.animateur,
        titre: r.titre,
        date: r.date,
        heure: r.heure,
        heureFin: r.heure_fin,
        zoom: r.zoom,
        zoomId: r.zoom_id,
        animateurEmail: r.animateur_email,
      })));
    }

    if (req.method === 'POST') {
      const token = req.headers['x-admin-token'];
      if (!token || token !== process.env.ADMIN_TOKEN)
        return res.status(401).json({ error: 'Non autorisé' });

      const { slug = 'cilf', intros } = req.body;
      if (!Array.isArray(intros))
        return res.status(400).json({ error: 'intros doit être un tableau' });

      await sql`DELETE FROM introductions WHERE slug = ${slug}`;
      for (const intro of intros) {
        await sql`
          INSERT INTO introductions
            (slug, animateur, titre, date, heure, heure_fin, zoom, zoom_id, animateur_email)
          VALUES
            (${slug}, ${intro.animateur||''}, ${intro.titre||''}, ${intro.date||''},
             ${intro.heure||''}, ${intro.heureFin||''}, ${intro.zoom||''},
             ${intro.zoomId||''}, ${intro.animateurEmail||''})
        `;
      }
      return res.status(200).json({ status: 'ok', count: intros.length });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
