import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== process.env.REMINDERS_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const { guest_id, type } = req.body || {};
  if (!guest_id || !type) return res.status(400).json({ error: 'guest_id et type requis' });

  try {
    if (type === 'rappel_matin') {
      await sql`UPDATE guests SET rappel_matin_envoye = true WHERE id = ${guest_id}`;
    } else if (type === 'rappel_40min') {
      await sql`UPDATE guests SET rappel_40min_envoye = true WHERE id = ${guest_id}`;
    } else {
      return res.status(400).json({ error: 'type invalide' });
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
```

---

## 3. Scénario Make — configuration
```
[Schedule: toutes les 15min]
        ↓
[HTTP GET https://landmark-pacifique.fr/api/reminders
  Header: x-secret: TON_SECRET
]
        ↓
[Tools > Array iterator] ← itère sur guests[]
        ↓
[Router]
  ├── filtre: type = rappel_matin
  │     ↓
  │   [HTTP POST Brevo templateId MATIN]
  │     ↓
  │   [HTTP POST /api/reminders-mark {guest_id, type:"rappel_matin"}]
  │
  └── filtre: type = rappel_40min
        ↓
      [HTTP POST Brevo templateId 40MIN]
        ↓
      [HTTP POST /api/reminders-mark {guest_id, type:"rappel_40min"}]