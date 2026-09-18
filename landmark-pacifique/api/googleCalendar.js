/* ─── GOOGLE CALENDAR (contact@landmark-pacifique.fr) ───
   Connexion via OAuth2 classique (pas de compte de service) : une seule
   autorisation manuelle par le titulaire du compte contact@landmark-pacifique.fr
   fournit un refresh_token, stocké en base (table settings), qui sert ensuite
   à créer les événements sur SON calendrier (ou un calendrier spécifique choisi)
   sans nouvelle action humaine.
   Pour les intros : une invitation Google Calendar groupée est envoyée à l'équipe
   (animateur, OPM, RC) avec la liste complète des invités par gradué. Chaque
   gradué ayant invité au moins un invité reçoit en plus SON PROPRE évènement
   personnel, avec uniquement ses invités et leur statut (pas ceux des autres). */
const { sql } = require('./db');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function redirectUri() {
  return process.env.GOOGLE_CALENDAR_REDIRECT_URI || 'https://www.landmark-pacifique.fr/api/admin/google-calendar/callback';
}

function isCalendarConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function getSetting(key) {
  const rows = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}`;
}

async function isConnected() {
  return !!(await getSetting('google_calendar_refresh_token'));
}

async function getTargetCalendarId() {
  return (await getSetting('google_calendar_id')) || 'primary';
}

async function setTargetCalendar(calendarId) {
  await setSetting('google_calendar_id', calendarId);
}

/* Calendrier dédié aux évènements personnels des gradués (séparé du calendrier de
   l'équipe) afin de ne pas encombrer ce dernier avec un évènement par gradué et
   par intro. Si non configuré, retombe sur le calendrier de l'équipe. */
async function getGraduateCalendarId() {
  return (await getSetting('google_calendar_graduate_id')) || (await getTargetCalendarId());
}

async function setGraduateCalendar(calendarId) {
  await setSetting('google_calendar_graduate_id', calendarId);
}

function getConnectUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function exchangeCodeForRefreshToken(code) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await tokenRes.json();
  if (!data.refresh_token) throw new Error(data.error_description || data.error || 'Google n\'a pas renvoyé de refresh_token (réessayer avec prompt=consent)');
  await setSetting('google_calendar_refresh_token', data.refresh_token);
  await setSetting('google_calendar_connected_at', new Date().toISOString());
}

let _accessTokenCache = { token: null, exp: 0 };

async function getAccessToken() {
  if (_accessTokenCache.token && Date.now() < _accessTokenCache.exp - 30000) return _accessTokenCache.token;
  const refreshToken = await getSetting('google_calendar_refresh_token');
  if (!refreshToken) throw new Error('Google Calendar non connecté (aucun refresh_token en base)');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || data.error || 'Refresh token Google invalide ou révoqué');
  _accessTokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

/* Tahiti = UTC-10 toute l'année (pas d'heure d'été) */
function tahitiDateTime(dateStr, heureStr) {
  return new Date(`${dateStr}T${heureStr}:00-10:00`).toISOString();
}

async function createEvent({ summary, description, date, heure, heureFin, location, attendees, calendarId }) {
  if (!date) throw new Error('Date manquante pour créer l\'événement Google Calendar');
  const accessToken = await getAccessToken();
  const targetCalendarId = calendarId || await getTargetCalendarId();
  const startISO = tahitiDateTime(date, heure || '09:00');
  let endISO = heureFin ? tahitiDateTime(date, heureFin) : null;
  if (!endISO || new Date(endISO) <= new Date(startISO)) {
    endISO = new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString();
  }
  const body = {
    summary,
    description: description || '',
    location: location || '',
    start: { dateTime: startISO },
    end: { dateTime: endISO },
  };
  const attendeeList = (attendees || []).filter(Boolean);
  if (attendeeList.length) body.attendees = attendeeList.map(email => ({ email }));
  const sendUpdates = attendeeList.length ? 'all' : 'none';
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events?sendUpdates=${sendUpdates}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.id) throw new Error((data.error && data.error.message) || 'Erreur création événement Google Calendar');
  return data.id;
}

async function deleteEvent(calendarId, eventId) {
  const accessToken = await getAccessToken();
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=none`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

