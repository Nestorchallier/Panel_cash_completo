// Contador de actividad del panel. Mientras el usuario mueve el mouse,
// escribe o hace scroll (en el panel o en cualquiera de sus pantallas
// internas) se va extendiendo un "tramo" en la tabla actividad. Si pasan
// UMBRAL_MS sin tocar nada, el tramo se cierra en el último movimiento; el
// hueco hasta el próximo tramo es una pausa. Además, cada LATIDO_MS se
// anota en actividad_latido que la pestaña sigue abierta (aunque no toque
// nada): así el supervisor ve Conectado / Inactivo N min / Desconectado.
// Lo muestra supervisor.html. Si las tablas todavía no existen (falta
// correr 010_actividad.sql) se apaga solo sin molestar.
//
// Lo arranca index.html (cmActividadArrancar) solo para los cobradores; un
// supervisor mirando el panel de otro no registra nada.
(function () {
  const UMBRAL_MS = 5 * 60000;
  const LATIDO_MS = 30000;
  const EVENTOS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  const TZ = 'America/Argentina/Buenos_Aires';

  let uid = null;
  let ultimoInput = Date.now();   // abrir el panel cuenta como actividad
  let inicioRacha = ultimoInput;  // desde cuándo viene activo sin cortes
  let pausaDesde = null;          // último movimiento antes de una pausa todavía no cerrada en la base
  let tramo = null;               // { id, dia }
  const sesionDesde = new Date().toISOString();
  let apagado = false;
  let ocupado = false;

  const diaDe = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
  const iso = (ms) => new Date(ms).toISOString();

  function marcar() {
    const ahora = Date.now();
    if (ahora - ultimoInput >= UMBRAL_MS) {
      // Vuelve de una pausa: el tramo anterior se cierra en el último
      // movimiento (aunque el latido no haya llegado a cerrarlo) y arranca
      // uno nuevo ahora.
      if (tramo && pausaDesde === null) pausaDesde = ultimoInput;
      inicioRacha = ahora;
      ultimoInput = ahora;
      latido(); // que el regreso quede registrado enseguida
    } else {
      ultimoInput = ahora;
    }
  }

  // Engancha los eventos en el documento y en todos sus iframes (también los
  // anidados, como el chat que abre el Kanban). Un iframe que recarga trae
  // un documento nuevo, por eso se barre cada tanto.
  function barrer(doc) {
    if (!doc) return;
    if (!doc.__cmActividad) {
      doc.__cmActividad = true;
      EVENTOS.forEach((ev) => doc.addEventListener(ev, marcar, { passive: true, capture: true }));
    }
    doc.querySelectorAll('iframe').forEach((f) => {
      try { barrer(f.contentDocument); } catch (_) { /* otro origen */ }
    });
  }

  function chequear(error) {
    if (error) throw error;
  }

  async function latido() {
    if (apagado || ocupado || !window.sb || !uid) return;
    ocupado = true;
    try {
      const ahora = Date.now();
      const activo = ahora - ultimoInput < UMBRAL_MS;

      // 1) La pestaña está abierta (aunque no toque nada).
      const r0 = await window.sb.from('actividad_latido').upsert({
        user_id: uid, latido_at: iso(ahora), ultimo_input_at: iso(ultimoInput), sesion_desde: sesionDesde,
      });
      chequear(r0.error);

      // 2) Cerrar el tramo abierto si hubo pausa o cambió el día.
      if (tramo) {
        let fin = null;
        if (pausaDesde !== null) fin = pausaDesde;              // volvió de una pausa
        else if (!activo) fin = ultimoInput;                    // está en pausa
        else if (tramo.dia !== diaDe(ahora)) fin = ahora;       // pasó la medianoche
        if (fin !== null) {
          const r1 = await window.sb.from('actividad').update({ fin: iso(fin) }).eq('id', tramo.id).eq('user_id', uid);
          chequear(r1.error);
          tramo = null;
          pausaDesde = null;
          if (activo && fin === ahora) inicioRacha = ahora;
        }
      }
      pausaDesde = null;
      if (!activo) return;

      // 3) Abrir o estirar el tramo actual.
      if (!tramo) {
        const desde = Math.min(Math.max(inicioRacha, ahora - LATIDO_MS * 2), ahora);
        const { data, error } = await window.sb.from('actividad')
          .insert({ user_id: uid, dia: diaDe(desde), inicio: iso(desde), fin: iso(ahora) })
          .select('id').single();
        chequear(error);
        tramo = { id: data.id, dia: diaDe(desde) };
      } else {
        const r2 = await window.sb.from('actividad').update({ fin: iso(ahora) }).eq('id', tramo.id).eq('user_id', uid);
        chequear(r2.error);
      }
    } catch (e) {
      // Sin tabla o sin permisos: no tiene sentido seguir intentando.
      const codigo = e && e.code;
      if (['42P01', 'PGRST205', 'PGRST204', '42501', 'SOLO_LECTURA'].includes(codigo)) {
        apagado = true;
        console.warn('Contador de actividad apagado (¿falta correr supabase/010_actividad.sql?)', e);
      } else {
        console.error('actividad', e);
      }
    } finally {
      ocupado = false;
    }
  }

  // Al cerrar la pestaña el tramo queda cerrado en el último latido (como
  // mucho 30 s antes) y el latido deja de llegar: el supervisor lo ve
  // "Desconectado" a los pocos minutos. Al volver se abre un tramo nuevo.
  function arrancar() {
    barrer(document);
    setInterval(() => barrer(document), 5000);
    setInterval(latido, LATIDO_MS);
    latido();
  }

  window.cmActividadArrancar = async function () {
    if (window.__cmActividadOn) return;
    if (window.cmSoloLectura && window.cmSoloLectura()) return;
    window.__cmActividadOn = true;
    try { uid = await window.cmUidPropio(); } catch (e) { window.__cmActividadOn = false; return; }
    arrancar();
  };
  // Para las pruebas.
  window.__cmActividadLatido = latido;
})();
