const { neon } = require('@neondatabase/serverless');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const rows = await sql`SELECT key, value FROM config`;
      return res.status(200).json(Object.fromEntries(rows.map(r => [r.key, r.value])));
    }

    if (req.method === 'POST') {
      const token = req.headers['x-admin-token'];
      if (!token || token !== process.env.ADMIN_TOKEN)
        return res.status(401).json({ error: 'Non autorisé' });

      const cfg = req.body;
      for (const [key, value] of Object.entries(cfg)) {
        await sql`
          INSERT INTO config (key, value) VALUES (${key}, ${String(value)})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `;
      }
      return res.status(200).json({ status: 'ok' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