/* sendUpdates='all' envoie réellement l'email d'invitation Google (utile quand la
   liste d'invités change) ; 'none' met juste à jour l'évènement silencieusement. */
async function updateEventFields(eventId, fields, sendUpdates = 'none', calendarId) {
  const accessToken = await getAccessToken();
  const targetCalendarId = calendarId || await getTargetCalendarId();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(fields),
  });
  const data = await res.json();
  if (!data.id) throw new Error((data.error && data.error.message) || 'Erreur mise à jour événement Google Calendar');
  return data;
}

/* Description d'une intro : animateur, RC, OPM, puis les gradués inscrits (le cas
   échéant), puis les invités groupés par gradué avec leur statut de confirmation
   — chaque gradué invité sur l'évènement retrouve ainsi facilement ses propres
   invités et leur statut. */
function buildIntroDescription(intro) {
  const parts = [];
  if (intro.animateur) parts.push(`Animateur : ${intro.animateur}`);
  if (intro.rc_name) parts.push(`RC : ${intro.rc_name}`);
  if (intro.opm_name) parts.push(`OPM : ${intro.opm_name}`);

  const regs = intro.registrations || [];
  const graduateAttendees = regs.filter(r => r.isGraduate);
  const guests = regs.filter(r => !r.isGraduate);
  const nameOf = r => `${r.firstname || ''} ${r.lastname || ''}`.trim() || (r.email || 'Sans nom');

  parts.push('');
  parts.push(`Gradués inscrits (${graduateAttendees.length}) :`);
  parts.push(...(graduateAttendees.length ? graduateAttendees.map(r => `- ${nameOf(r)}`) : ['- Aucun']));

  const byInviter = new Map();
  guests.forEach(r => {
    const key = r.invitedBy || 'Sans parrain';
    if (!byInviter.has(key)) byInviter.set(key, []);
    byInviter.get(key).push(r);
  });

  parts.push('');
  parts.push(`Invités par gradué (${guests.length}) :`);
  if (!byInviter.size) {
    parts.push('- Aucun');
  } else {
    for (const [inviter, list] of byInviter) {
      parts.push(`${inviter} :`);
      list.forEach(r => parts.push(`  - ${nameOf(r)} — ${r.confirmed ? 'Confirmé' : 'À confirmer'}`));
    }
  }

  return parts.join('\n');
}

/* Emails de l'équipe à inviter sur l'évènement principal : animateur, puis RC et
   OPM résolus à partir des champs rc_name/opm_name de l'intro elle-même (et non
   des auto-inscriptions event_roles, qui peuvent contenir d'anciens/mauvais
   signalements sans lien avec le RC/OPM réellement affiché sur cette intro).
   Les gradués n'y sont plus invités directement : ils reçoivent chacun leur
   propre évènement personnel (voir syncGraduateEvents). */
async function resolveTeamAttendeeEmails(intro) {
  const emails = new Set();
  if (intro.animateur_email) emails.add(intro.animateur_email.toLowerCase());
  try {
    if (intro.rc_name) {
      const rows = await sql`SELECT email FROM users WHERE LOWER(name) = LOWER(${intro.rc_name}) LIMIT 1`;
      if (rows[0] && rows[0].email) emails.add(rows[0].email.toLowerCase());
    }
    if (intro.opm_name) {
      const rows = await sql`SELECT email FROM users WHERE LOWER(name) = LOWER(${intro.opm_name}) LIMIT 1`;
      if (rows[0] && rows[0].email) emails.add(rows[0].email.toLowerCase());
    }
  } catch (e) { console.error('GCal resolve rc/opm names error:', e.message); }
  return Array.from(emails);
}

/* Emails des gradués ayant invité au moins un invité (déduits des inscriptions). */
function resolveGraduateEmails(intro) {
  const emails = new Set();
  (intro.registrations || []).forEach(r => { if (r.invitedByEmail) emails.add(r.invitedByEmail.toLowerCase()); });
  return Array.from(emails);
}

