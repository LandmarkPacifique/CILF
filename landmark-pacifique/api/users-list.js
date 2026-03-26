// api/users-list.js
const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const auth = req.headers['authorization'] || '';
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = rawToken || req.headers['x-admin-token'] || null;

  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  try {
    // Détecte les colonnes disponibles pour éviter les erreurs si une colonne manque
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users'
    `;
    const colNames = cols.map(c => c.column_name);

    const select = [
      'id', 'name', 'email',
      colNames.includes('pid')        ? 'pid'        : 'NULL AS pid',
      colNames.includes('telephone')  ? 'telephone'  : 'NULL AS telephone',
      colNames.includes('status')     ? 'status'     : 'NULL AS status',
      colNames.includes('role')       ? 'role'       : "'gradue' AS role",
      colNames.includes('approved')   ? 'approved'   : 'NULL AS approved',
      colNames.includes('validated')  ? 'validated'  : 'NULL AS validated',
    ].join(', ');

    const users = await sql.unsafe(`SELECT ${select} FROM users ORDER BY name ASC`);
    return res.status(200).json(users);
  } catch (err) {
    console.error('Users list error:', err);
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
};
