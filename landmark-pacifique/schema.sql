-- ============================================================
-- Schema Neon PostgreSQL — Landmark Pacifique
-- À exécuter une seule fois dans la console Neon
-- ============================================================

CREATE TABLE IF NOT EXISTS introductions (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL DEFAULT 'cilf',   -- 'cilf' ou 'pilf'
  animateur   TEXT NOT NULL DEFAULT '',
  titre       TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',        -- format YYYY-MM-DD
  heure       TEXT NOT NULL DEFAULT '',        -- format HH:MM
  heure_fin   TEXT NOT NULL DEFAULT '',
  zoom        TEXT NOT NULL DEFAULT '',
  zoom_id     TEXT NOT NULL DEFAULT '',
  animateur_email TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour filtrer par type (cilf / pilf)
CREATE INDEX IF NOT EXISTS idx_introductions_slug ON introductions(slug);

-- Trigger pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_introductions_updated_at
  BEFORE UPDATE ON introductions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_updated_at
  BEFORE UPDATE ON config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