/* Emails de tous les gradués inscrits sur cette intro (qu'ils aient invité un
   invité ou non) — utilisé pour la Creation Call, où les gradués participent
   directement à l'appel avec l'équipe (pas de séparation par invités ici). */
function resolveAllGraduateEmails(intro) {
  const emails = new Set();
  (intro.registrations || []).forEach(r => { if (r.isGraduate && r.email) emails.add(r.email.toLowerCase()); });
  return Array.from(emails);
}

/* Description de la Creation Call : mêmes informations d'équipe que l'intro
   principale (pas de détail invités, non pertinent pour cet appel de préparation). */
function buildCreationCallDescription(intro) {
  const parts = [];
  if (intro.animateur) parts.push(`Animateur : ${intro.animateur}`);
  if (intro.rc_name) parts.push(`RC : ${intro.rc_name}`);
  if (intro.opm_name) parts.push(`OPM : ${intro.opm_name}`);
  return parts.join('\n');
}

/* Description personnelle envoyée à un gradué : uniquement ses propres invités
   et leur statut, sans le reste de la liste (il n'a pas besoin de voir les
   invités des autres gradués). */
function buildGraduateDescription(intro, gradEmail) {
  const mine = (intro.registrations || []).filter(
    r => !r.isGraduate && (r.invitedByEmail || '').toLowerCase() === gradEmail.toLowerCase()
  );
  const nameOf = r => `${r.firstname || ''} ${r.lastname || ''}`.trim() || (r.email || 'Sans nom');
  const parts = [`Tes invités (${mine.length}) :`];
  parts.push(...(mine.length ? mine.map(r => `- ${nameOf(r)} — ${r.confirmed ? 'Confirmé' : 'À confirmer'}`) : ['- Aucun']));
  return parts.join('\n');
}

/* Crée (première fois) ou met à jour (silencieusement) l'évènement personnel de
   chaque gradué ayant au moins un invité sur cette intro. Stocké dans
   intro.gcal_graduate_events (JSON { email: eventId }). */
async function syncGraduateEvents(intro, timeChanged = false) {
  if (!intro.date) return;
  let gradEvents = {};
  try { gradEvents = JSON.parse(intro.gcal_graduate_events || '{}'); } catch {}
  const gradEmails = resolveGraduateEmails(intro);
  const graduateCalendarId = await getGraduateCalendarId();
  let changed = false;
  for (const email of gradEmails) {
    const description = buildGraduateDescription(intro, email);
    if (gradEvents[email]) {
      try {
        if (timeChanged) {
          const fields = { description, ...timeFields(intro.date, intro.heure, intro.heure_fin, intro.zoom_url || intro.location) };
          await updateEventFields(gradEvents[email], fields, 'all', graduateCalendarId);
        } else {
          await updateEventFields(gradEvents[email], { description }, 'none', graduateCalendarId);
        }
      }
      catch (e) { console.error('GCal graduate update error:', e.message); }
    } else {
      try {
        gradEvents[email] = await createEvent({
          summary: intro.titre,
          description,
          date: intro.date,
          heure: intro.heure,
          heureFin: intro.heure_fin,
          location: intro.zoom_url || intro.location || '',
          attendees: [email],
          calendarId: graduateCalendarId,
        });
        changed = true;
      } catch (e) { console.error('GCal graduate create error:', e.message); }
    }
  }
  if (changed) await sql`UPDATE intros SET gcal_graduate_events = ${JSON.stringify(gradEvents)} WHERE id = ${intro.id}`;
}

/* Déplace les évènements personnels des gradués déjà créés sur l'ancien calendrier
   (celui de l'équipe) vers le calendrier dédié aux gradués (google_calendar_graduate_id).
   À exécuter une seule fois après avoir configuré ce nouveau calendrier. */
