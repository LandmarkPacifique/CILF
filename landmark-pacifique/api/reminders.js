// /api/reminders.js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Sécurité
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== process.env.REMINDERS_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const nowUTC = Date.now();

    // Heure actuelle en TAH (UTC-10)
    const tahOffset = -10 * 60 * 60000;
    const tahNow  = new Date(nowUTC + tahOffset);
    const tahHour = tahNow.getUTCHours();
    const tahMin  = tahNow.getUTCMinutes();
    const todayTAH = tahNow.toISOString().slice(0, 10); // YYYY-MM-DD

    const matinResults    = [];
    const preIntroResults = [];

    // ── RAPPEL MATIN : 7h00 TAH ──────────────────────────────────────────────
    // Fenêtre : 6h50 → 7h10 TAH (couvre les 15min de polling Make)
    const isMatinWindow =
      (tahHour === 6 && tahMin >= 50) ||
      (tahHour === 7 && tahMin <= 10);

    if (isMatinWindow) {
      const rows = await sql`
        SELECT
          g.id          AS guest_id,
          g.email,
          g.nom,
          i.id          AS intro_id,
          i.titre,
          i.date,
          i.heure,
          i.heure_fin,
          i.animateur,
          i.animateur_email,
          i.zoom_intro,
          i.zoom_cc,
          i.cc_date,
          i.cc_heure,
          i.cc_heure_fin,
          i.slug
        FROM guests g
        JOIN introductions i ON i.id = g.introduction_id
        WHERE g.rappel_matin_envoye = false
          AND g.archived = false
          AND i.archived = false
          AND i.date = ${todayTAH}
      `;

      for (const r of rows) {
        matinResults.push({
          type:             'rappel_matin',
          guest_id:         r.guest_id,
          email:            r.email,
          nom:              r.nom,
          titre:            r.titre        || '',
          date:             r.date         ? r.date.toISOString().slice(0,10) : '',
          heure:            r.heure        || '',
          heure_fin:        r.heure_fin    || '',
          animateur:        r.animateur    || '',
          animateur_email:  r.animateur_email || '',
          zoom_intro:       r.zoom_intro   || '',
          zoom_cc:          r.zoom_cc      || '',
          cc_date:          r.cc_date      ? r.cc_date.toISOString().slice(0,10) : '',
          cc_heure:         r.cc_heure     || '',
          cc_heure_fin:     r.cc_heure_fin || '',
          slug:             r.slug         || ''
        });
      }
    }

    // ── RAPPEL 40 MIN AVANT ───────────────────────────────────────────────────
    const rows40 = await sql`
      SELECT
        g.id          AS guest_id,
        g.email,
        g.nom,
        i.id          AS intro_id,
        i.titre,
        i.date,
        i.heure,
        i.heure_fin,
        i.animateur,
        i.animateur_email,
        i.zoom_intro,
        i.zoom_cc,
        i.cc_date,
        i.cc_heure,
        i.cc_heure_fin,
        i.slug
      FROM guests g
      JOIN introductions i ON i.id = g.introduction_id
      WHERE g.rappel_40min_envoye = false
        AND g.archived = false
        AND i.archived = false
        AND i.date = ${todayTAH}
    `;

    for (const r of rows40) {
      if (!r.heure) continue;

      const dateStr = r.date ? r.date.toISOString().slice(0,10) : '';
      if (!dateStr) continue;

      // Convertir heure TAH → UTC (TAH = UTC-10, donc UTC = TAH + 10h)
      const [hh, mm] = r.heure.split(':').map(Number);
      const introUTC = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00Z`).getTime()
                       + 10 * 3600000;

      const diffMin = (introUTC - nowUTC) / 60000;

      // Fenêtre : 35 → 45 minutes avant l'intro
      if (diffMin < 35 || diffMin > 45) continue;

      preIntroResults.push({
        type:             'rappel_40min',
        guest_id:         r.guest_id,
        email:            r.email,
        nom:              r.nom,
        titre:            r.titre        || '',
        date:             dateStr,
        heure:            r.heure        || '',
        heure_fin:        r.heure_fin    || '',
        animateur:        r.animateur    || '',
        animateur_email:  r.animateur_email || '',
        zoom_intro:       r.zoom_intro   || '',
        zoom_cc:          r.zoom_cc      || '',
        cc_date:          r.cc_date      ? r.cc_date.toISOString().slice(0,10) : '',
        cc_heure:         r.cc_heure     || '',
        cc_heure_fin:     r.cc_heure_fin || '',
        slug:             r.slug         || ''
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
