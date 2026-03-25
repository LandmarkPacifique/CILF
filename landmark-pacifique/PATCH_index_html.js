// ══════════════════════════════════════════════════════════════════════════════
// PATCH index.html — remplacer le bloc localStorage par des appels API Neon
// ══════════════════════════════════════════════════════════════════════════════
//
// Dans ton index.html, trouve et REMPLACE ces 5 fonctions :
//
//   function getPw()     { return localStorage.getItem("lm_pw")||"LandmarkPacifique2026"; }
//   function getData(k,def){ try{return JSON.parse(localStorage.getItem(k))||def;}catch{return def;} }
//   function setData(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch{} }
//   function getIntros() { return getData("lm_intros", DEF); }
//   function getCfg()    { return getData("lm_config", {}); }
//   function getPilfIntros(){ return getData("lm_pilf", DEF_PILF); }
//
// AUSSI : function saveAll()  et  function savePilf()
//
// PAR CE BLOC COMPLET :
// ══════════════════════════════════════════════════════════════════════════════

// ── Configuration ─────────────────────────────────────────────────────────────
const API_BASE = '';          // vide = même domaine Vercel
                               // En dev local mettre : 'http://localhost:3000'

// Token admin : stocké en mémoire pendant la session (saisi au login)
let _adminToken = null;

// ── Helpers bas niveau ────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (_adminToken) headers['x-admin-token'] = _adminToken;
  const res = await fetch(API_BASE + path, { headers, ...opts });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// On remplace getPw() par une vérification serveur implicite :
// le token admin est simplement ADMIN_TOKEN côté Vercel env.
// Le mot de passe local sert toujours à afficher le panneau admin,
// mais la SAUVEGARDE nécessite le bon token.

function getPw() {
  // Mot de passe local affiché (inchangé - permet d'ouvrir l'interface)
  return localStorage.getItem('lm_pw') || 'LandmarkPacifique2026';
}

// Appeler cette fonction au login pour stocker le token admin
// Le token == le mot de passe admin dans Vercel env vars (ADMIN_TOKEN)
function setAdminToken(pw) {
  _adminToken = pw;
}

// ── Lecture des introductions ─────────────────────────────────────────────────
async function getIntros() {
  try {
    return await apiFetch('/api/intros?slug=cilf');
  } catch (e) {
    console.warn('getIntros fallback localStorage:', e);
    try { return JSON.parse(localStorage.getItem('lm_intros')) || DEF; } catch { return DEF; }
  }
}

async function getPilfIntros() {
  try {
    return await apiFetch('/api/intros?slug=pilf');
  } catch (e) {
    console.warn('getPilfIntros fallback localStorage:', e);
    try { return JSON.parse(localStorage.getItem('lm_pilf')) || DEF_PILF; } catch { return DEF_PILF; }
  }
}

// ── Lecture de la config ──────────────────────────────────────────────────────
async function getCfg() {
  try {
    return await apiFetch('/api/config');
  } catch (e) {
    console.warn('getCfg fallback localStorage:', e);
    try { return JSON.parse(localStorage.getItem('lm_config')) || {}; } catch { return {}; }
  }
}

// ── Sauvegarde des introductions ──────────────────────────────────────────────
async function saveAll() {
  if (!draft) return;
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';
  try {
    await apiFetch('/api/intros', {
      method: 'POST',
      body: JSON.stringify({ slug: 'cilf', intros: draft }),
    });
    draft = null;
    btn.textContent = '✓ Enregistré et publié !';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Enregistrer et publier'; btn.classList.remove('saved'); btn.disabled = false; renderAdmin(); }, 3000);
  } catch (e) {
    btn.textContent = '⚠ Erreur — réessayez';
    btn.disabled = false;
    console.error('saveAll error:', e);
  }
}

async function savePilf() {
  if (!pilfDraft) return;
  const btn = document.getElementById('pilf-save-btn');
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';
  try {
    await apiFetch('/api/intros', {
      method: 'POST',
      body: JSON.stringify({ slug: 'pilf', intros: pilfDraft }),
    });
    pilfDraft = null;
    btn.textContent = '✓ Enregistré !';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Enregistrer et publier'; btn.classList.remove('saved'); btn.disabled = false; renderPilf(); }, 3000);
  } catch (e) {
    btn.textContent = '⚠ Erreur — réessayez';
    btn.disabled = false;
    console.error('savePilf error:', e);
  }
}

// ── Sauvegarde de la config ───────────────────────────────────────────────────
async function saveCfg(cfg) {
  try {
    await apiFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    });
  } catch (e) {
    console.error('saveCfg error:', e);
  }
}

// ── Adapter renderPublic, renderAdmin, renderPilf pour l'async ────────────────
// Ces fonctions appellent getIntros() / getPilfIntros() / getCfg() qui sont
// maintenant ASYNC. Il faut donc les adapter :
//
//   function renderPublic() {         →   async function renderPublic() {
//     const grid = ...                        const grid = ...
//     getIntros().forEach(...)        →       const intros = await getIntros();
//                                             intros.forEach(...)
//
// Fais la même chose pour renderAdmin() et renderPilf().
//
// Cherche aussi les appels à getCfg() dans submitSolo / submitWithGuest
// et ajoute await devant.
//
// ── Connexion admin — stocker le token ────────────────────────────────────────
// Dans doLogin(), après la vérification du mot de passe, ajouter :
//
//   setAdminToken(v);   // v = valeur du champ mot de passe
//
// ══════════════════════════════════════════════════════════════════════════════
