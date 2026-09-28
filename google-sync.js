// Sincronizacion con Google Calendar + Google Tasks para las promesas de
// pago del Kanban de Cartera.
//
// Fase 1 (esta): un solo sentido, Kanban -> Google. Cuando se guarda un
// cliente con fecha de promesa, se crea/actualiza un evento en un calendario
// dedicado ("Panel Cash Market — Promesas") y una tarea en una lista de
// tareas dedicada. Si se borra la fecha o el cliente, se borra tambien del
// lado de Google.
//
// No hay backend propio, asi que el login usa el flujo de "token client" de
// Google Identity Services: pide un access token de corta duracion (~1hs)
// directo en el navegador, sin pasar por ningun servidor nuestro. El token
// vive solo en memoria (nunca se guarda en Supabase); cada vez que se abre
// la pagina se vuelve a pedir, y si el usuario ya dio permiso antes suele
// venir "silencioso" (sin mostrar pantalla de Google de nuevo).

const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks';
const GOOGLE_ENABLED_KEY = 'google_sync_enabled_v1';
const GOOGLE_CALENDAR_ID_KEY = 'google_calendar_id_v1';
const GOOGLE_TASKLIST_ID_KEY = 'google_tasklist_id_v1';

let googleTokenClient = null;
let googleAccessToken = null;
let googleTokenExpiresAt = 0;

function initGoogleAuth() {
  if (googleTokenClient || typeof google === 'undefined') return;
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: () => {}, // se pisa por llamada en ensureGoogleToken()
  });
}

// Devuelve un access token valido, pidiendo consentimiento si hace falta
// (primera vez) o renovando en silencio si ya se habia otorgado antes.
function ensureGoogleToken(interactive) {
  return new Promise((resolve, reject) => {
    if (googleAccessToken && Date.now() < googleTokenExpiresAt - 60000) {
      resolve(googleAccessToken);
      return;
    }
    if (!googleTokenClient) initGoogleAuth();
    if (!googleTokenClient) { reject(new Error('Google Identity Services no cargo todavia')); return; }
    googleTokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      googleAccessToken = resp.access_token;
      googleTokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve(googleAccessToken);
    };
    googleTokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

async function isGoogleSyncEnabled() {
  const v = await kvGet(GOOGLE_ENABLED_KEY);
  return v === true;
}

// Se llama desde el boton "Conectar Google" del toolbar. Pide consentimiento
// explicito (primera vez siempre muestra la pantalla de Google) y, si sale
// bien, guarda la preferencia y crea el calendario/lista de tareas dedicados.
async function connectGoogle() {
  await ensureGoogleToken(true);
  await ensureGoogleCalendar();
  await ensureGoogleTaskList();
  await kvSet(GOOGLE_ENABLED_KEY, true);
}

async function disconnectGoogle() {
  await kvSet(GOOGLE_ENABLED_KEY, false);
  if (googleAccessToken) {
    try { google.accounts.oauth2.revoke(googleAccessToken, () => {}); } catch (e) {}
  }
  googleAccessToken = null;
  googleTokenExpiresAt = 0;
}

async function googleFetch(url, options) {
  const token = await ensureGoogleToken(false);
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ensureGoogleCalendar() {
  let calId = await kvGet(GOOGLE_CALENDAR_ID_KEY);
  if (calId) return calId;
  const created = await googleFetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    body: JSON.stringify({ summary: 'Panel Cash Market — Promesas', timeZone: 'America/Argentina/Buenos_Aires' }),
  });
  calId = created.id;
  await kvSet(GOOGLE_CALENDAR_ID_KEY, calId);
  return calId;
}

async function ensureGoogleTaskList() {
  let listId = await kvGet(GOOGLE_TASKLIST_ID_KEY);
  if (listId) return listId;
  const created = await googleFetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
    method: 'POST',
    body: JSON.stringify({ title: 'Panel Cash Market — Promesas' }),
  });
  listId = created.id;
  await kvSet(GOOGLE_TASKLIST_ID_KEY, listId);
  return listId;
}

function clientEventBody(client) {
  const notasLinea = [
    client.dni ? `DNI: ${client.dni}` : '',
    client.telefono ? `Tel: ${client.telefono}` : '',
    client.monto ? `Prestamo: ${client.monto}` : '',
    client.notas || '',
  ].filter(Boolean).join('\n');
  const siguienteDia = new Date(client.fechaPromesa + 'T00:00:00');
  siguienteDia.setDate(siguienteDia.getDate() + 1);
  const finStr = siguienteDia.toISOString().slice(0, 10);
  return {
    summary: `Promesa de pago — ${client.nombre}`,
    description: notasLinea,
    start: { date: client.fechaPromesa },
    end: { date: finStr },
    extendedProperties: { private: { panelCashClientId: client.id } },
  };
}

function clientTaskBody(client) {
  const notasLinea = [
    client.dni ? `DNI: ${client.dni}` : '',
    client.telefono ? `Tel: ${client.telefono}` : '',
    client.monto ? `Prestamo: ${client.monto}` : '',
    client.notas || '',
  ].filter(Boolean).join('\n');
  return {
    title: `Promesa de pago — ${client.nombre}`,
    notes: notasLinea,
    due: client.fechaPromesa + 'T00:00:00.000Z',
  };
}

// Crea o actualiza el evento + tarea de un cliente en Google, segun tenga
// fecha de promesa cargada. Muta el objeto `client` (le agrega/actualiza
// googleEventId / googleTaskId) — quien llama es responsable de guardar el
// estado despues (save() en kanban_clientes.html).
async function syncClientToGoogle(client) {
  if (!(await isGoogleSyncEnabled())) return;
  try {
    if (!client.fechaPromesa) {
      await deleteClientFromGoogle(client);
      return;
    }
    const calId = await ensureGoogleCalendar();
    const listId = await ensureGoogleTaskList();

    if (client.googleEventId) {
      await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${client.googleEventId}`, {
        method: 'PATCH',
        body: JSON.stringify(clientEventBody(client)),
      });
    } else {
      const created = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
        method: 'POST',
        body: JSON.stringify(clientEventBody(client)),
      });
      client.googleEventId = created.id;
    }

    if (client.googleTaskId) {
      await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${client.googleTaskId}`, {
        method: 'PATCH',
        body: JSON.stringify(clientTaskBody(client)),
      });
    } else {
      const created = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(clientTaskBody(client)),
      });
      client.googleTaskId = created.id;
    }
  } catch (e) {
    console.error('syncClientToGoogle', e);
    throw e;
  }
}

async function deleteClientFromGoogle(client) {
  if (!(await isGoogleSyncEnabled())) return;
  try {
    const calId = await kvGet(GOOGLE_CALENDAR_ID_KEY);
    const listId = await kvGet(GOOGLE_TASKLIST_ID_KEY);
    if (client.googleEventId && calId) {
      await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${client.googleEventId}`, { method: 'DELETE' }).catch(() => {});
      delete client.googleEventId;
    }
    if (client.googleTaskId && listId) {
      await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${client.googleTaskId}`, { method: 'DELETE' }).catch(() => {});
      delete client.googleTaskId;
    }
  } catch (e) {
    console.error('deleteClientFromGoogle', e);
  }
}