async function migrateGraduateEventsToOwnCalendar() {
  const oldCalendarId = await getTargetCalendarId();
  const rows = await sql`
    SELECT * FROM intros
    WHERE gcal_graduate_events IS NOT NULL AND gcal_graduate_events <> '' AND gcal_graduate_events <> '{}'`;
  let migrated = 0;
  for (const intro of rows) {
    let gradEvents = {};
    try { gradEvents = JSON.parse(intro.gcal_graduate_events || '{}'); } catch {}
    for (const eventId of Object.values(gradEvents)) {
      try { await deleteEvent(oldCalendarId, eventId); } catch (e) { console.error('GCal migrate graduate delete error:', e.message); }
    }
    await sql`UPDATE intros SET gcal_graduate_events = NULL WHERE id = ${intro.id}`;
    try { await syncGraduateEvents({ ...intro, gcal_graduate_events: null }); migrated++; }
    catch (e) { console.error('GCal migrate graduate recreate error:', e.message); }
  }
  return { migrated };
}

/* Supprime l'évènement existant et le recrée avec la liste d'invités complète en
   une seule fois : Google envoie alors UNE seule invitation à jour à tout le monde
   (team + gradués) plutôt que de renotifier tout le monde à chaque changement. */
async function forceRecreateIntroEvent(intro) {
  const calendarId = await getTargetCalendarId();
  if (intro.gcal_event_id) {
    try { await deleteEvent(calendarId, intro.gcal_event_id); } catch (e) { console.error('GCal delete before recreate error:', e.message); }
  }
  const emails = await resolveTeamAttendeeEmails(intro);
  const newEventId = await createEvent({
    summary: intro.titre,
    description: buildIntroDescription(intro),
    date: intro.date,
    heure: intro.heure,
    heureFin: intro.heure_fin,
    location: intro.zoom_url || intro.location || '',
    attendees: emails,
  });
  await sql`UPDATE intros SET gcal_event_id = ${newEventId}, gcal_attendees = ${JSON.stringify(emails)} WHERE id = ${intro.id}`;
  await syncGraduateEvents(intro);
  if (intro.cc_date) {
    try { await forceRecreateCreationCallEvent(intro); } catch (e) { console.error('GCal force recreate CC error:', e.message); }
  }
  return newEventId;
}

/* Supprime puis recrée la Creation Call avec l'équipe (animateur/RC/OPM) ET les
   gradués inscrits en invités — une seule invitation groupée, titre préfixé
   "Creation Call" pour la distinguer de l'intro elle-même dans le calendrier. */
async function forceRecreateCreationCallEvent(intro) {
  if (!intro.cc_date) return null;
  const calendarId = await getTargetCalendarId();
  if (intro.gcal_cc_event_id) {
    try { await deleteEvent(calendarId, intro.gcal_cc_event_id); } catch (e) { console.error('GCal delete CC before recreate error:', e.message); }
  }
  const teamEmails = await resolveTeamAttendeeEmails(intro);
  const gradEmails = resolveAllGraduateEmails(intro);
  const attendees = Array.from(new Set([...teamEmails, ...gradEmails]));
  const newCcEventId = await createEvent({
    summary: `Creation Call — ${intro.titre}`,
    description: buildCreationCallDescription(intro),
    date: intro.cc_date,
    heure: intro.cc_heure,
    heureFin: null,
    location: intro.zoom_cc || '',
    attendees,
  });
  await sql`UPDATE intros SET gcal_cc_event_id = ${newCcEventId}, gcal_cc_attendees = ${JSON.stringify(attendees)} WHERE id = ${intro.id}`;
  return newCcEventId;
}

/* Calcule les champs start/end (+ location) d'un évènement à partir des
   date/heure/heureFin courants de l'intro, pour les envoyer à Google lors d'un
   changement d'horaire. */
function timeFields(date, heure, heureFin, location) {
  const startISO = tahitiDateTime(date, heure || '09:00');
  let endISO = heureFin ? tahitiDateTime(date, heureFin) : null;
  if (!endISO || new Date(endISO) <= new Date(startISO)) {
    endISO = new Date(new Date(startISO).getTime() + 60 * 60 * 1000).toISOString();
  }
  return { start: { dateTime: startISO }, end: { dateTime: endISO }, location: location || '' };
}

