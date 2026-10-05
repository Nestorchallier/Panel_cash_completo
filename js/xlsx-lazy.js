// Carga de SheetJS (xlsx.full.min.js, ~900 KB) recién cuando hace falta:
// antes iba como <script> síncrono en el <head> y frenaba el arranque de
// cada pantalla, aunque solo se usa al importar/exportar un Excel.
// cargarXLSX() devuelve una promesa que se resuelve con window.XLSX; si ya
// estaba cargado (o se está cargando) reusa la misma.
(function () {
  const URL_XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let pendiente = null;
  function cargarXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (pendiente) return pendiente;
    pendiente = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = URL_XLSX;
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX no quedó cargado')));
      // Si falla (sin internet, CDN caído) se puede reintentar en el próximo uso.
      s.onerror = () => { pendiente = null; s.remove(); reject(new Error('No se pudo descargar el lector de Excel')); };
      document.head.appendChild(s);
    });
    return pendiente;
  }
  function avisoSinXLSX(err) {
    console.error('cargarXLSX', err);
    alert('No se pudo cargar el lector de Excel. Revisá la conexión y probá de nuevo.');
  }
  window.cargarXLSX = cargarXLSX;
  window.avisoSinXLSX = avisoSinXLSX;
})();
