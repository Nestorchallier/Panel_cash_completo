// Contador de actividad del panel. Mientras el usuario mueve el mouse,
// escribe o hace scroll (en el panel o en cualquiera de sus pantallas
// internas) se va extendiendo un "tramo" en la tabla actividad. Si pasan
// UMBRAL_MS sin tocar nada, el tramo se cierra en el último movimiento; el
// hueco hasta el próximo tramo es una pausa. La pantalla actividad.html lo
// muestra. Si la tabla todavía no existe (falta correr 010_actividad.sql) se
// apaga solo sin molestar.
(function () {
  const UMBRAL_MS = 5 * 60000;
  const LATIDO_MS = 30000;
  const EVENTOS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  const TZ = 'America/Argentina/Buenos_Aires';

  let ultimoInput = Date.now();
  let inicioRacha = ultimoInput;
  let tramo = null; // { id, dia }
  let apagado = false;
  let ocupado = false;

  const diaDe = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
  const iso = (ms) => new Date(ms).toISOString();

  function marcar() {
    const ahora = Date.now();
    if (ahora - ultimoInput >= UMBRAL_MS) {
      inicioRacha = ahora;
      ultimoInput = ahora;
      latido(); // que el arranque quede registrado enseguida
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

  async function latido() {
    if (apagado || ocupado || !window.sb) return;
    ocupado = true;
    try {
      const ahora = Date.now();
      const activo = ahora - ultimoInput < UMBRAL_MS;
      if (tramo && (!activo || tramo.dia !== diaDe(ahora))) {
        // Se cierra en el último movimiento (o a medianoche si cambió el día).
        const fin = activo ? ahora : ultimoInput;
        await window.sb.from('actividad').update({ fin: iso(fin) }).eq('id', tramo.id);
        tramo = null;
        if (activo) inicioRacha = ahora;
      }
      if (!activo) return;
      if (!tramo) {
        const desde = Math.max(inicioRacha, ahora - LATIDO_MS * 2);
        const { data, error } = await window.sb.from('actividad')
          .insert({ dia: diaDe(desde), inicio: iso(desde), fin: iso(ahora) })
          .select('id').single();
        if (error) throw error;
        tramo = { id: data.id, dia: diaDe(desde) };
      } else {
        await window.sb.from('actividad').update({ fin: iso(ahora) }).eq('id', tramo.id);
      }
    } catch (e) {
      // Sin tabla o sin permisos: no tiene sentido seguir intentando.
      if (e && (e.code === '42P01' || e.code === 'PGRST205' || /actividad/.test(e.message || ''))) {
        apagado = true;
        console.warn('Contador de actividad apagado: falta correr supabase/010_actividad.sql', e);
      } else {
        console.error('actividad', e);
      }
    } finally {
      ocupado = false;
    }
  }

  // Al cerrar la pestaña el tramo queda cerrado en el último latido (como
  // mucho 30 s antes). Al volver se abre uno nuevo.
  function arrancar() {
    barrer(document);
    setInterval(() => barrer(document), 5000);
    setInterval(latido, LATIDO_MS);
    latido();
  }

  window.cmActividadArrancar = function () {
    if (window.__cmActividadOn) return;
    window.__cmActividadOn = true;
    arrancar();
  };
})();