/* Met à jour la description silencieusement si la liste d'invités n'a pas changé ;
   si elle a changé (nouveau gradué, OPM/RC assigné...), supprime l'ancien évènement
   et en recrée un seul avec tous les invités actuels (une seule invitation groupée).
   Appelé après chaque inscription et chaque confirmation d'invité.
   Si timeChanged est vrai (date/heure/heureFin modifiés depuis le PUT d'une intro),
   les nouveaux horaires sont poussés à Google avec sendUpdates='all' pour que les
   invités reçoivent une vraie notification de mise à jour de l'invitation. */
async function syncIntroAttendeesAndDescription(intro, timeChanged = false) {
  if (intro.gcal_event_id) {
    try {
      const emails = await resolveTeamAttendeeEmails(intro);
      let prev = [];
      try { prev = JSON.parse(intro.gcal_attendees || '[]'); } catch {}
      const changed = emails.length !== prev.length || emails.some(e => !prev.includes(e));
      if (changed) {
        await forceRecreateIntroEvent(intro);
        return; // forceRecreateIntroEvent gère aussi la Creation Call
      } else if (timeChanged && intro.date) {
        const fields = { description: buildIntroDescription(intro), ...timeFields(intro.date, intro.heure, intro.heure_fin, intro.zoom_url || intro.location) };
        await updateEventFields(intro.gcal_event_id, fields, 'all');
        await syncGraduateEvents(intro, true);
      } else {
        await updateEventFields(intro.gcal_event_id, { description: buildIntroDescription(intro) }, 'none');
        await syncGraduateEvents(intro);
      }
    } catch (e) { console.error('GCal sync attendees/description error:', e.message); }
  }

  // Creation Call : même logique anti-doublon (équipe + gradués inscrits).
  if (intro.cc_date) {
    try {
      const teamEmails = await resolveTeamAttendeeEmails(intro);
      const gradEmails = resolveAllGraduateEmails(intro);
      const ccEmails = Array.from(new Set([...teamEmails, ...gradEmails]));
      if (!intro.gcal_cc_event_id) {
        await forceRecreateCreationCallEvent(intro);
      } else {
        let prevCc = [];
        try { prevCc = JSON.parse(intro.gcal_cc_attendees || '[]'); } catch {}
        const ccChanged = ccEmails.length !== prevCc.length || ccEmails.some(e => !prevCc.includes(e));
        if (ccChanged) {
          await forceRecreateCreationCallEvent(intro);
        } else if (timeChanged) {
          const fields = { description: buildCreationCallDescription(intro), ...timeFields(intro.cc_date, intro.cc_heure, null, intro.zoom_cc) };
          await updateEventFields(intro.gcal_cc_event_id, fields, 'all');
        } else {
          await updateEventFields(intro.gcal_cc_event_id, { description: buildCreationCallDescription(intro) }, 'none');
        }
      }
    } catch (e) { console.error('GCal sync CC attendees/description error:', e.message); }
  }
}

/* Annule (supprime) tous les évènements Google Calendar liés à une intro archivée
   manuellement : l'évènement principal (équipe), sa Creation Call et l'évènement
   personnel de chaque gradué. Google notifie chaque invité·e (sendUpdates par
   défaut de deleteEvent) et l'entrée disparaît de son agenda — l'invitation est
   ainsi effectivement retirée. Les champs gcal_* de l'intro sont réinitialisés
   pour permettre une resynchronisation propre si l'intro est désarchivée. */
async function cancelIntroCalendarEvents(intro) {
  const calendarId = await getTargetCalendarId();
  if (intro.gcal_event_id) {
    try { await deleteEvent(calendarId, intro.gcal_event_id); } catch (e) { console.error('GCal cancel intro event error:', e.message); }
  }
  if (intro.gcal_cc_event_id) {
    try { await deleteEvent(calendarId, intro.gcal_cc_event_id); } catch (e) { console.error('GCal cancel CC event error:', e.message); }
  }
  let gradEvents = {};
  try { gradEvents = JSON.parse(intro.gcal_graduate_events || '{}'); } catch {}
  if (Object.keys(gradEvents).length) {
    const graduateCalendarId = await getGraduateCalendarId();
    for (const eventId of Object.values(gradEvents)) {
      try { await deleteEvent(graduateCalendarId, eventId); } catch (e) { console.error('GCal cancel graduate event error:', e.message); }
    }
  }
  await sql`UPDATE intros SET gcal_event_id = NULL, gcal_cc_event_id = NULL, gcal_attendees = NULL, gcal_cc_attendees = NULL, gcal_graduate_events = NULL WHERE id = ${intro.id}`;
}

