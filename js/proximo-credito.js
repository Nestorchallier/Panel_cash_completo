// Próximo crédito: la tabla y las reglas de la Calculadora en un solo lugar.
// La usan la Calculadora (calculadora_proximo_credito.html) y las fichas del
// cliente (clientes.html y el panel derecho de la Bandeja), así nunca se
// desfasan: si cambia la matriz de renovación, se cambia SOLO acá.
// Mismo patrón que mora.js: funciona como <script> en el navegador y con
// require() en Node.
//
// Reglas (matriz de renovación):
//   - se busca la fila igual o superior más cercana al monto del último
//     crédito, dentro del grupo según cuántos créditos tuvo el cliente;
//   - menos de 20 días de atraso: "Plan Recibo" (rango entre el tramo y el
//     máximo de la fila);
//   - 1 crédito: 20 a 54 días -> análisis manual; 55 o más -> $0;
//   - 2 y 3 créditos: 20-39 -> columna 3; 40-54 -> columna 4; 55+ -> análisis;
//   - 4 o más: 20-39 -> columna 3; 40-59 -> columna 4; 60+ -> análisis;
//   - monto por encima de la tabla -> análisis manual.

(function (raiz) {
  // Cada fila: [montoUltimaRenovacion (tramo), maxPlanRecibo(<20 días), valor(<40 días), valor(banda 3)]
  // Grupo 1: solo tramo y máximo del plan recibo (con 20 días o más no hay monto automático).
  const GRUPO_1 = [
    [160000,260000],[180000,280000],[200000,300000],[220000,320000],
    [240000,340000],[260000,360000],[280000,380000],[300000,400000]
  ];

  // Grupo 2 y 3: banda 3 = "40 a 55", más de 55 siempre "Análisis".
  const GRUPO_2Y3 = [
    [160000,360000,160000,160000],[180000,420000,160000,160000],[200000,440000,160000,160000],
    [220000,460000,160000,160000],[240000,480000,160000,160000],[260000,500000,160000,160000],
    [280000,540000,180000,160000],[300000,560000,180000,160000],[320000,580000,200000,160000],
    [340000,600000,200000,160000],[360000,640000,220000,160000],[380000,660000,220000,180000],
    [400000,680000,240000,180000],[420000,700000,260000,180000],[440000,720000,260000,200000],
    [460000,740000,280000,200000],[480000,760000,280000,220000],[500000,800000,300000,220000],
    [520000,800000,320000,240000],[540000,800000,320000,240000],[560000,800000,340000,260000],
    [580000,800000,340000,260000],[600000,800000,360000,260000],[620000,800000,380000,280000],
    [640000,800000,380000,280000],[660000,800000,400000,300000],[680000,800000,400000,300000],
    [700000,800000,420000,320000],[720000,800000,440000,320000],[740000,800000,440000,340000],
    [760000,800000,460000,340000],[780000,800000,460000,360000],[800000,800000,480000,360000]
  ];

  // Grupo 4 o más: banda 3 = "40 a 60", más de 60 siempre "Análisis".
  const GRUPO_4OMAS = [
    [160000,460000,160000,160000],[180000,480000,160000,160000],[200000,500000,180000,160000],
    [220000,520000,200000,160000],[240000,560000,200000,180000],[260000,580000,220000,200000],
    [280000,620000,240000,200000],[300000,640000,260000,220000],[320000,680000,280000,240000],
    [340000,720000,280000,260000],[360000,740000,300000,260000],[380000,780000,320000,280000],
    [400000,800000,340000,300000],[420000,800000,360000,300000],[440000,800000,360000,320000],
    [460000,800000,380000,340000],[480000,800000,400000,340000],[500000,800000,420000,360000],
    [520000,800000,440000,380000],[540000,800000,440000,400000],[560000,800000,460000,400000],
    [580000,800000,480000,420000],[600000,800000,500000,440000],[620000,800000,520000,440000],
    [640000,800000,520000,460000],[660000,800000,540000,480000],[680000,800000,560000,480000],
    [700000,800000,560000,480000],[720000,800000,440000,320000],[740000,800000,440000,340000],
    [760000,800000,460000,340000],[780000,800000,460000,360000],[800000,800000,480000,360000]
  ];

  const NOMBRE_GRUPO = { '1': '1 crédito', '2': '2 y 3 créditos', '4': '4 o más créditos' };

  // Cantidad de créditos -> grupo de la tabla ('1', '2' o '4', como los
  // botones de la Calculadora).
  function grupoDe(cantCreditos) {
    const n = Number(cantCreditos) || 0;
    return n >= 4 ? '4' : n >= 2 ? '2' : '1';
  }

  function tablaDe(grupo) {
    return grupo === '1' ? GRUPO_1 : grupo === '2' ? GRUPO_2Y3 : GRUPO_4OMAS;
  }

  // Fila igual o superior más cercana (redondeo hacia arriba).
  function buscarFila(tabla, monto) {
    for (const fila of tabla) if (monto <= fila[0]) return { fila, excedido: false };
    return { fila: tabla[tabla.length - 1], excedido: true };
  }

  // grupo: '1' | '2' | '4'. Devuelve
  // { estado: 'ok'|'revision'|'no'|'sin_datos', grupo, tramo, monto, desde, banda, motivo }
  //   - estado 'ok' con banda 'recibo': monto = máximo del plan recibo, desde = mínimo;
  //   - tramo: el monto de la fila usada (para mostrar en el desglose).
  function calcular(grupo, montoUltimo, dias) {
    const g = grupo === '2' || grupo === '4' ? grupo : '1';
    const monto = Number(montoUltimo) || 0;
    const d = Math.max(0, Number(dias) || 0);
    if (monto <= 0) return { estado: 'sin_datos', grupo: g, motivo: 'Falta el monto del último crédito' };
    const tabla = tablaDe(g);
    const { fila, excedido } = buscarFila(tabla, monto);
    const tramo = fila[0];
    if (excedido) return { estado: 'revision', grupo: g, tramo, banda: 'excedido', motivo: 'Monto mayor a la tabla' };
    if (d < 20) return { estado: 'ok', grupo: g, tramo, monto: fila[1], desde: fila[0], banda: 'recibo', motivo: 'Plan Recibo' };
    if (g === '1') {
      if (d < 55) return { estado: 'revision', grupo: g, tramo, banda: d < 40 ? '20-39' : '40-54', motivo: '1 crédito y 20 días o más' };
      return { estado: 'no', grupo: g, tramo, monto: 0, banda: 'corte', motivo: '1 crédito y 55 días o más' };
    }
    const corte = g === '2' ? 55 : 60;
    if (d < 40) return { estado: 'ok', grupo: g, tramo, monto: fila[2], banda: '20-39', motivo: 'Aprobado' };
    if (d < corte) return { estado: 'ok', grupo: g, tramo, monto: fila[3], banda: '40-' + (corte - 1), motivo: 'Aprobado' };
    return { estado: 'revision', grupo: g, tramo, banda: 'corte', motivo: `${corte} días de atraso o más` };
  }

  // Para las fichas: "¿qué crédito le damos si termina de pagar HOY?".
  // Cancelar todo lo que debe (aunque sean 4 cuotas juntas) lo deja al día,
  // así que se calcula SIEMPRE con 0 días de atraso, tenga o no atraso hoy.
  //   prestamos: todos los préstamos del cliente cargados en la base;
  //   principal: el préstamo activo (respaldo si ninguno tiene monto).
  // El "último crédito" es el más reciente (por fecha de alta) que tenga
  // monto; los que no tienen fecha (Hoja de Ruta) cuentan como más viejos.
  function alCancelarHoy(prestamos, principal) {
    const lista = (prestamos || []).slice();
    const historial = lista.sort((a, b) => String(a.fecha_alta || '').localeCompare(String(b.fecha_alta || '')));
    const ultimo = historial.slice().reverse().find(x => Number(x.monto) > 0) || principal || null;
    const cantCreditos = lista.length || (principal ? 1 : 0);
    const grupo = grupoDe(cantCreditos);
    const montoUltimo = ultimo ? Number(ultimo.monto) || 0 : 0;
    const r = calcular(grupo, montoUltimo, 0);
    return Object.assign(r, { cantCreditos, montoUltimo, dias: 0, nombreGrupo: NOMBRE_GRUPO[grupo] });
  }

  const api = { GRUPO_1, GRUPO_2Y3, GRUPO_4OMAS, NOMBRE_GRUPO, grupoDe, tablaDe, buscarFila, calcular, alCancelarHoy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.CMProximoCredito = api;
})(typeof window !== 'undefined' ? window : this);
