/* ─── ENVOI VIA L'API HTTP BREVO ───
   Configuré via variable d'environnement BREVO_API_KEY (voir env.example).
   SMTP_FROM reste utilisé pour l'adresse/nom d'expéditeur.
*/
// Force la résolution DNS en IPv4 : l'IPv6 sortant du serveur change et casse l'allowlist d'IP de Brevo.
try { require('node:dns').setDefaultResultOrder('ipv4first'); } catch {}

function isMailConfigured() {
  return !!process.env.BREVO_API_KEY;
}

function parseFrom(from) {
  const match = /^(.*)<(.+)>$/.exec(from || '');
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  return { name: 'Landmark Pacifique', email: from };
}

/* ─── GABARIT COMMUN ─── */
const COLORS = { navy: '#0A1628', navy2: '#0F1F3A', cyan: '#00D4E8', gold: '#E8B86A', text: '#E2EAF4', muted: '#7A96B5' };

function wrapEmail(title, bodyHtml, cta) {
  const ctaHtml = cta ? `
    <tr><td style="padding:8px 40px 32px">
      <a href="${cta.link}" style="display:inline-block;background:linear-gradient(90deg,${COLORS.cyan},#0FFCBE);color:${COLORS.navy};font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;font-family:Arial,sans-serif;font-size:15px">${esc(cta.label)}</a>
    </td></tr>` : '';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#07111F;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07111F;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.navy};border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.08)">
        <tr><td style="padding:32px 40px 8px">
          <div style="font-family:Georgia,'Cormorant Garamond',serif;color:#fff;font-size:22px;font-weight:600">🌺 Landmark Pacifique</div>
        </td></tr>
        <tr><td style="padding:8px 40px 0">
          <h1 style="font-family:Georgia,'Cormorant Garamond',serif;color:#fff;font-size:26px;margin:12px 0 16px">${esc(title)}</h1>
          <div style="color:${COLORS.text};font-size:15px;line-height:1.6">${bodyHtml}</div>
        </td></tr>
        ${ctaHtml}
        <tr><td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,.08)">
          <p style="color:${COLORS.muted};font-size:12px;margin:0">La communauté francophone Landmark du Pacifique · Tahiti</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Bloc récapitulatif d'un événement (3 fuseaux horaires), réutilisé par plusieurs templates */
function eventBlock(event) {
  if (!event) return '';
  const rows = [];
  if (event.date_long) {
    rows.push(row('Tahiti', `${event.date_long}${event.heure_tahiti ? ' · ' + event.heure_tahiti + (event.heure_fin_tahiti ? '–' + event.heure_fin_tahiti : '') : ''}`));
  }
  if (event.date_long_nc) {
    rows.push(row('Nouméa', `${event.date_long_nc}${event.heure_nc ? ' · ' + event.heure_nc + (event.heure_fin_nc ? '–' + event.heure_fin_nc : '') : ''}`));
  }
  if (event.date_long_fr) {
    rows.push(row('France', `${event.date_long_fr}${event.heure_fr ? ' · ' + event.heure_fr + (event.heure_fin_fr ? '–' + event.heure_fin_fr : '') : ''}`));
  }
  if (!rows.length && event.date) rows.push(row('Date', `${event.date}${event.heure ? ' · ' + event.heure : ''}`));
  const meta = [];
  if (event.theme) meta.push(`<strong>Thème :</strong> ${esc(event.theme)}`);
  if (event.animateur) meta.push(`<strong>Animé par :</strong> ${esc(event.animateur)}`);
  if (event.format) meta.push(`<strong>Format :</strong> ${esc(event.format === 'zoom' ? 'Visioconférence (Zoom)' : event.format)}`);
  if (event.location) meta.push(`<strong>Lieu :</strong> ${esc(event.location)}`);
  return `
    <div style="background:${COLORS.navy2};border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 20px;margin:16px 0">
      <div style="font-weight:700;color:#fff;font-size:16px;margin-bottom:10px">${esc(event.titre || '')}</div>
      ${rows.join('')}
      ${meta.length ? `<div style="margin-top:10px;font-size:13.5px;color:${COLORS.text}">${meta.join(' · ')}</div>` : ''}
    </div>`;
  function row(label, value) {
    return `<div style="font-size:13.5px;color:${COLORS.muted};margin-bottom:2px"><strong style="color:${COLORS.text}">${esc(label)} :</strong> ${esc(value)}</div>`;
  }
}

