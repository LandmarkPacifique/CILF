# 🚀 Guide de déploiement — LWS

## Prérequis

- Accès au panneau LWS
- Le serveur doit supporter **Node.js** (VPS LWS ou offre avec Node.js)
- Le projet utilise : Express + WebSocket + PostgreSQL (Neon)

---

## Étape 1 : Préparer les fichiers

### Sur ton Mac, dans le dossier du projet :

```bash
cd ~/Desktop/Claude/CILF/CILF-main/landmark-pacifique

# Installer les dépendances localement (pour vérifier)
npm install

# Créer l'archive pour le upload
cd ..
tar -czf landmark-pacifique.tar.gz landmark-pacifique/
```

---

## Étape 2 : Uploader via le panneau LWS

1. **Connecte-toi** au panneau LWS : https://admin.lws.net
2. Va dans **Gestion des fichiers** ou **FTP**
3. **Upload** le fichier `landmark-pacifique.tar.gz` dans le répertoire de ton site
4. **Décompresse** le fichier via le terminal SSH ou la console LWS

---

## Étape 3 : Installer les dépendances (SSH)

Si tu as un accès SSH, connecte-toi et exécute :

```bash
# Se connecter au serveur
ssh ton_utilisateur@ton_serveur_lws

# Aller dans le répertoire du projet
cd /home/ton_utilisateur/landmark-pacifique

# Installer les dépendances
npm install --production

# Vérifier que tout fonctionne
node -c api/index.js
```

---

## Étape 4 : Configurer les variables d'environnement

Crée ou modifie le fichier `.env` à la racine du projet :

```bash
nano .env
```

Contenu du fichier :

```env
# Database Neon
DATABASE_URL=postgresql://neondb_owner:ton_mdp@ep-xxx.neon.tech/neondb?sslmode=require

# JWT Secret
JWT_SECRET=ton_secret_jwt

# Cloudinary (si utilisé)
CLOUDINARY_API_KEY=ta_cle
CLOUDINARY_API_SECRET=ton_secret
CLOUDINARY_CLOUD_NAME=ton_cloud

# Brevo (emails)
BREVO_API_KEY=ta_cle_brevo

# Google Calendar (optionnel)
GOOGLE_CLIENT_ID=ton_client_id
GOOGLE_CLIENT_SECRET=ton_client_secret

# App URL
APP_URL=https://ton-domaine.com
```

---

## Étape 5 : Configurer Passenger / PM2

### Option A : Avec Passenger (recommandé LWS)

Crée un fichier `Passengerfile.json` à la racine :

```json
{
  "app_type": "node",
  "startup_file": "api/index.js",
  "environment": "production"
}
```

### Option B : Avec PM2

```bash
# Installer PM2 globalement
npm install -g pm2

# Démarrer l'application
pm2 start api/index.js --name landmark-pacifique

# Sauvegarder la config
pm2 save

# Démarrer au boot
pm2 startup
```

---

## Étape 6 : Configurer le domaine

Dans le panneau LWS :

1. Va dans **Domaines** ou **DNS**
2. Assigne ton domaine (ex: `landmark-pacifique.fr`) au répertoire du projet
3. Configure le **proxy inverse** si nécessaire (Nginx/Apache)

### Config Nginx (si VPS) :

```nginx
server {
    listen 80;
    server_name landmark-pacifique.fr www.landmark-pacifique.fr;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Étape 7 : Tester

```bash
# Vérifier que le serveur tourne
curl http://localhost:3000/api/maintenance

# Tester depuis l'extérieur
curl https://ton-domaine.com/api/maintenance
```

---

## 📋 SQL à appliquer dans Neon

```sql
-- Table api_keys
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  permissions JSONB NOT NULL DEFAULT '{"read_intros": true, "create_intros": false, "update_intros": false, "delete_intros": false}',
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Table api_key_audit_logs
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
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_key_id ON api_key_audit_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON api_key_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON api_key_audit_logs(action);
```

---

## 🔧 Dépannage

**Problème : "Cannot find module"**
```bash
npm install --production
```

**Problème : Port déjà utilisé**
```bash
# Trouver le processus
lsof -i :3000
# Le tuer
kill -9 <PID>
```

**Problème : WebSocket ne fonctionne pas**
- Vérifie que le proxy inverse supporte les WebSockets
- Vérifie les headers `Upgrade` et `Connection`

---

## 📁 Structure des fichiers sur le serveur

```
landmark-pacifique/
├── api/
│   ├── index.js        ← Serveur principal
│   ├── db.js           ← Config PostgreSQL
│   ├── mailer.js       ← Emails
│   ├── googleCalendar.js
│   └── package.json
├── public/
│   ├── index.html      ← Site principal
│   └── leader-analytics.html  ← Dashboard analytics
├── .env                ← Variables d'environnement
├── package.json
└── Passengerfile.json  ← Config Passenger
```
