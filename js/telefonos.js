// Normalización de teléfonos argentinos para WhatsApp (sección 4 del plan).
// WhatsApp identifica a los celulares argentinos como 549 + código de área
// (sin el 0) + número (sin el 15). El Excel de cartera trae formatos
// variados, así que todo pasa por esta misma función antes de guardarse o
// buscarse — tanto acá en el panel como en worker/src/telefonos.js (Node).
//
// Ejemplos:
//   "011 15 4532-7781"      -> "5491145327781"
//   "(0351) 15-612-3344"    -> "5493516123344"
//   "+54 9 11 4532-7781"    -> "5491145327781"
//   "11 4532-7781"          -> "5491145327781"
function normalizarTelefonoAR(raw) {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;

  // Ya viene con 549: lo dejamos, solo validamos longitud razonable.
  if (d.startsWith('549')) {
    d = '549' + d.slice(3).replace(/^0+/, '');
  } else if (d.startsWith('54') && !d.startsWith('549')) {
    // 54 + área + número, sin el 9 móvil (pasa seguido en exports viejos).
    d = '549' + d.slice(2).replace(/^0+/, '');
  } else if (d.startsWith('9') && d.length >= 11) {
    // 9 + área + número, sin el 54.
    d = '54' + d;
  } else {
    // Formato local: 0<área>15<número> o <área>15<número> o <área><número>.
    d = d.replace(/^0/, '');
    // Saca el "15" de celular si está pegado después del código de área.
    // No hay forma 100% determinística de separar área/número sin una
    // tabla de prefijos, así que solo se saca un "15" que aparezca donde
    // típicamente separa área de número (6 a 8 dígitos antes del final).
    d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
    d = '549' + d;
  }

  // Un celular argentino con 549 tiene 13 dígitos (549 + 2 a 4 de área + 6 a 8 de número).
  if (d.length < 12 || d.length > 13) return null;
  return d;
}

// Formato lindo para mostrar en el panel. El código de área puede tener
// entre 2 y 4 dígitos según la región (11 Buenos Aires, 351 Córdoba, 2954
// Santa Rosa...) y no hay forma determinística de saber cuál es sin una
// tabla de prefijos, así que no se adivina dónde corta: se muestra el
// número completo agrupado de a 4 para que siga siendo legible.
function formatearTelefonoAR(normalizado) {
  if (!normalizado) return '';
  const resto = normalizado.slice(3); // sin 549
  const grupos = resto.match(/.{1,4}/g) || [resto];
  return `+54 9 ${grupos.join(' ')}`;
}

if (typeof window !== 'undefined') {
  window.normalizarTelefonoAR = normalizarTelefonoAR;
  window.formatearTelefonoAR = formatearTelefonoAR;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizarTelefonoAR, formatearTelefonoAR };
}
