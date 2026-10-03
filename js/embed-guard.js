// Guardia de las pantallas embebidas (Bandeja, Kanban, Clientes, Conexión,
// Refinanciaciones, Calculadora).
//
// Cada una de esas pantallas es un archivo .html aparte que index.html
// muestra adentro de un iframe, al lado del menú lateral. Si alguien abre
// el archivo suelto (un favorito viejo, un link copiado, "abrir en pestaña
// nueva"), la pantalla anda pero sin menú lateral, y los botones que
// saltan a otra pantalla ("Ver ficha completa", "Abrir chat"...) no hacen
// nada porque le hablan al panel de afuera, que no existe. Para que eso no
// pase nunca, si la página detecta que está sola, manda al panel completo
// directo en la vista que corresponde: index.html#view-whatsapp, etc.
//
// Va en el <head> y sin "defer", así corre antes de que la página empiece
// a pedir datos a Supabase.
//
// Para probar una pantalla suelta a propósito (mocks, capturas), alcanza
// con agregar ?suelta=1 a la dirección.
(function () {
  try {
    // Adentro del iframe del panel: no hay nada que hacer.
    if (window.top !== window.self) return;
  } catch (e) {
    // Si el navegador no deja comparar es porque está embebida en otro
    // sitio: tampoco es "suelta".
    return;
  }

  const params = new URLSearchParams(location.search);
  if (params.get('suelta') === '1') return;

  const archivo = (location.pathname.split('/').pop() || '').toLowerCase();
  const vistas = {
    'whatsapp_crm.html': 'view-whatsapp',
    'kanban_clientes.html': 'view-kanban',
    'clientes.html': 'view-clientes',
    'agenda.html': 'view-agenda',
    'conexion.html': 'view-conexion',
    'refi_buscador.html': 'view-refi',
    'calculadora_proximo_credito.html': 'view-calc',
  };
  let vista = vistas[archivo];
  if (!vista) return; // Página que no sabemos ubicar en el panel: se deja como está.

  // El Calendario no es un archivo propio: es el Kanban en modo calendario.
  if (vista === 'view-kanban' && /^cal/i.test(params.get('modo') || '')) vista = 'view-calendario';

  // Se oculta la página mientras salta, para que no se vea un instante la
  // pantalla sin menú. replace() en vez de href: así el botón "atrás" del
  // navegador no vuelve a la página suelta (que rebotaría de nuevo).
  document.documentElement.style.visibility = 'hidden';
  location.replace('index.html#' + vista);
})();