/* ─── TEMPLATES PAR TYPE ─── */
function renderEmail(type, p) {
  const firstName = (p.to_name || '').trim().split(' ')[0] || '';

  if (type === 'forgot_password') {
    return {
      subject: 'Réinitialisation de votre mot de passe — Landmark Pacifique',
      html: wrapEmail('Réinitialisez votre mot de passe', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Vous avez demandé la réinitialisation de votre mot de passe sur l'espace communautaire Landmark Pacifique. Ce lien est valable <strong>1 heure</strong>.</p>
        <p>Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>
      `, { label: 'Réinitialiser mon mot de passe', link: p.reset_link }),
    };
  }

  if (['guest', 'guest_com', 'invite_special_event_guest'].includes(type)) {
    const gradName = p.graduate && p.graduate.name;
    return {
      subject: `Invitation — ${p.event ? p.event.titre : 'Landmark Pacifique'}`,
      html: wrapEmail('Vous êtes invité·e !', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>${gradName ? esc(gradName) + ' vous invite' : 'Vous êtes invité·e'} à participer à un événement de la communauté Landmark Pacifique.</p>
        ${eventBlock(p.event)}
        <p>Cliquez sur le bouton ci-dessous pour réserver votre place : votre espace personnel est créé automatiquement et vous y retrouverez tous les détails et le lien de l'événement.</p>
      `, { label: 'Je réserve ma place', link: p.invitation_link }),
    };
  }

  if (['guest_self', 'solo', 'special_event_grad_confirmed', 'special_event_guest_confirmed'].includes(type)) {
    return {
      subject: `Inscription confirmée — ${p.event ? p.event.titre : 'Landmark Pacifique'}`,
      html: wrapEmail('Votre inscription est confirmée ✅', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Votre présence est bien enregistrée. Voici le récapitulatif :</p>
        ${eventBlock(p.event)}
        <p>Nous avons hâte de vous y retrouver !</p>
      `, p.event && p.event.zoom_url ? { label: 'Rejoindre sur Zoom', link: p.event.zoom_url } : null),
    };
  }

  if (['guest_pid', 'special_event_pid_register'].includes(type)) {
    return {
      subject: `Votre inscription est enregistrée — ${p.event ? p.event.titre : 'Landmark Pacifique'}`,
      html: wrapEmail('Inscription enregistrée', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Votre inscription a bien été prise en compte. Voici le récapitulatif :</p>
        ${eventBlock(p.event)}
      `, p.event && p.event.zoom_url ? { label: 'Rejoindre sur Zoom', link: p.event.zoom_url } : null),
    };
  }

  if (type === 'guest_update') {
    return {
      subject: `Mise à jour — ${p.event ? p.event.titre : 'votre événement'}`,
      html: wrapEmail('L\'horaire a changé ⏰', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>L'horaire de l'événement auquel vous êtes invité·e vient d'être modifié. Voici les nouvelles informations :</p>
        ${eventBlock(p.event)}
        <p>Merci de noter ce changement${p.invitation_link ? ' et de confirmer à nouveau votre présence si besoin' : ''}.</p>
      `, p.invitation_link ? { label: 'Voir mon invitation', link: p.invitation_link } : null),
    };
  }

  if (type === 'guest_reminder') {
    return {
      subject: `Rappel — Réservez votre place à ${p.event ? p.event.titre : 'votre événement'}`,
      html: wrapEmail('N\'oubliez pas de réserver votre place 🔔', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Petit rappel amical : vous êtes invité·e à l'événement suivant. Un clic sur le bouton ci-dessous suffit pour réserver votre place et accéder à votre espace, où vous retrouverez le lien de l'événement.</p>
        ${eventBlock(p.event)}
      `, { label: 'Je réserve ma place', link: p.invitation_link }),
    };
  }

  if (type === 'creation_call_auto_enroll') {
    return {
      subject: `Appel de création programmé — ${p.creation_call ? p.creation_call.titre : ''}`,
      html: wrapEmail('Appel de création programmé', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>${esc(p.message || "Tu es inscrit à l'introduction. Merci de participer à l'appel de création avec au moins un invité confirmé.")}</p>
        ${eventBlock(p.creation_call)}
      `, p.creation_call && p.creation_call.zoom_url ? { label: 'Rejoindre sur Zoom', link: p.creation_call.zoom_url } : null),
    };
  }

  if (type === 'creation_call_register') {
    return {
      subject: `Inscription confirmée — Appel de création`,
      html: wrapEmail('Inscription à l\'appel de création confirmée', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Votre inscription à l'appel de création est bien enregistrée.</p>
        ${eventBlock(p.event)}
      `, p.event && p.event.zoom_url ? { label: 'Rejoindre sur Zoom', link: p.event.zoom_url } : null),
    };
  }

  if (type === 'clinic_call_register') {
    return {
      subject: `Inscription confirmée — Clinique`,
      html: wrapEmail('Inscription à la clinique confirmée', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>Votre inscription à la clinique est bien enregistrée.</p>
        ${eventBlock(p.event)}
      `, p.event && p.event.zoom_url ? { label: 'Rejoindre sur Zoom', link: p.event.zoom_url } : null),
    };
  }

  if (type === 'intro_cancelled') {
    const L = {
      fr: { format: 'Format', location: 'Lieu', zoom: 'Visioconférence (Zoom)', reason: 'Raison', notSpecified: 'Non précisée' },
      en: { format: 'Format', location: 'Location', zoom: 'Video call (Zoom)', reason: 'Reason', notSpecified: 'Not specified' },
    };
    function eventCardHtml(event, lang) {
      if (!event) return '';
      const t = L[lang];
      const rows = [];
      if (event.date_long) rows.push(`<div style="font-size:13.5px;color:${COLORS.muted};margin-bottom:2px"><strong style="color:${COLORS.text}">Tahiti:</strong> ${esc(event.date_long)}${event.heure_tahiti ? ' · ' + esc(event.heure_tahiti) : ''}</div>`);
      if (event.date_long_nc) rows.push(`<div style="font-size:13.5px;color:${COLORS.muted};margin-bottom:2px"><strong style="color:${COLORS.text}">Nouméa:</strong> ${esc(event.date_long_nc)}${event.heure_nc ? ' · ' + esc(event.heure_nc) : ''}</div>`);
      if (event.date_long_fr) rows.push(`<div style="font-size:13.5px;color:${COLORS.muted};margin-bottom:2px"><strong style="color:${COLORS.text}">France:</strong> ${esc(event.date_long_fr)}${event.heure_fr ? ' · ' + esc(event.heure_fr) : ''}</div>`);
      if (event.date_long_nz) rows.push(`<div style="font-size:13.5px;color:${COLORS.muted};margin-bottom:2px"><strong style="color:${COLORS.text}">New Zealand:</strong> ${esc(event.date_long_nz)}${event.heure_nz ? ' · ' + esc(event.heure_nz) : ''}</div>`);
      const meta = [];
      if (event.format) meta.push(`<strong>${t.format}:</strong> ${esc(event.format === 'zoom' ? t.zoom : event.format)}`);
      if (event.location) meta.push(`<strong>${t.location}:</strong> ${esc(event.location)}`);
      return `
        <div style="background:${COLORS.navy2};border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 20px;margin:16px 0">
          <div style="font-weight:700;color:#fff;font-size:16px;margin-bottom:10px">${esc(event.titre || '')}</div>
          ${rows.join('')}
          ${meta.length ? `<div style="margin-top:10px;font-size:13.5px;color:${COLORS.text}">${meta.join(' · ')}</div>` : ''}
        </div>`;
    }
    const eventFr = p.event_fr || p.event;
    const eventEn = p.event_en || p.event;
    return {
      subject: `Introduction annulée / Introduction cancelled — ${eventFr ? eventFr.titre : ''}`,
      html: wrapEmail('Introduction annulée / Introduction cancelled ❌', `
        <p>Ia ora na ${esc(firstName)},</p>
        <p>L'introduction suivante a été annulée :</p>
        ${eventCardHtml(eventFr, 'fr')}
        <p><strong>${L.fr.reason} :</strong> ${esc(p.reason || L.fr.notSpecified)}</p>
        <p>N'hésite pas à te rapprocher de l'équipe si tu as besoin de plus d'informations.</p>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:24px 0">
        <p>Hi ${esc(firstName)},</p>
        <p>The following introduction has been cancelled:</p>
        ${eventCardHtml(eventEn, 'en')}
        <p><strong>${L.en.reason}:</strong> ${esc(p.reason || L.en.notSpecified)}</p>
        <p>Feel free to reach out to the team if you need more information.</p>
      `),
    };
  }

  // Type inconnu : email générique minimal, pour ne jamais perdre silencieusement une notification
  return {
    subject: 'Notification — Landmark Pacifique',
    html: wrapEmail('Notification', `<p>Ia ora na ${esc(firstName)},</p><p>Vous avez une nouvelle notification sur votre espace Landmark Pacifique.</p>`),
  };
}

/* Extrait l'ID de réunion Zoom (les chiffres après "j/") d'un lien Zoom */
function extractZoomId(url) {
  const m = /\/j\/(\d+)/.exec(url || '');
  return m ? m[1] : '';
}

/* ─── TEMPLATES BREVO (repris des anciens scénarios Make) ───
   Chaque entrée mappe un type interne vers un templateId Brevo + les params
   attendus par ce template, construits à partir du payload existant.
*/
function brevoTemplate(type, p) {
  const event = p.event || {};
  const gradName = p.graduate && p.graduate.name;

  const eventDatesParams = {
    date_tah: event.date_long, date_nc: event.date_long_nc, date_fr: event.date_long_fr,
    heure_debut_tah: event.heure_tahiti, heure_debut_nc: event.heure_nc, heure_debut_fr: event.heure_fr,
    heure_fin_tah: event.heure_fin_tahiti, heure_fin_nc: event.heure_fin_nc, heure_fin_fr: event.heure_fin_fr,
  };
  const ccParams = {
    cc_tah: event.cc_date_long, cc_nc: event.cc_date_long_nc, cc_fr: event.cc_date_long_fr,
    heure_cc_tah: event.cc_heure_tahiti, heure_cc_nc: event.cc_heure_nc, heure_cc_fr: event.cc_heure_fr,
    invite_link: event.zoom_url, cc_link: event.zoom_cc,
    id_invite: extractZoomId(event.zoom_url), id_cc: extractZoomId(event.zoom_cc),
  };

  if (type === 'forgot_password') {
    return { templateId: 9, params: { name: p.to_name, reset_link: p.reset_link } };
  }

  if (['guest', 'guest_com', 'invite_special_event_guest', 'guest_reminder'].includes(type)) {
    return {
      templateId: type === 'guest_reminder' ? 17 : 1,
      params: { guest_name: p.to_name, grad_name: gradName, inscription_link: p.invitation_link, ...eventDatesParams },
    };
  }

  if (type === 'solo' || type === 'special_event_grad_confirmed') {
    return { templateId: 7, params: { grad_name: p.to_name, ...eventDatesParams, ...ccParams } };
  }

  if (type === 'guest_self' || type === 'special_event_guest_confirmed') {
    return { templateId: 2, params: { grad_name: gradName, guest_name: p.to_name, ...eventDatesParams } };
  }

  if (type === 'guest_pid' || type === 'special_event_pid_register') {
    return {
      templateId: 16,
      params: {
        guest_name: p.to_name, grad_name: gradName,
        date_tah: event.date_long, heure_debut_tah: event.heure_tahiti, heure_fin_tah: event.heure_fin_tahiti,
        invite_link: event.zoom_url,
      },
    };
  }

  if (type === 'creation_call_register') {
    return {
      templateId: 13,
      params: { grad_name: p.to_name, titre: event.titre, date_tah: event.date, heure_debut_tah: event.heure },
    };
  }

  if (type === 'clinic_call_register') {
    return {
      templateId: 18,
      params: { grad_name: p.to_name, titre: event.titre, location: event.location, date_tah: event.date, heure_debut_tah: event.heure },
    };
  }

  if (type === 'guest_intro_reminder_day_before' || type === 'guest_intro_reminder_1h') {
    return {
      templateId: 3,
      params: {
        guest_name: p.to_name, grad_name: gradName,
        heure_debut_tah: event.heure_tahiti, heure_debut_nc: event.heure_nc, heure_debut_fr: event.heure_fr,
        invite_link: event.zoom_url, id_invite: extractZoomId(event.zoom_url),
      },
    };
  }

  if (type === 'intro_cancelled') {
    const eventFr = p.event_fr || {};
    const eventEn = p.event_en || {};
    return {
      templateId: 24,
      params: {
        to_name: p.to_name,
        titre: eventFr.titre,
        reason: p.reason,
        location: eventFr.location,
        heure_tahiti: eventFr.heure_tahiti, heure_nc: eventFr.heure_nc, heure_fr: eventFr.heure_fr, heure_nz: eventFr.heure_nz,
        date_tah_fr: eventFr.date_long, date_nc_fr: eventFr.date_long_nc, date_fr_fr: eventFr.date_long_fr, date_nz_fr: eventFr.date_long_nz,
        date_tah_en: eventEn.date_long, date_nc_en: eventEn.date_long_nc, date_fr_en: eventEn.date_long_fr, date_nz_en: eventEn.date_long_nz,
      },
    };
  }

  return null;
}

/* ─── ENVOI (API HTTP Brevo) ─── */
async function sendAppMail(payload) {
  try {
    if (!isMailConfigured() || !payload || !payload.to_email) return null;
    const sender = parseFrom(process.env.SMTP_FROM);
    const to = [{ email: payload.to_email, name: payload.to_name || undefined }];
    const template = brevoTemplate(payload.type, payload);
    let body;
    if (template) {
      body = { sender, to, templateId: template.templateId, params: template.params };
    } else {
      const { subject, html } = renderEmail(payload.type, payload);
      body = { sender, to, subject, htmlContent: html };
    }
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Brevo API ${res.status}: ${JSON.stringify(resBody)}`);
    }
    return { messageId: resBody.messageId || null };
  } catch (err) {
    console.error('sendAppMail error:', err.message);
    return null;
  }
}

module.exports = { sendAppMail, isMailConfigured, renderEmail };
