/* ============================================================
   LANDMARK PACIFIQUE — Moteur d'internationalisation (i18n)

   Principe : le français est la langue source du site (aucune traduction
   appliquée, comportement inchangé). Pour les autres langues, chaque texte
   affiché est traduit à la volée à partir d'un dictionnaire dont les clés
   sont les textes français (voir i18n-en.js).

   - Textes du DOM (nœuds texte + placeholder/title/alt/aria-label) : traduits
     au chargement puis à chaque mutation, avant le premier affichage.
   - alert / confirm / prompt : traduits via un wrapper.
   - Contenu saisi par les utilisateurs : ajouter translate="no" sur l'élément
     pour l'exclure de la traduction.

   Ajouter une langue : déclarer son code dans LANGS, créer i18n-<code>.js
   avec LP_I18N.register('<code>', { exact, patterns }) et charger ce fichier.
   ============================================================ */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'lp_lang';
  var DEFAULT_LANG = 'fr';
  var LANGS = {
    fr: { label: 'Français', short: 'FR', flag: '🇫🇷', locale: 'fr-FR' },
    en: { label: 'English',  short: 'EN', flag: '🇬🇧', locale: 'en-GB' }
  };
  var TRANSLATED_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  var SKIPPED_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

  var dictionaries = {};
  var cache = {};

  function normalizeLang(code) {
    var c = String(code || '').toLowerCase().slice(0, 2);
    return Object.prototype.hasOwnProperty.call(LANGS, c) ? c : null;
  }

  function readStoredLang() {
    try { return normalizeLang(localStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
  }

  function writeStoredLang(code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* stockage indisponible */ }
    return readStoredLang() === code;
  }

  var currentLang = readStoredLang() || DEFAULT_LANG;

  /* ─── Traduction d'une chaîne ─── */
  function lookup(key) {
    var dict = dictionaries[currentLang];
    if (!dict) return key;
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    var out = key;
    if (Object.prototype.hasOwnProperty.call(dict.exact, key)) {
      out = dict.exact[key];
    } else {
      for (var i = 0; i < dict.patterns.length; i++) {
        var m = dict.patterns[i][0].exec(key);
        if (!m) continue;
        var rep = dict.patterns[i][1];
        out = typeof rep === 'function' ? rep.apply(null, m.slice(1).concat([translate])) : key.replace(dict.patterns[i][0], rep);
        break;
      }
    }
    cache[key] = out;
    return out;
  }

  /* Conserve les espaces de début/fin du texte d'origine (nœuds texte).
     `scope` (optionnel) désambiguïse un même texte français ayant plusieurs
     traductions : la clé "<scope>::<texte>" est essayée en premier. */
  function translate(text, scope) {
    if (currentLang === DEFAULT_LANG || typeof text !== 'string' || !text) return text;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!m[2]) return text;
    var key = m[2].replace(/\s+/g, ' ');
    var out = scope ? lookup(scope + '::' + key) : key;
    if (out === key || out === scope + '::' + key) out = lookup(key);
    return out === m[2] ? text : m[1] + out + m[3];
  }

  /* ─── Traduction du DOM ─── */
  var lastOutput = typeof WeakMap === 'function' ? new WeakMap() : null;

  function isExcluded(node) {
    for (var el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (SKIPPED_TAGS[el.tagName]) return true;
      if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    }
    return false;
  }

  function scopeOf(node) {
    for (var el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      var scope = el.getAttribute && el.getAttribute('data-i18n-scope');
      if (scope) return scope;
    }
    return '';
  }

  function translateTextNode(node) {
    var value = node.nodeValue;
    if (!value || (lastOutput && lastOutput.get(node) === value)) return;
    if (isExcluded(node)) return;
    var out = translate(value, scopeOf(node));
    if (out === value) return;
    if (lastOutput) lastOutput.set(node, out);
    node.nodeValue = out;
  }

  function translateAttributes(el) {
    if (!el.getAttribute) return;
    // Le contenu d'un <textarea> est saisi par l'utilisateur, mais son placeholder est un texte d'interface.
    if (isExcluded(el.tagName === 'TEXTAREA' ? el.parentElement || el : el)) return;
    var attrs = TRANSLATED_ATTRS;
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) attrs = attrs.concat('value');
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (!v) continue;
      var out = translate(v);
      if (out !== v) el.setAttribute(attrs[i], out);
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) translateAttributes(root);
    var walker = document.createTreeWalker(root, 1 | 4, null); // éléments + textes
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) translateTextNode(n); else translateAttributes(n);
    }
  }

  function onMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mu = mutations[i];
      if (mu.type === 'characterData') translateTextNode(mu.target);
      else if (mu.type === 'attributes') translateAttributes(mu.target);
      else for (var j = 0; j < mu.addedNodes.length; j++) translateTree(mu.addedNodes[j]);
    }
  }

  function startObserving() {
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: TRANSLATED_ATTRS.concat('value')
    });
    translateTree(document.documentElement);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { translateTree(document.body); });
    }
  }

  function wrapDialogs() {
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
      var original = global[name];
      global[name] = function (message) {
        var args = Array.prototype.slice.call(arguments);
        if (typeof args[0] === 'string') args[0] = translate(args[0]);
        return original.apply(global, args);
      };
    });
  }

  /* ─── API publique ─── */
  function register(code, dict) {
    dictionaries[code] = { exact: dict.exact || {}, patterns: dict.patterns || [] };
    cache = {};
    // Le dictionnaire arrive après le début du parsing (ex. <title>) : rattraper le contenu déjà présent.
    if (code === currentLang && code !== DEFAULT_LANG) translateTree(document.documentElement);
  }

  /* Mémorise la langue puis recharge la page si elle diffère de l'actuelle (le
     français, langue source, est rendu tel quel). Retourne false si la préférence
     n'a pas pu être conservée (stockage bloqué) : la page n'est alors pas
     rechargée, ce qui évite toute boucle de rechargement. */
  function setLang(code, options) {
    var lang = normalizeLang(code);
    if (!lang) return false;
    if (!writeStoredLang(lang)) return lang === currentLang;
    if (lang !== currentLang && (!options || options.reload !== false)) location.reload();
    return true;
  }

  function languageOptionsHtml(selected) {
    return Object.keys(LANGS).map(function (code) {
      return '<option value="' + code + '"' + (code === selected ? ' selected' : '') + '>' +
        LANGS[code].flag + ' ' + LANGS[code].label + '</option>';
    }).join('');
  }

  /* Sélecteur flottant pour les pages publiques (masqué dans l'application connectée). */
  function mountPublicSwitcher() {
    var box = document.createElement('div');
    box.id = 'langSwitch';
    box.setAttribute('translate', 'no');
    box.innerHTML = '<select aria-label="Language / Langue" onchange="LP_I18N.setLang(this.value)">' +
      languageOptionsHtml(currentLang) + '</select>';
    document.body.appendChild(box);
  }

  global.LP_I18N = {
    supported: LANGS,
    defaultLang: DEFAULT_LANG,
    lang: function () { return currentLang; },
    locale: function () { return LANGS[currentLang].locale; },
    normalize: normalizeLang,
    register: register,
    translate: translate,
    setLang: setLang,
    languageOptionsHtml: languageOptionsHtml,
    mountPublicSwitcher: mountPublicSwitcher
  };

  document.documentElement.lang = currentLang;
  if (currentLang !== DEFAULT_LANG) {
    wrapDialogs();
    startObserving();
  }
})(window);
