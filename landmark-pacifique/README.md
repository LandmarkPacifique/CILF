# Landmark Pacifique — Migration localStorage → Neon

## Architecture

```
Vercel (ton projet existant)
├── public/
│   └── index.html          ← ton fichier HTML (modifié)
├── api/
│   ├── intros.js           ← GET/POST les introductions
│   └── config.js           ← GET/POST la config Brevo/templates
├── package.json
└── vercel.json
```

---

## 1. Créer la base de données Neon

1. Va sur **console.neon.tech** → ouvre ton projet
2. Clique sur **SQL Editor**
3. Copie-colle le contenu de `schema.sql` et exécute-le
4. Copie la **DATABASE_URL** (format `postgresql://...`)

---

## 2. Configurer les variables d'environnement Vercel

Dans ton tableau de bord Vercel → **Settings → Environment Variables** :

| Nom | Valeur |
|-----|--------|
| `DATABASE_URL` | `postgresql://user:pass@host/dbname?sslmode=require` |
| `ADMIN_TOKEN`  | Le mot de passe admin (ex: `LandmarkPacifique2026`) |

> ⚠️ `ADMIN_TOKEN` doit correspondre au mot de passe que tu utilises
> pour te connecter au panneau admin dans l'interface.

---

## 3. Ajouter les fichiers API à ton projet

Copie `api/intros.js`, `api/config.js`, `package.json` et `vercel.json`
à la racine de ton dépôt Vercel.

---

## 4. Modifier index.html

Ouvre `index.html` et applique les modifications décrites dans `PATCH_index_html.js`.

### Résumé des changements

#### A. Remplacer les 6 fonctions de stockage (vers le bas du `<script>`)

Cherche et supprime ce bloc :
```js
function getPw(){ return localStorage.getItem("lm_pw")||"LandmarkPacifique2026"; }
function getData(k,def){ try{return JSON.parse(localStorage.getItem(k))||def;}catch{return def;} }
function setData(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch{} }
const DEF = [...]
function getIntros(){ return getData("lm_intros", DEF); }
function getCfg(){    return getData("lm_config", {}); }
```

Et aussi `function saveAll()` et `function savePilf()`.

Remplace-les par le contenu de `PATCH_index_html.js` (jusqu'à la ligne
"Adapter renderPublic...").

#### B. Rendre renderPublic() async

```js
// AVANT
function renderPublic(){
  const grid=document.getElementById("intros-grid");
  if(!grid)return;
  grid.innerHTML="";
  getIntros().forEach((intro,i)=>{

// APRÈS
async function renderPublic(){
  const grid=document.getElementById("intros-grid");
  if(!grid)return;
  grid.innerHTML="<p style='text-align:center;color:var(--navy-mid);padding:20px'>Chargement…</p>";
  const intros = await getIntros();
  grid.innerHTML="";
  intros.forEach((intro,i)=>{
```

#### C. Rendre renderAdmin() async

```js
// AVANT
function renderAdmin(){
  const intros=getIntros(), cfg=getCfg();

// APRÈS
async function renderAdmin(){
  const [intros, cfg] = await Promise.all([getIntros(), getCfg()]);
```

#### D. Rendre renderPilf() async

```js
// AVANT
function renderPilf(){
  const intros = getPilfIntros();

// APRÈS
async function renderPilf(){
  const intros = await getPilfIntros();
```

#### E. Ajouter await dans submitSolo et submitWithGuest

```js
// AVANT
const cfg=getCfg();
// APRÈS
const cfg = await getCfg();
```
(il y en a 2 occurrences, une dans chaque fonction)

#### F. Stocker le token au login

Dans `doLogin()`, après la ligne `goPage("page-admin")` :
```js
setAdminToken(v);  // ← ajouter cette ligne
```

#### G. Optionnel — changer le mot de passe

La fonction `changePw()` écrit dans `localStorage`.
Si tu veux que le changement soit persistant pour tous les navigateurs,
il faut appeler `saveCfg({ admin_pw: np })` et modifier `getPw()`
pour lire depuis l'API. Pour l'instant, le comportement actuel reste fonctionnel.

---

## 5. Déployer

```bash
git add .
git commit -m "feat: migration localStorage → Neon"
git push
```

Vercel redéploie automatiquement.

---

## 6. Vérifier

1. Ouvre le site → les introductions doivent se charger depuis Neon
2. Connecte-toi en admin → ajoute une introduction → clique "Enregistrer"
3. Ouvre le site dans un autre navigateur / appareil → l'intro doit apparaître ✅

---

## Sécurité

- Les routes GET (`/api/intros`, `/api/config`) sont **publiques** (lecture seule)
- Les routes POST nécessitent le header `x-admin-token` = `ADMIN_TOKEN`
- `ADMIN_TOKEN` n'est **jamais** exposé dans le HTML côté client
- Le token est envoyé uniquement quand l'admin est connecté (`_adminToken` en mémoire)
