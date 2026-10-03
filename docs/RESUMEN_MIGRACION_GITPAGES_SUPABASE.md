# CRM Panel Unificado — resumen para migrar a GitHub Pages + Supabase

## Contexto

Hoy es una sola app HTML (`Panel_Cash_Market_Unificado_8.html`) que se abre localmente
en el navegador (`file://...`) y guarda todo en `localStorage`. Funciona bien pero tiene
un problema de fondo: como el storage del navegador está atado a la ruta exacta del
archivo, cada vez que se reemplaza el archivo por una versión nueva (o se abre desde
otra carpeta), en algunos navegadores se pierde el acceso a los datos guardados.

**Objetivo de esta migración:**
1. Servir la app como sitio estático desde **GitHub Pages** (URL fija, ya no depende de
   `file://` ni de en qué carpeta esté guardado el archivo).
2. Reemplazar `localStorage` por **Supabase** (Postgres + API) como backend, para que los
   datos persistan de verdad, sobrevivan a cualquier actualización de código, y en el
   futuro se puedan consultar desde más de un dispositivo.
3. Mantener el 100% de la funcionalidad actual — es una migración de almacenamiento e
   infraestructura, no un rediseño.

## Estructura actual del código

Todo vive en un único archivo HTML con un sidebar y 5 secciones:

- **Sueldo & Cobros** — inline en el archivo principal
- **Envío de Mensajes** — inline en el archivo principal
- **Buscador de Refinanciaciones** — app aparte, embebida como `<iframe srcdoc>` con su
  HTML codificado en base64 dentro de una constante JS (`REFI_HTML_B64`)
- **Calculadora de Próximo Crédito** — mismo patrón (`CALC_HTML_B64`)
- **Kanban de Cartera** — mismo patrón (`KANBAN_HTML_B64`), es la sección más evolucionada

Las tres apps embebidas se extrajeron a archivos aparte para esta migración:
`refi_buscador.html`, `calculadora_proximo_credito.html`, `kanban_clientes.html`.
También existe `kanban_busqueda_laboral.html`, un segundo tablero Kanban (búsqueda
laboral personal) que **no** está integrado al panel — corre suelto.

Los iframes usan `srcdoc` (no `src`) para que compartan el mismo origen que el archivo
principal y, por lo tanto, el mismo `localStorage` — es el mecanismo que hoy conecta
todas las secciones entre sí sin backend.

## Inventario completo de `localStorage` (esto es lo que hay que migrar a tablas)

| Clave | Sección | Contenido |
|---|---|---|
| `panelComisionesCobros_state_v1` | Sueldo & Cobros | `{ objetivoTotal, objetivoManual, payments:[{id,name,monto,estado}], routes:[...], pendingDuplicates:[...], cutoffDate, categories:[...], scaleRows:[...], myCobrador, myRecorrido }` |
| `misClientes` | Envío de Mensajes | `[{nombre, fecha, monto, tel, telValido, enviado}]` — lista de envío de WhatsApp |
| `misPlantillas` | Envío de Mensajes | `{ "Vencimiento": "texto...", "Cuota Vencida": "...", ... }` — plantillas con placeholders `{cliente}` `{fecha}` `{monto}` `{ejecutivo}` |
| `cm_kanban_clientes_v1` | Kanban de Cartera | `{ clients: [{id, nombre, dni, monto, telefono, notas, stage, fechaPromesa, montoPagado, customFields:{fieldId:valor}}] }` |
| `cm_kanban_config_v1` | Kanban de Cartera | `{ visibleFields:{dni,monto,montoPagado,telefono,fechaPromesa}, customFields:[{id,label,color,options,optionColors}] }` — qué campos muestra cada tarjeta |
| `cm_kanban_stages_v1` | Kanban de Cartera | `[{id,name,color,protected}]` — columnas del tablero, configurables por el usuario |
| `cm_theme_v1` | Global | `"dark"` \| `"light"` |
| `wa_ejecutivo_v1` | Kanban de Cartera | nombre del ejecutivo, para autocompletar plantillas |

## Integraciones entre secciones (clave para no romper nada al migrar)

- **"Importar cobros"** (Sueldo & Cobros) matchea por nombre contra los clientes del
  Kanban y los pasa automáticamente a la columna "Cerrado (Cobrado)".
- El botón de **WhatsApp** en cada tarjeta del Kanban usa las plantillas de
  `misPlantillas` (las mismas de Envío de Mensajes).
- Al mover un cliente a "Cerrado" en el Kanban (arrastrando o editando), se pide el
  monto pagado y se suma al Registro de pagos de Sueldo & Cobros.
- **"Cargar desde Kanban (A contactar)"** en Envío de Mensajes trae los clientes de esa
  etapa del Kanban a la lista de envío.
- Dos columnas del Kanban están protegidas contra borrado porque el resto del sistema
  las referencia por id fijo: `a_contactar` y `cerrado`.

Al migrar a Supabase esto se simplifica: en vez de depender de que todo comparta
`localStorage` por estar en el mismo origen, cada sección puede leer/escribir
directamente sobre las mismas tablas.

## Funcionalidades a preservar por sección

**Sueldo & Cobros:** importar Excel (`Sueldo_Obej.xlsx`, hojas Sueldo/cobros SB/Dashboard
Objetivos), objetivo total fijable a mano, comisiones por categoría, cobros por
recorrido, registro de pagos con detección de duplicados (nombre + monto), botón
restablecer (mantiene objetivo y comisiones, vacía el resto).

**Envío de Mensajes:** carga de clientes (Excel / texto pegado / desde Kanban), envío
por WhatsApp Web con intervalo configurable y pausa/resume, plantillas editables, cruz
para sacar un cliente de la lista sin enviarle.

**Kanban de Cartera:** columnas configurables, tarjetas con campos configurables
(built-in + personalizados tipo lista desplegable con color por opción), fecha de
promesa de pago con recordatorios visuales, importación de vencimientos y de pagos,
filtros y orden, modo claro/oscuro, backup manual (exportar/importar JSON — esto deja
de ser necesario una vez que los datos vivan en Supabase).

**Buscador de Refinanciaciones** y **Calculadora de Próximo Crédito:** herramientas más
simples y autocontenidas, sin dependencias cruzadas con el resto.

## Qué se espera del trabajo de migración

1. Reestructurar el proyecto para GitHub Pages (carpeta `docs/` o rama `gh-pages`, sin
   necesariamente requerir build step — puede seguir siendo HTML/JS plano si conviene).
2. Crear en Supabase las tablas equivalentes a cada clave de `localStorage` de la tabla
   de arriba, y reemplazar cada `localStorage.getItem/setItem` por las llamadas
   correspondientes al cliente de Supabase.
3. Sumar autenticación básica (magic link o email/password), ya que los datos van a
   vivir en la nube y no solo en el navegador de quien lo abre.
4. Mantener toda la UI, textos y flujos actuales sin cambios — es una migración de
   almacenamiento, no un rediseño.

## Archivos incluidos en esta entrega

- `Panel_Cash_Market_Unificado_8.html` — archivo principal completo (shell + Sueldo &
  Cobros + Envío de Mensajes inline, con Refi/Calculadora/Kanban embebidos en base64)
- `kanban_clientes.html` — fuente del Kanban de Cartera, ya extraída
- `refi_buscador.html` — fuente del Buscador de Refinanciaciones, ya extraída
- `calculadora_proximo_credito.html` — fuente de la Calculadora, ya extraída
- `kanban_busqueda_laboral.html` — segundo tablero (búsqueda laboral), no integrado al panel