/* Renvoie (met à jour) le titre, la description et les invités de toutes les
   intros déjà synchronisées. */
async function resyncIntroDescriptions() {
  const rows = await sql`SELECT * FROM intros WHERE archived = false AND gcal_event_id IS NOT NULL`;
  let updated = 0;
  for (const intro of rows) {
    try {
      await updateEventFields(intro.gcal_event_id, { summary: intro.titre }, 'none');
      await syncIntroAttendeesAndDescription(intro);
      updated++;
    } catch (e) { console.error('GCal resync error:', e.message); }
  }
  return { updated };
}

/* Force la suppression + recréation de toutes les intros déjà synchronisées, avec
   la liste d'invités complète (team + gradués) en une seule invitation groupée.
   À utiliser une fois pour remplacer d'anciennes invitations envoyées au fil de l'eau. */
async function forceRecreateAllIntroEvents() {
  const rows = await sql`SELECT * FROM intros WHERE archived = false AND gcal_event_id IS NOT NULL`;
  let recreated = 0;
  for (const intro of rows) {
    try { await forceRecreateIntroEvent(intro); recreated++; } catch (e) { console.error('GCal force recreate error:', e.message); }
  }
  return { recreated };
}

async function listCalendars() {
  const accessToken = await getAccessToken();
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  const data = await res.json();
  if (!data.items) throw new Error((data.error && data.error.message) || 'Erreur récupération des calendriers');
  return data.items.map(c => ({ id: c.id, summary: c.summary, primary: !!c.primary }));
}

/* Crée les évènements Google Calendar liés à une introduction : l'intro elle-même
   (avec invitation à l'animateur/OPM/RC/gradués) et, si renseignée, sa creation
   call (cc_date/cc_heure/zoom_cc). Ne recrée jamais un évènement déjà synchronisé
   (gcal_event_id / gcal_cc_event_id déjà présents). */
async function syncIntroCalendarEvents(intro) {
  const updates = {};
  if (!intro.gcal_event_id && intro.date) {
    try {
      const attendeeEmails = await resolveTeamAttendeeEmails(intro);
      updates.gcal_event_id = await createEvent({
        summary: intro.titre,
        description: buildIntroDescription(intro),
        date: intro.date,
        heure: intro.heure,
        heureFin: intro.heure_fin,
        location: intro.zoom_url || intro.location || '',
        attendees: attendeeEmails,
      });
      updates.gcal_attendees = JSON.stringify(attendeeEmails);
    } catch (e) { console.error('GCal sync intro error:', e.message); }
  }
  if (!intro.gcal_cc_event_id && intro.cc_date) {
    try {
      const teamEmails = await resolveTeamAttendeeEmails(intro);
      const gradEmails = resolveAllGraduateEmails(intro);
      const ccAttendees = Array.from(new Set([...teamEmails, ...gradEmails]));
      updates.gcal_cc_event_id = await createEvent({
        summary: `Creation Call — ${intro.titre}`,
        description: buildCreationCallDescription(intro),
        date: intro.cc_date,
        heure: intro.cc_heure,
        heureFin: null,
        location: intro.zoom_cc || '',
        attendees: ccAttendees,
      });
      updates.gcal_cc_attendees = JSON.stringify(ccAttendees);
    } catch (e) { console.error('GCal sync intro CC error:', e.message); }
  }
  return updates;
}

async function syncCreationCallCalendarEvent(cc) {
  if (cc.gcal_event_id || !cc.date) return null;
  try {
    return await createEvent({
      summary: cc.titre,
      description: '',
      date: cc.date,
      heure: cc.heure,
      heureFin: cc.heure_fin,
      location: cc.zoom_url || cc.location || '',
    });
  } catch (e) { console.error('GCal sync creation_call error:', e.message); return null; }
}

