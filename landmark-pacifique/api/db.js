const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// WebSocket requis par Neon Pool en environnement Node.js
neonConfig.webSocketConstructor = ws;

/* ─── POOL DE CONNEXIONS (équivalent HikariCP) ───
   max                     = maximumPoolSize
   idleTimeoutMillis       = idleTimeout
   connectionTimeoutMillis = connectionTimeout
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT_MS || '10000', 10),
});

pool.on('error', (err) => {
  console.error('❌ Erreur pool PG:', err.message);
});

// Fermeture propre du pool (SIGTERM / SIGINT)
const shutdownPool = async () => {
  try { await pool.end(); console.log('🛑 Pool PG fermé proprement.'); } catch {}
  process.exit(0);
};
process.on('SIGTERM', shutdownPool);
process.on('SIGINT',  shutdownPool);

/* ─── WRAPPER `sql` tagged template (API identique à neon()) ───
   Permet à index.js de continuer à utiliser : sql`SELECT ... WHERE x = ${val}`
*/
async function sql(strings, ...values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += '$' + (i + 1) + strings[i + 1];
  }
  const result = await pool.query(text, values);
  return result.rows;
}

async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'utilisateur',
      fonction TEXT NOT NULL DEFAULT 'invité',
      programs JSONB NOT NULL DEFAULT '[]',
      permissions JSONB NOT NULL DEFAULT '{}',
      phone TEXT,
      location TEXT,
      pid TEXT,
      graduate_pid TEXT,
      graduate_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS graduate_pid TEXT`.catch(() => {});
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS graduate_email TEXT`.catch(() => {});
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS fonction TEXT DEFAULT 'invité'`.catch(() => {});
  await sql`UPDATE users SET fonction = 'leader',   role = 'utilisateur' WHERE role = 'leader'`.catch(() => {});
  await sql`UPDATE users SET fonction = 'gradué',   role = 'utilisateur' WHERE role = 'gradué'`.catch(() => {});
  await sql`UPDATE users SET fonction = 'staff',    role = 'utilisateur' WHERE role = 'staff'`.catch(() => {});
  await sql`UPDATE users SET fonction = 'invité',   role = 'utilisateur' WHERE role IN ('member','invité')`.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      section TEXT NOT NULL,
      author TEXT NOT NULL,
      author_email TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      tag TEXT,
      date TEXT NOT NULL,
      reactions JSONB NOT NULL DEFAULT '{}',
      comments JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS intros (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'forum',
      titre TEXT NOT NULL,
      theme TEXT,
      date TEXT NOT NULL,
      heure TEXT,
      heure_fin TEXT,
      format TEXT,
      location TEXT,
      zoom_url TEXT,
      animateur TEXT,
      animateur_email TEXT,
      rc_name TEXT,
      opm_name TEXT,
      cc_date TEXT,
      cc_heure TEXT,
      zoom_cc TEXT,
      capacite INTEGER,
      media_url TEXT,
      target_program TEXT,
      registrations JSONB NOT NULL DEFAULT '[]',
      archived BOOLEAN NOT NULL DEFAULT false,
      archived_at TIMESTAMPTZ,
      archived_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
  await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS archived_by TEXT`.catch(() => {});
  await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS media_url TEXT`.catch(() => {});
  await sql`ALTER TABLE intros ADD COLUMN IF NOT EXISTS target_program TEXT`.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS intro_types (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT DEFAULT '#6B7A90',
      is_default BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 99
    )
  `;
  await sql`INSERT INTO intro_types (key, label, color, is_default, sort_order) VALUES
    ('forum',   'Introduction au Forum', '#00C6D7', true, 1),
    ('special', 'Événement spécial',     '#E8B86A', true, 2)
    ON CONFLICT (key) DO NOTHING`.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS testimonials (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      role TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS programs (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      icon TEXT,
      "desc" TEXT,
      prereq JSONB NOT NULL DEFAULT '[]',
      prereq_mode TEXT DEFAULT 'AND',
      badge TEXT,
      is_seminar BOOLEAN DEFAULT FALSE,
      sort_order INTEGER DEFAULT 99
    )
  `;
  await sql`ALTER TABLE programs ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 99`.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      expires BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE reset_tokens ADD COLUMN IF NOT EXISTS email TEXT;`.catch(() => {});
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reset_tokens_email_key') THEN
        ALTER TABLE reset_tokens ADD CONSTRAINT reset_tokens_email_key UNIQUE (email);
      END IF;
    END $$;
  `.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_email ON notifications(recipient_email)`;

  await sql`
    CREATE TABLE IF NOT EXISTS invitation_tokens (
      token TEXT PRIMARY KEY,
      intro_id TEXT NOT NULL,
      guest_firstname TEXT NOT NULL,
      guest_lastname TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      guest_phone TEXT NOT NULL,
      graduate_name TEXT NOT NULL,
      graduate_email TEXT NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE invitation_tokens ADD COLUMN IF NOT EXISTS message_id TEXT`.catch(() => {});
  await sql`ALTER TABLE invitation_tokens ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'sent'`.catch(() => {});
  await sql`ALTER TABLE invitation_tokens ADD COLUMN IF NOT EXISTS email_status_at BIGINT`.catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_invitation_tokens_message_id ON invitation_tokens(message_id)`.catch(() => {});

  /* ─── CALENDRIER UNIFIÉ : nouvelles tables (Option B) ─── */
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      seminar_name TEXT,
      titre TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      heure TEXT,
      heure_fin TEXT,
      format TEXT DEFAULT 'presentiel',
      location TEXT,
      zoom_url TEXT,
      capacite INTEGER,
      media_url TEXT,
      target_program TEXT,
      created_by TEXT,
      archived BOOLEAN NOT NULL DEFAULT false,
      archived_at TIMESTAMPTZ,
      archived_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`;

  await sql`
    CREATE TABLE IF NOT EXISTS creation_calls (
      id TEXT PRIMARY KEY,
      intro_id TEXT,
      titre TEXT NOT NULL,
      date TEXT NOT NULL,
      heure TEXT,
      heure_fin TEXT,
      format TEXT DEFAULT 'zoom',
      location TEXT,
      zoom_url TEXT,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cc_intro ON creation_calls(intro_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_cc_date  ON creation_calls(date)`;

  await sql`
    CREATE TABLE IF NOT EXISTS clinic_calls (
      id TEXT PRIMARY KEY,
      theme TEXT NOT NULL,
      titre TEXT,
      description TEXT,
      date TEXT NOT NULL,
      heure TEXT,
      heure_fin TEXT,
      format TEXT DEFAULT 'zoom',
      location TEXT,
      zoom_url TEXT,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_clinic_date ON clinic_calls(date)`;

  // Rôles assignés (polymorphe : intro | event | creation_call | clinic_call)
  await sql`
    CREATE TABLE IF NOT EXISTS event_roles (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_id TEXT NOT NULL,
      role TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(event_type, event_id, role, user_email)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_roles_target ON event_roles(event_type, event_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_roles_user   ON event_roles(user_email)`;

  // Inscriptions pour creation_calls / clinic_calls / events (intros gardent leur JSONB)
  await sql`
    CREATE TABLE IF NOT EXISTS event_registrations (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT,
      source TEXT DEFAULT 'manual',
      parent_intro_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(event_type, event_id, user_email)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_regs_target ON event_registrations(event_type, event_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_regs_user   ON event_registrations(user_email)`;

  // API Keys pour les sites externes
  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      permissions JSONB NOT NULL DEFAULT '{"read_intros": true, "create_intros": false, "update_intros": false, "delete_intros": false, "register_intros": false}',
      active BOOLEAN NOT NULL DEFAULT true,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`;

  // Logs d'audit pour les opérations API keys
  await sql`
    CREATE TABLE IF NOT EXISTS api_key_audit_logs (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
      api_key_name TEXT NOT NULL,
      action TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      request_body JSONB,
      response_status INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_key_id ON api_key_audit_logs(api_key_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON api_key_audit_logs(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON api_key_audit_logs(action)`;

  // Seed minimal : 1 superadmin + programmes par défaut (uniquement si DB vide)
  const usersCount = await sql`SELECT COUNT(*) FROM users`;
  if (parseInt(usersCount[0].count) === 0) {
    const bcrypt = require('bcryptjs');
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@landmark-pacifique.fr';
    const adminPass  = process.env.ADMIN_PASSWORD || 'changeme';
    const adminName  = process.env.ADMIN_NAME || 'Administrateur';
    const hash = bcrypt.hashSync(adminPass, 10);

    await sql`INSERT INTO users (email, password, name, role, fonction, programs, permissions) VALUES
      (${adminEmail}, ${hash}, ${adminName}, 'superadmin', 'leader',
       '["Forum","Cours Avancé","ATP","PTC","TMLP"]',
       '{"canOPM":true,"canAddIntro":true,"canEditIntro":true,"canDeleteIntro":true,"canManageMembers":true,"canManagePrograms":true,"canManageTestimonials":true,"canManageFeed":true}')
    `;

    await sql`INSERT INTO programs (key, label, icon, "desc", prereq, prereq_mode, badge, is_seminar) VALUES
      ('Forum',                   'Le Forum',              '🌅', 'Programme d''introduction',       '[]',                                                                         'AND', 'Forum', false),
      ('Cours Avancé',            'Cours Avancé',          '🧭', 'Approfondissement',               '["Forum"]',                                                                  'AND', 'CA',    false),
      ('Séminaire-Communication', 'Séminaire Communication','💬', 'Sous-groupe séminaire',           '["Forum"]',                                                                  'AND', 'Sem',   true),
      ('Séminaire-Leadership',    'Séminaire Leadership',  '⚡', 'Sous-groupe séminaire',           '["Forum"]',                                                                  'AND', 'Sem',   true),
      ('Séminaire-Création',      'Séminaire Création',    '🎨', 'Sous-groupe séminaire',           '["Forum"]',                                                                  'AND', 'Sem',   true),
      ('ILP',                     'ILP',                   '🌊', 'Introduction Leaders Program',    '["Cours Avancé","Séminaire-Communication","Séminaire-Leadership","Séminaire-Création"]', 'OR', 'ILP', false),
      ('ATP',                     'Access To Power',       '🔥', 'Access To Power',                 '["Cours Avancé"]',                                                           'AND', 'ATP',   false),
      ('PTC',                     'Power To Create',       '✨', 'Power To Create',                 '["ATP"]',                                                                    'AND', 'PTC',   false),
      ('TMLP',                    'TMLP',                  '👑', 'Team Management Leadership Program','["PTC"]',                                                                   'AND', 'TMLP',  false)
    `;

    console.log('✅ Seed initial créé. Connexion admin :', adminEmail, '/', adminPass);
  }
}

module.exports = { sql, pool, initDB };
