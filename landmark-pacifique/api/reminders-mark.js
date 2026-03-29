// /api/reminders-mark.js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Sécurité : vérifier le secret (header ou body)
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== process.env.REMINDERS_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const { guest_id, type } = req.body || {};

  if (!guest_id) return res.status(400).json({ error: 'guest_id requis' });
  if (!type)     return res.status(400).json({ error: 'type requis (rappel_matin ou rappel_40min)' });

  try {
    if (type === 'rappel_matin') {
      await sql`
        UPDATE guests
        SET rappel_matin_envoye = true
        WHERE id = ${guest_id}
      `;
    } else if (type === 'rappel_40min') {
      await sql`
        UPDATE guests
        SET rappel_40min_envoye = true
        WHERE id = ${guest_id}
      `;
    } else {
      return res.status(400).json({ error: 'type invalide — utiliser rappel_matin ou rappel_40min' });
    }

    return res.status(200).json({ success: true, guest_id, type });

  } catch (e) {
    console.error('[reminders-mark]', e);
    return res.status(500).json({ error: e.message });
  }
}
