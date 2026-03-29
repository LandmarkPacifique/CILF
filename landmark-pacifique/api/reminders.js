import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Clé secrète pour sécuriser l'endpoint (appelé par Make)
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== process.env.REMINDERS_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const now = new Date(); // UTC
    const nowUTC = now.getTime();

    // Heure actuelle en TAH (UTC-10)
    const tahOffset = -10 * 60; // minutes
    const tahNow = new Date(nowUTC + tahOffset * 60000);
    const tahHour = tahNow.getUTCHours();
    const tahMin = tahNow.getUTCMinutes();
    const todayTAH = tahNow.toISOString().slice(0, 10); // YYYY-MM-DD

    const matinResults = [];
    const preIntroResults = [];

    // ── RAPPEL MATIN : 7h00 TAH (fenêtre 6h50 → 7h10 TAH) ──────────────────
    const isMatinWindow = (tahHour === 6 && tahMin >= 50) || (tahHour === 7 && tahMin <= 10);

    if (isMatinWindow) {
      const guests = await sql`
        SELECT g.id, g.email, g.nom,
               i.date, i.heure, i.titre, i.animateur,
               i.zoom_intro, i.zoom_cc, i.cc_date, i.cc_heure
        FROM guests g
        JOIN introductions i ON g.introduction_id = i.id
        WHERE g.rappel_matin_envoye = false
          AND g.archived = false
          AND i.date = ${todayTAH}
      `;
      matinResults.push(...guests);
    }

    // ── RAPPEL 40 MIN AVANT : fenêtre intro_heure - 45min → intro_heure - 35min ──
    const guests40 = await sql`
      SELECT g.id, g.email, g.nom,
             i.date, i.heure, i.titre, i.animateur,
             i.zoom_intro, i.zoom_cc, i.cc_date, i.cc_heure
      FROM guests g
      JOIN introductions i ON g.introduction_id = i.id
      WHERE g.rappel_40min_envoye = false
        AND g.archived = false
        AND i.date = ${todayTAH}
    `;

    for (const guest of guests40) {
      if (!guest.heure) continue;

      // Construire datetime de l'intro en UTC (heure stockée en TAH)
      const [hh, mm] = guest.heure.split(':').map(Number);
      const introTAH = new Date(`${guest.date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
      // Convertir TAH → UTC : ajouter 10h
      const introUTC = new Date(introTAH.getTime() + 10 * 3600000);

      const diffMin = (introUTC.getTime() - nowUTC) / 60000;

      // Fenêtre : entre 35 et 45 minutes avant l'intro
      if (diffMin >= 35 && diffMin <= 45) {
        preIntroResults.push(guest);
      }
    }

    // Formater les données pour Make
    const formatGuest = (g, type) => ({
      type,
      guest_id: g.id,
      email: g.email,
      nom: g.nom,
      titre: g.titre,
      date: g.date,
      heure: g.heure,
      animateur: g.animateur,
      zoom_intro: g.zoom_intro || '',
      zoom_cc: g.zoom_cc || '',
      cc_date: g.cc_date || '',
      cc_heure: g.cc_heure || ''
    });

    const toSend = [
      ...matinResults.map(g => formatGuest(g, 'rappel_matin')),
      ...preIntroResults.map(g => formatGuest(g, 'rappel_40min'))
    ];

    return res.status(200).json({
      count: toSend.length,
      guests: toSend
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}