/* Rattrapage : synchronise toutes les intros/CC non archivées à venir qui n'ont
   pas encore d'évènement Google Calendar. */
async function backfillUpcomingEvents() {
  const today = new Date().toISOString().slice(0, 10);
  let introCount = 0, introCcCount = 0, ccTableCount = 0;

  const introRows = await sql`
    SELECT * FROM intros
    WHERE archived = false AND date >= ${today}
      AND (gcal_event_id IS NULL OR (cc_date IS NOT NULL AND cc_date <> '' AND gcal_cc_event_id IS NULL))`;
  for (const intro of introRows) {
    const updates = await syncIntroCalendarEvents(intro);
    if (updates.gcal_event_id || updates.gcal_cc_event_id) {
      await sql`UPDATE intros SET
          gcal_event_id = COALESCE(${updates.gcal_event_id || null}, gcal_event_id),
          gcal_cc_event_id = COALESCE(${updates.gcal_cc_event_id || null}, gcal_cc_event_id),
          gcal_attendees = COALESCE(${updates.gcal_attendees || null}, gcal_attendees),
          gcal_cc_attendees = COALESCE(${updates.gcal_cc_attendees || null}, gcal_cc_attendees)
        WHERE id = ${intro.id}`;
      if (updates.gcal_event_id) introCount++;
      if (updates.gcal_cc_event_id) introCcCount++;
    }
  }

  const ccRows = await sql`SELECT * FROM creation_calls WHERE archived = false AND date >= ${today} AND gcal_event_id IS NULL`;
  for (const cc of ccRows) {
    const id = await syncCreationCallCalendarEvent(cc);
    if (id) {
      await sql`UPDATE creation_calls SET gcal_event_id = ${id} WHERE id = ${cc.id}`;
      ccTableCount++;
    }
  }

  return { introCount, introCcCount, ccTableCount };
}

/* Supprime les évènements déjà créés sur l'ancien calendrier ("primary") pour les
   recréer sur le calendrier cible courant (google_calendar_id). À utiliser une seule
   fois après un changement de calendrier cible. */
async function migrateExistingEvents() {
  let deleted = 0;

  const introRows = await sql`SELECT * FROM intros WHERE gcal_event_id IS NOT NULL OR gcal_cc_event_id IS NOT NULL`;
  for (const intro of introRows) {
    if (intro.gcal_event_id) {
      try { await deleteEvent('primary', intro.gcal_event_id); deleted++; } catch (e) { console.error('GCal migrate delete intro error:', e.message); }
    }
    if (intro.gcal_cc_event_id) {
      try { await deleteEvent('primary', intro.gcal_cc_event_id); deleted++; } catch (e) { console.error('GCal migrate delete intro CC error:', e.message); }
    }
    await sql`UPDATE intros SET gcal_event_id = NULL, gcal_cc_event_id = NULL, gcal_attendees = NULL WHERE id = ${intro.id}`;
  }

  const ccRows = await sql`SELECT * FROM creation_calls WHERE gcal_event_id IS NOT NULL`;
  for (const cc of ccRows) {
    try { await deleteEvent('primary', cc.gcal_event_id); deleted++; } catch (e) { console.error('GCal migrate delete cc error:', e.message); }
    await sql`UPDATE creation_calls SET gcal_event_id = NULL WHERE id = ${cc.id}`;
  }

  const backfillResult = await backfillUpcomingEvents();
  return { deleted, ...backfillResult };
}

module.exports = {
  isCalendarConfigured, isConnected, getConnectUrl, exchangeCodeForRefreshToken,
  syncIntroCalendarEvents, syncCreationCallCalendarEvent, backfillUpcomingEvents,
  listCalendars, setTargetCalendar, migrateExistingEvents,
  syncIntroAttendeesAndDescription, resyncIntroDescriptions, forceRecreateAllIntroEvents,
  setGraduateCalendar, migrateGraduateEventsToOwnCalendar, cancelIntroCalendarEvents,
};
