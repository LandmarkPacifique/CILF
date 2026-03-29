// /api/reminders.js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Sécurité : vérifier le secret
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== process.env.REMINDERS_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const nowUTC = Date.now();

    // Heure actuelle en TAH (UTC-10)
    const tahOffset = -10 * 60 * 60000; // -10h en ms
    const tahNow = new Date(nowUTC + tahOffset);
    const tahHour = tahNow.getUTCHours();
    const tahMin  = tahNow.getUTCMinutes();
    const todayTAH = tahNow.toISOString().slice(0, 10); // YYYY-MM-DD

    const matinResults  = [];
    const preIntroResults = [];

    // ── RAPPEL MATIN : 7h00 TAH ──────────────────────────────────────────────
    // Fenêtre large : 6h50 → 7h10 TAH (pour couvrir les 15min de Make)
    const isMatinWindow =
      (tahHour === 6 && tahMin >= 50) ||
      (tahHour === 7 && tahMin <= 10);

    if (isMatinWindow) {
      const rows = await sql`
        SELECT
          g.id        AS guest_id,
          g.email,
          g.nom,
          i.data      AS intro_data,
          i.slug
        FROM guests g
        JOIN intros i ON CAST(g.introduction_id AS TEXT) = CAST(i.id AS TEXT)
        WHERE g.rappel_matin_envoye = false
          AND g.archived = false
      `;

      for (const row of rows) {
        // Les intros sont stockées en JSON dans la colonne data
        let intros = [];
        try { intros = typeof row.intro_data === 'string' ? JSON.parse(row.intro_data) : row.intro_data; }
        catch { continue; }

        const intro = Array.isArray(intros)
          ? intros.find(i => String(i.id) === String(row.guest_id)) || intros[0]
          : intros;

        if (!intro || intro.date !== todayTAH) continue;

        matinResults.push({
          type:       'rappel_matin',
          guest_id:   row.guest_id,
          email:      row.email,
          nom:        row.nom,
          titre:      intro.titre       || '',
          date:       intro.date        || '',
          heure:      intro.heure       || '',
          animateur:  intro.animateur   || '',
          zoom_intro: intro.zoomIntro   || '',
          zoom_cc:    intro.zoomCC      || '',
          cc_date:    intro.ccDate      || '',
          cc_heure:   intro.ccHeure     || '',
          slug:       row.slug          || ''
        });
      }
    }

    // ── RAPPEL 40 MIN AVANT ───────────────────────────────────────────────────
    // On récupère tous les guests non encore notifiés avec intro aujourd'hui
    const rows40 = await sql`
      SELECT
        g.id        AS guest_id,
        g.email,
        g.nom,
        i.data      AS intro_data,
        i.slug
      FROM guests g
      JOIN intros i ON CAST(g.introduction_id AS TEXT) = CAST(i.id AS TEXT)
      WHERE g.rappel_40min_envoye = false
        AND g.archived = false
    `;

    for (const row of rows40) {
      let intros = [];
      try { intros = typeof row.intro_data === 'string' ? JSON.parse(row.intro_data) : row.intro_data; }
      catch { continue; }

      const intro = Array.isArray(intros)
        ? intros.find(i => String(i.id) === String(row.guest_id)) || intros[0]
        : intros;

      if (!intro || !intro.date || !intro.heure) continue;
      if (intro.date !== todayTAH) continue;

      // Convertir heure TAH → UTC pour comparer avec nowUTC
      const [hh, mm] = intro.heure.split(':').map(Number);
      // intro.heure est en TAH → UTC = TAH + 10h
      const introUTC = new Date(`${intro.date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00Z`).getTime()
                       + 10 * 3600000;

      const diffMin = (introUTC - nowUTC) / 60000;

      // Fenêtre : 35 → 45 minutes avant l'intro
      if (diffMin < 35 || diffMin > 45) continue;

      preIntroResults.push({
        type:       'rappel_40min',
        guest_id:   row.guest_id,
        email:      row.email,
        nom:        row.nom,
        titre:      intro.titre       || '',
        date:       intro.date        || '',
        heure:      intro.heure       || '',
        animateur:  intro.animateur   || '',
        zoom_intro: intro.zoomIntro   || '',
        zoom_cc:    intro.zoomCC      || '',
        cc_date:    intro.ccDate      || '',
        cc_heure:   intro.ccHeure     || '',
        slug:       row.slug          || ''
      });
    }

    const toSend = [...matinResults, ...preIntroResults];

    return res.status(200).json({
      count:  toSend.length,
      guests: toSend
    });

  } catch (e) {
    console.error('[reminders]', e);
    return res.status(500).json({ error: e.message });
  }
}
