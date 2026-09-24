/* =====================================================================
   SUITE DEL MENÚ (menu.html) · fase 0 (correcciones) + fase 1 (dinamismo)

   Qué protege, y por qué cada cosa:

   1. DINERO Y ESTADO DE CUENTA — el menú derivaba mal: fiaba del `status` guardado, así
      que una cuenta SALDADA CON ABONOS seguía apareciendo como vencida. Ahora deriva el
      saldo del importe menos los abonos, igual que `cuentas.html`.
   2. EL PANEL DE NOTIFICACIONES NO ESCRIBE — escribía `ciervo_accounts` ENTERO desde el
      snapshot de su carga solo para persistir un `status` derivado, y con eso podía
      resucitar una cuenta borrada en otra pestaña. Ahora no escribe nada.
   3. VENTAS DEL DÍA — el dashboard dice números reales del equipo. Se comprueba que el
      consumo interno NO cuenta como venta, que el fiado SÍ, que la moneda se convierte
      con la tasa de la propia venta y que el día es el UTC (la clave del índice).
   4. CARTEL DE CONEXIÓN — decía "Datos sincronizados" en verde SIEMPRE, incluso sin
      internet. Ahora pinta el estado canónico de `conexion.js`.
   5. MAQUETA Y CONEXIONES — la franja de atención con sus 4 destinos reales, las
      tarjetas con datos y SIN desbordamiento lateral (el `translateX(20px)`).
   6. MUTACIÓN — si alguien revierte una de las dos guardas clave, la suite lo dice.

   Se ejecuta con:  node pruebas_menu.js
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
const ARCHIVO = path.join(RAIZ, 'menu.html');
const MENU = fs.readFileSync(ARCHIVO, 'utf8').replace(/\r\n/g, '\n');

let ok = 0, fallos = 0;
function check(nombre, condicion, detalle) {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (detalle !== undefined && detalle !== '' ? '  -> ' + detalle : '')); }
}
function eq(nombre, obtenido, esperado) {
    check(nombre + ' = ' + JSON.stringify(esperado), obtenido === esperado,
        'se obtuvo ' + JSON.stringify(obtenido));
}
function titulo(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
/* 0. Extracción de funciones y métodos del archivo real               */
/* ------------------------------------------------------------------ */

/** Devuelve el bloque `{...}` desde la llave inicial, ignorando llaves dentro de textos. */
function extraerBloque(texto, desde) {
    let nivel = 0;
    for (let i = desde; i < texto.length; i++) {
        const c = texto[i];
        if (c === '/' && texto[i + 1] === '/') { const j = texto.indexOf('\n', i); if (j < 0) break; i = j; continue; }
        if (c === '/' && texto[i + 1] === '*') { const j = texto.indexOf('*/', i + 2); i = (j < 0 ? texto.length : j + 1); continue; }
        if (c === '"' || c === "'" || c === '`') {
            const comilla = c;
            i++;
            while (i < texto.length) {
                if (texto[i] === '\\') { i += 2; continue; }
                if (texto[i] === comilla) break;
                i++;
            }
            continue;
        }
        if (c === '{') nivel++;
        else if (c === '}') { nivel--; if (nivel === 0) return texto.slice(desde, i + 1); }
    }
    return null;
}

function extraerFuncion(nombre) {
    const m = new RegExp('function ' + nombre + '\\s*\\(').exec(MENU);
    if (!m) return null;
    const llave = MENU.indexOf('{', m.index);
    const cuerpo = extraerBloque(MENU, llave);
    return cuerpo ? MENU.slice(m.index, llave) + cuerpo : null;
}

function extraerMetodo(nombre) {
    const m = new RegExp('\\n\\s*' + nombre + '\\s*\\([^)]*\\)\\s*\\{').exec(MENU);
    if (!m) return null;
    const llave = MENU.indexOf('{', m.index);
    const cuerpo = extraerBloque(MENU, llave);
    return cuerpo ? (MENU.slice(m.index, llave) + cuerpo).trim() : null;
}

const NOMBRES_FUNCIONES = [
    'numeroSeguroLocal', 'abonadoDeCuentaLocal', 'saldoDeCuentaLocal', 'fechaHoyIsoLocal',
    'estadoDeCuentaLocal', 'formatoMonedaLocal',
    'totalDeVentaLocal', 'totalUsdDeVentaLocal', 'esConsumoInternoLocal', 'esPorCobrarLocal',
    'diaDeVentaLocal', 'resumenVentasDeHoyLocal', 'pintarEstadoConexionMenu',
    'escaparTextoLocal', 'cuentasEnAlertaLocal', 'inventarioEnAlertaLocal',
    'mantenimientoDelEquipoLocal', 'destinoProductoLocal', 'avisosDelNegocioLocal',
    'pintarCentroDeNotificaciones', 'etiquetaFuenteTasaLocal', 'formatoTasaLocal', 'fechaHoraLocal'
];

titulo('0. Las funciones del menú se pueden aislar (si no, todo lo demás no probaría nada)');
const FUENTES = {};
let faltantes = [];
NOMBRES_FUNCIONES.forEach(function (n) {
    const codigo = extraerFuncion(n);
    if (!codigo) faltantes.push(n); else FUENTES[n] = codigo;
});
check('Las 23 funciones del menú existen y se extraen enteras', faltantes.length === 0, faltantes.join(', '));
const FUENTE_NOTIFICACIONES = extraerMetodo('updateNotifications');
check('El método updateNotifications existe y se extrae entero', !!FUENTE_NOTIFICACIONES);
const FUENTE_ATENCION = extraerMetodo('actualizarAtencionHoy');
check('El método actualizarAtencionHoy existe (el dashboard con datos)', !!FUENTE_ATENCION);

/* La tabla de etiquetas del cartel es un `var` de nivel superior: se extrae aparte. */
const ETIQUETAS = (function () {
    const m = /var ETIQUETAS_CONEXION = \{[\s\S]*?\n        \};/.exec(MENU);
    return m ? m[0] : '';
})();
check('La tabla de etiquetas del cartel se extrae', ETIQUETAS.indexOf('sin-red') !== -1);

/* ------------------------------------------------------------------ */
/* Banco de pruebas: se ejecuta el código REAL del menú                */
/* ------------------------------------------------------------------ */
function banco(extra) {
    const sandbox = Object.assign({
        console: { warn: function () { }, log: function () { } },
        Date: Date, Math: Math, Number: Number, String: String, Array: Array,
        Object: Object, JSON: JSON, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat
    }, extra || {});
    vm.createContext(sandbox);
    vm.runInContext(ETIQUETAS + '\n' + NOMBRES_FUNCIONES.map(n => FUENTES[n]).filter(Boolean).join('\n'), sandbox);
    return sandbox;
}
const BANCO = banco();

/** Cuenta de prueba con lo que se quiera cambiar. */
function cuenta(extra) {
    return Object.assign({
        id: 1, type: 'cobrar', description: 'Deuda de prueba', contact: 'Ana',
        amount: 50, dueDate: '2026-01-10', payments: []
    }, extra || {});
}

/* ------------------------------------------------------------------ */
titulo('1. Dinero y estado de una cuenta: se DERIVAN, no se copian del almacén');
/* ------------------------------------------------------------------ */
eq('sin abonos, el saldo es el importe', BANCO.saldoDeCuentaLocal(cuenta()), 50);
eq('con un abono parcial de 30, el saldo es 20', BANCO.saldoDeCuentaLocal(cuenta({ payments: [{ amount: 30 }] })), 20);
eq('con abonos que cubren el importe, el saldo es 0', BANCO.saldoDeCuentaLocal(cuenta({ payments: [{ amount: 30 }, { amount: 20 }] })), 0);
eq('sobre-abonada, el saldo es negativo', BANCO.saldoDeCuentaLocal(cuenta({ payments: [{ amount: 80 }] })), -30);
eq('un abono ilegible no rompe el saldo', BANCO.saldoDeCuentaLocal(cuenta({ payments: [{ amount: 'x' }, null, { amount: 10 }] })), 40);
eq('un importe de texto se interpreta', BANCO.saldoDeCuentaLocal(cuenta({ amount: '50' })), 50);
eq('un importe ilegible cuenta como 0', BANCO.saldoDeCuentaLocal(cuenta({ amount: 'hola' })), 0);
eq('una cuenta vacía no rompe nada', BANCO.saldoDeCuentaLocal(null), 0);

eq('vencida y con saldo → overdue', BANCO.estadoDeCuentaLocal(cuenta(), '2026-02-01'), 'overdue');
eq('con saldo y sin llegar la fecha → pending', BANCO.estadoDeCuentaLocal(cuenta(), '2026-01-01'), 'pending');
eq('el mismo día del vencimiento todavía no está vencida', BANCO.estadoDeCuentaLocal(cuenta(), '2026-01-10'), 'pending');
eq('SALDADA con abonos y vencida → paid (era el fallo: salía como vencida)',
    BANCO.estadoDeCuentaLocal(cuenta({ payments: [{ amount: 50 }] }), '2026-02-01'), 'paid');
eq('el status guardado NO manda sobre el saldo',
    BANCO.estadoDeCuentaLocal(cuenta({ status: 'pending', payments: [{ amount: 50 }] }), '2026-02-01'), 'paid');
eq('sin fecha de vencimiento y con saldo → pending',
    BANCO.estadoDeCuentaLocal(cuenta({ dueDate: '' }), '2026-02-01'), 'pending');

eq('el importe se escribe con dos decimales', BANCO.formatoMonedaLocal(50), '$50.00');
eq('un importe ausente no revienta la pantalla', BANCO.formatoMonedaLocal(undefined), '$0.00');
eq('un importe nulo no revienta la pantalla', BANCO.formatoMonedaLocal(null), '$0.00');
eq('un importe de texto no revienta la pantalla', BANCO.formatoMonedaLocal('hola'), '$0.00');
eq('un importe NaN no revienta la pantalla', BANCO.formatoMonedaLocal(NaN), '$0.00');
eq('el "hoy" del menú es el día UTC (igual que cuentas.html)',
    BANCO.fechaHoyIsoLocal(), new Date().toISOString().split('T')[0]);

/* ------------------------------------------------------------------ */
titulo('2. Avisos del negocio: un solo cálculo, accionables y sin inventar datos');
/* ------------------------------------------------------------------ */
const SALDADA = cuenta({ id: 2, description: 'CUENTA YA PAGADA', dueDate: '2020-01-01', payments: [{ amount: 50 }] });
const VENCIDA = cuenta({ id: 3, description: 'CUENTA VENCIDA REAL', dueDate: '2020-01-01' });
const ABONADA = cuenta({ id: 4, description: 'CUENTA A MEDIAS', dueDate: '2020-01-01', payments: [{ amount: 30 }] });
const VENCE_HOY = cuenta({ id: 5, description: 'VENCE HOY MISMO', dueDate: BANCO.fechaHoyIsoLocal() });
const SUCIA = cuenta({ id: 6, description: 'CUENTA CON IMPORTE SUCIO', dueDate: '2020-01-01', amount: 'no es un número' });

const ALERTA = BANCO.cuentasEnAlertaLocal([SALDADA, VENCIDA, ABONADA, VENCE_HOY, SUCIA], BANCO.fechaHoyIsoLocal());
check('La cuenta SALDADA con abonos no entra en las alertas (era el fallo)',
    ALERTA.vencidas.concat(ALERTA.vencenHoy).every(c => c.description !== 'CUENTA YA PAGADA'));
eq('Vencidas: 2 (la vencida y la de a medias)', ALERTA.vencidas.length, 2);
eq('El saldo vencido es 50 + 20 = 70', ALERTA.saldoVencido, 70);
eq('Vence hoy: 1', ALERTA.vencenHoy.length, 1);
eq('…y su saldo es 50', ALERTA.saldoVenceHoy, 50);
check('Las vencidas van ordenadas por fecha de vencimiento',
    String(ALERTA.vencidas[0].dueDate) <= String(ALERTA.vencidas[1].dueDate));
check('Una cuenta con importe ilegible sale saldada (no es deuda)',
    ALERTA.vencidas.concat(ALERTA.vencenHoy).every(c => c.id !== 6));
eq('Sin cuentas no hay alertas', BANCO.cuentasEnAlertaLocal(null, '2026-01-01').vencidas.length, 0);

const INV = BANCO.inventarioEnAlertaLocal([
    { id: 1, name: 'OK', stock: 10, minStock: 2, price: 3 },
    { id: 2, name: 'BAJO', stock: 2, minStock: 5, price: 2 },
    { id: 3, name: 'AGOTADO', stock: 0, minStock: 3, price: 7 },
    { id: 4, name: 'A GRANEL', stock: 1, minStock: 2, price: null }
]);
eq('Agotados: 1', INV.agotados.length, 1);
eq('Bajo mínimo: 2 (el bajo y el de granel)', INV.bajos.length, 2);
eq('Total de productos: 4', INV.total, 4);
eq('Valor del stock (un precio ausente cuenta 0)', INV.valor, 3 * 10 + 2 * 2);

const AVISOS = BANCO.avisosDelNegocioLocal({ cuentas: ALERTA, inventario: INV, mantenimiento: {} });
eq('Total de avisos: 2 vencidas + 1 vence hoy + 1 agotado + 2 bajos = 6', AVISOS.length, 6);
check('Cada aviso dice su grupo, a qué pantalla lleva y qué se hace allí',
    AVISOS.every(a => a.grupo && a.destino && a.accion && a.titulo && a.detalle));
check('El aviso de una cuenta lleva a ESA cuenta (enlace profundo ?id=)',
    AVISOS.some(a => a.destino === 'cuentas.html?id=3&tipo=cobrar'),
    JSON.stringify(AVISOS.filter(a => a.grupo === 'Cobros y pagos').map(a => a.destino)));
check('Una cuenta por pagar usa tipo=pagar', (function () {
    const a = BANCO.avisosDelNegocioLocal({
        cuentas: { vencidas: [cuenta({ id: 9, type: 'pagar' })], vencenHoy: [] },
        inventario: { agotados: [], bajos: [] }, mantenimiento: {}
    });
    return a.length === 1 && a[0].destino === 'cuentas.html?id=9&tipo=pagar';
})());
check('Los avisos de inventario llevan AL PRODUCTO (no a la lista entera)',
    AVISOS.filter(a => a.grupo === 'Inventario').every(a => a.destino.indexOf('inventario.html?id=') === 0),
    JSON.stringify(AVISOS.filter(a => a.grupo === 'Inventario').map(a => a.destino)));
check('…con el id del producto correcto',
    AVISOS.filter(a => a.grupo === 'Inventario').map(a => a.destino).indexOf('inventario.html?id=3') !== -1 &&
    AVISOS.filter(a => a.grupo === 'Inventario').every(a => a.accion === 'Ver el producto'));
check('Un producto SIN id no produce un enlace roto: cae a la lista entera',
    BANCO.destinoProductoLocal({ name: 'sin id' }) === 'inventario.html' &&
    BANCO.destinoProductoLocal(null) === 'inventario.html');
check('Un id con caracteres raros se codifica (no rompe la URL)',
    BANCO.destinoProductoLocal({ id: 'a b/c' }).indexOf('a%20b%2Fc') !== -1,
    BANCO.destinoProductoLocal({ id: 'a b/c' }));
check('Severidad: vencido y agotado son alta; bajo mínimo es media',
    AVISOS.filter(a => a.titulo === 'AGOTADO')[0].severidad === 'alta' &&
    AVISOS.filter(a => a.titulo === 'CUENTA VENCIDA REAL')[0].severidad === 'alta' &&
    AVISOS.filter(a => a.titulo === 'BAJO')[0].severidad === 'media');

eq('Sin datos de mantenimiento NO se inventa ningún aviso',
    BANCO.avisosDelNegocioLocal({ cuentas: { vencidas: [], vencenHoy: [] }, inventario: { agotados: [], bajos: [] }, mantenimiento: {} }).length, 0);
eq('Con copia hecha hoy no se avisa', BANCO.avisosDelNegocioLocal({ mantenimiento: { diasSinCopia: 0 } }).length, 0);
check('Nunca se ha copiado: aviso de severidad alta y lleva a configurar', (function () {
    const a = BANCO.avisosDelNegocioLocal({ mantenimiento: { diasSinCopia: Infinity, ultimaCopia: 'nunca' } });
    return a.length === 1 && a[0].destino === 'config.html' && a[0].severidad === 'alta';
})());
check('Hace 3 días de la copia: todavía no se avisa',
    BANCO.avisosDelNegocioLocal({ mantenimiento: { diasSinCopia: 3 } }).length === 0);
check('Almacenamiento al límite: aviso y lleva a configurar', (function () {
    const a = BANCO.avisosDelNegocioLocal({ mantenimiento: { almacenamiento: { estado: 'casi', texto: '12 MB de 1 GB · Casi lleno' } } });
    return a.length === 1 && a[0].destino === 'config.html' && a[0].titulo.indexOf('casi lleno') !== -1;
})());
/* --- Cambio de tasa automático: la detección, con almacenes de mentira --- */
const MS_TASA = Date.parse('2026-06-10T12:00:00Z');
function tasaCon(almacen) {
    const sandbox = banco({
        localStorage: { getItem: function (k) { return almacen[k] === undefined ? null : almacen[k]; } },
        window: {}
    });
    vm.runInContext('var _mantenimientoCache = { cuando: 0, datos: null };', sandbox);
    vm.runInContext(FUENTES.mantenimientoDelEquipoLocal, sandbox);
    return sandbox.mantenimientoDelEquipoLocal(MS_TASA);
}
const MUESTRA = (dias, valor, extra) => Object.assign({ t: MS_TASA - dias * 86400000, v: valor }, extra || {});

const CAMBIO = tasaCon({
    pos_rate_source: 'bcv',
    pos_rate_history: JSON.stringify({ bcv: [MUESTRA(2, 36.5), MUESTRA(0.04, 38.2)] })
});
eq('Detecta el valor nuevo', CAMBIO.tasaActual, 38.2);
eq('…y el anterior', CAMBIO.tasaAnterior, 36.5);
eq('…de la fuente que usa el POS', CAMBIO.tasaFuente, 'bcv');
check('…y lo marca como cambio reciente', CAMBIO.tasaCambioReciente === true);
check('…y sabe que hay muestra de hoy', CAMBIO.tasaAlDia === true);

const VIEJO = tasaCon({
    pos_rate_source: 'bcv',
    pos_rate_history: JSON.stringify({ bcv: [MUESTRA(20, 36.5), MUESTRA(10, 38.2)] })
});
check('Un cambio de hace 10 días ya NO es noticia', VIEJO.tasaCambioReciente === false);
check('…aunque el dato se lea igual', VIEJO.tasaActual === 38.2 && VIEJO.tasaAnterior === 36.5);

const IGUAL = tasaCon({
    pos_rate_source: 'bcv',
    pos_rate_history: JSON.stringify({ bcv: [MUESTRA(1, 38.2), MUESTRA(0.04, 38.2)] })
});
check('Sin cambio de valor no hay aviso de cambio', IGUAL.tasaCambioReciente === false);

const SOLO_UNA = tasaCon({
    pos_rate_source: 'bcv',
    pos_rate_history: JSON.stringify({ bcv: [MUESTRA(0.04, 38.2)] })
});
check('Con una sola muestra no se inventa un cambio', SOLO_UNA.tasaCambioReciente === false && SOLO_UNA.tasaAnterior === null);

const CON_SERIE = tasaCon({
    pos_rate_source: 'bcv',
    pos_rate_history: JSON.stringify({
        bcv: [MUESTRA(1, 36.5), MUESTRA(0.04, 38.2, { serie: 'oficial' })]
    })
});
check('La serie histórica sembrada (con marca serie) NO cuenta como cambio automático',
    CON_SERIE.tasaCambioReciente === false && CON_SERIE.tasaActual === 36.5,
    JSON.stringify({ reciente: CON_SERIE.tasaCambioReciente, actual: CON_SERIE.tasaActual }));

const ELIGE_FUENTE = tasaCon({
    pos_rate_source: 'binance',
    pos_rate_history: JSON.stringify({
        bcv: [MUESTRA(9, 30), MUESTRA(8, 31)],
        binance: [MUESTRA(0.2, 40), MUESTRA(0.04, 42)]
    })
});
check('Se informa de la fuente que el POS está usando (binance)', ELIGE_FUENTE.tasaFuente === 'binance', ELIGE_FUENTE.tasaFuente);
const SIN_FUENTE = tasaCon({
    pos_rate_history: JSON.stringify({
        bcv: [MUESTRA(9, 30), MUESTRA(8, 31)],
        binance: [MUESTRA(0.2, 40), MUESTRA(0.04, 42)]
    })
});
check('Sin fuente configurada se elige la que tenga dato más reciente', SIN_FUENTE.tasaFuente === 'binance', SIN_FUENTE.tasaFuente);

const AVISO_TASA = BANCO.avisosDelNegocioLocal({ mantenimiento: CAMBIO });
eq('El cambio genera UN aviso, en su grupo', AVISO_TASA.length, 1);
eq('…en el grupo de la tasa', AVISO_TASA[0].grupo, 'Tasa del día');
check('…que dice de cuánto a cuánto y que subió',
    AVISO_TASA[0].titulo.indexOf('36,50') !== -1 && AVISO_TASA[0].titulo.indexOf('38,20') !== -1 &&
    AVISO_TASA[0].titulo.indexOf('subió') !== -1, AVISO_TASA[0].titulo);
check('…con la fuente, el porcentaje y que fue automática',
    AVISO_TASA[0].detalle.indexOf('BCV') !== -1 && AVISO_TASA[0].detalle.indexOf('+') !== -1 &&
    AVISO_TASA[0].detalle.indexOf('automáticamente') !== -1, AVISO_TASA[0].detalle);
eq('…y lleva al POS a verla', AVISO_TASA[0].destino, 'mini_market_pos.html');
const AVISO_BAJA = BANCO.avisosDelNegocioLocal({
    mantenimiento: { tasaCambioReciente: true, tasaAnterior: 40, tasaActual: 38, tasaFuente: 'euro', tasaCuando: MS_TASA }
});
check('Si baja, lo dice y el porcentaje va en negativo',
    AVISO_BAJA[0].titulo.indexOf('bajó') !== -1 && AVISO_BAJA[0].detalle.indexOf('-5,00%') !== -1,
    AVISO_BAJA[0].titulo + ' | ' + AVISO_BAJA[0].detalle);
check('Con cambio reciente NO se añade además el aviso de "sin actualizar"',
    BANCO.avisosDelNegocioLocal({ mantenimiento: { tasaCambioReciente: true, tasaAnterior: 40, tasaActual: 38, tasaAlDia: false } }).length === 1);
eq('El número de tasa se escribe en formato español', BANCO.formatoTasaLocal(36.5), '36,50');
eq('…y una tasa ilegible no rompe el aviso', BANCO.formatoTasaLocal('hola'), '—');
eq('La fuente se traduce al nombre que usa el POS', BANCO.etiquetaFuenteTasaLocal('bcv'), 'Dólar (BCV Oficial)');
eq('…y una fuente desconocida se muestra tal cual', BANCO.etiquetaFuenteTasaLocal('otra'), 'otra');

check('La tasa sin muestra de hoy: aviso y lleva al POS', (function () {
    const a = BANCO.avisosDelNegocioLocal({ mantenimiento: { tasaAlDia: false, tasaUltima: '2026-01-01' } });
    return a.length === 1 && a[0].destino === 'mini_market_pos.html';
})());
check('Con la tasa actualizada hoy no se avisa',
    BANCO.avisosDelNegocioLocal({ mantenimiento: { tasaAlDia: true } }).length === 0);

eq('El texto se escapa para el HTML (antes iba crudo)',
    BANCO.escaparTextoLocal('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
eq('…también comillas y ampersand', BANCO.escaparTextoLocal('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');

function pintarCon(avisos) {
    const pintado = { list: '', badge: '', titulo: '', vacio: '', aria: null };
    const nodo = function (clave) {
        return { set innerHTML(v) { pintado[clave] = v; }, get innerHTML() { return pintado[clave]; },
                 set textContent(v) { pintado[clave] = v; }, get textContent() { return pintado[clave]; } };
    };
    const documento = {
        getElementById: function (id) {
            if (id === 'notificationList') return nodo('list');
            if (id === 'tituloNotificaciones') return nodo('titulo');
            if (id === 'notificationEmpty') return { hidden: false, set innerHTML(v) { pintado.vacio = v; }, get innerHTML() { return pintado.vacio; } };
            if (id === 'notificationBadge') return { hidden: null, set textContent(v) { pintado.badge = v; }, get textContent() { return pintado.badge; } };
            if (id === 'botonNotificaciones') return { setAttribute: function (k, v) { if (k === 'aria-label') pintado.aria = v; } };
            return null;
        }
    };
    const sandbox = banco({ document: documento });
    const total = vm.runInContext('pintarCentroDeNotificaciones', sandbox)(avisos);
    return { pintado: pintado, total: total };
}
const P = pintarCon(AVISOS);
eq('El pintor devuelve el total de avisos', P.total, 6);
check('Los grupos llevan su contador',
    P.pintado.list.indexOf('Cobros y pagos (3)') !== -1 && P.pintado.list.indexOf('Inventario (3)') !== -1,
    P.pintado.list.slice(0, 160));
check('Cada aviso es un BOTÓN con su acción',
    (P.pintado.list.match(/<button type="button" class="notification-item/g) || []).length === 6 &&
    P.pintado.list.indexOf('Ver la cuenta →') !== -1);
eq('El título del panel lleva el total', P.pintado.titulo, 'Notificaciones (6)');
check('El contador se anuncia en el aria-label del botón (no solo con el color)',
    String(P.pintado.aria).indexOf('6 pendientes') !== -1, String(P.pintado.aria));
check('Un texto con HTML se pinta escapado',
    pintarCon([{ grupo: 'X', titulo: '<b>hola</b>', detalle: '', destino: 'inventario.html', accion: 'Ver' }]).pintado.list.indexOf('&lt;b&gt;hola&lt;/b&gt;') !== -1);
const INYECCION = pintarCon([{ grupo: 'X', titulo: 't', detalle: '', destino: 'inventario.html" onmouseover="alert(1)', accion: 'Ver' }]).pintado.list;
check('Un destino manipulado no puede cerrar el onclick (su comilla no sobrevive)',
    (INYECCION.match(/&quot;/g) || []).length === 2,
    'comillas escapadas encontradas: ' + (INYECCION.match(/&quot;/g) || []).length);
const VACIO = pintarCon([]);
eq('Sin avisos el contador queda en 0 (y se oculta)', VACIO.pintado.badge, '0');
check('…y el estado vacío dice qué se vigila', 
    VACIO.pintado.vacio.indexOf('Todo al día') !== -1 && VACIO.pintado.vacio.indexOf('tasa del día') !== -1);
eq('…y el título no lleva contador', VACIO.pintado.titulo, 'Notificaciones');

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
titulo('3. Las ventas del día: consumo interno fuera, fiado dentro, moneda convertida');
/* ------------------------------------------------------------------ */
const HOY = '2026-05-20';
const MS_HOY = Date.parse(HOY + 'T15:00:00Z');
function venta(extra) {
    return Object.assign({ id: 'V', timestamp: HOY + 'T10:00:00Z', currency: 'USD', exchangeRate: 40, totals: { total: 0 }, paymentMethod: 'efectivo' }, extra || {});
}
const VENTAS = [
    venta({ id: 'V1', totals: { total: 30 } }),                                        // venta normal en USD
    venta({ id: 'V2', currency: 'VES', totals: { total: 400 }, exchangeRate: 40 }),    // 400 Bs / 40 = 10 USD
    venta({ id: 'V3', totals: { total: 100 }, consumoInterno: true }),                 // NO es venta
    venta({ id: 'V4', totals: { total: 20 }, porCobrar: true }),                       // es venta, y es fiado
    venta({ id: 'V5', totals: { total: 999 }, timestamp: '2026-05-19T10:00:00Z' }),    // de ayer: fuera
    venta({ id: 'V6', totals: { total: 999 }, timestamp: '' }),                        // sin fecha: fuera
    venta({ id: 'V7', totals: { total: 77 }, paymentMethod: 'consumo-interno' }),      // sin bandera, por método
    { id: 'V8' }                                                                      // basura: fuera
];
const RESUMEN = BANCO.resumenVentasDeHoyLocal(VENTAS, MS_HOY);
eq('cuenta 3 ventas de hoy (ni consumo interno, ni ayer, ni basura)', RESUMEN.cantidad, 3);
eq('el total es 60 USD (30 + 10 Bs convertidos + 20 del fiado)', RESUMEN.totalUSD, 60);
eq('los fiados de hoy son 1', RESUMEN.fiados, 1);
eq('el importe fiado es 20 USD', RESUMEN.fiadosUSD, 20);
eq('el ticket medio es 20 USD', RESUMEN.ticketMedio, 20);
eq('el día del resumen es el UTC de la ventana pedida', RESUMEN.dia, HOY);
eq('sin ventas, el resumen queda a cero y sin división por cero',
    JSON.stringify(BANCO.resumenVentasDeHoyLocal([], MS_HOY)),
    JSON.stringify({ dia: HOY, cantidad: 0, totalUSD: 0, fiados: 0, fiadosUSD: 0, ticketMedio: 0 }));
eq('una lista corrupta (no arreglo) no rompe el resumen',
    BANCO.resumenVentasDeHoyLocal(null, MS_HOY).cantidad, 0);
eq('una venta a granel con total en `total` (sin totals) sí se cuenta',
    BANCO.resumenVentasDeHoyLocal([{ id: 'X', timestamp: HOY + 'T09:00:00Z', total: 5, currency: 'USD' }], MS_HOY).totalUSD, 5);
eq('sin tasa, una venta en Bs se cuenta tal cual (no se inventa conversión)',
    BANCO.resumenVentasDeHoyLocal([venta({ id: 'Y', currency: 'VES', totals: { total: 400 }, exchangeRate: 0 })], MS_HOY).totalUSD, 400);

/* ------------------------------------------------------------------ */
titulo('4. El cartel de conexión pinta el estado canónico, no un texto fijo');
/* ------------------------------------------------------------------ */
function correrCartel(estado) {
    const visto = { texto: null, fondo: null, atributos: {} };
    const nodos = {
        syncIndicator: { setAttribute: function (k, v) { visto.atributos[k] = v; } },
        syncDot: { style: { set background(v) { visto.fondo = v; } } },
        syncText: { set textContent(v) { visto.texto = v; } }
    };
    const sandbox = banco({
        document: { getElementById: function (id) { return nodos[id] || null; } },
        window: { conexion: { estado: function () { return estado; } } }
    });
    vm.runInContext('pintarEstadoConexionMenu()', sandbox);
    return visto;
}
const SIN_RED = correrCartel({ clave: 'sin-red', color: '#ef4444', titulo: 'Sin internet: los cambios se guardan en este equipo' });
eq('sin internet, el cartel dice la verdad', SIN_RED.texto, 'Sin internet');
eq('y usa el color canónico', SIN_RED.fondo, '#ef4444');
eq('y deja el estado en el atributo (para poder comprobarlo)', SIN_RED.atributos['data-estado'], 'sin-red');
check('el texto canónico completo queda en el title',
    String(SIN_RED.atributos.title || '').indexOf('Sin internet: los cambios se guardan') === 0);
const AL_DIA = correrCartel({ clave: 'al-dia', color: '#22c55e', titulo: 'Todo subido a la nube' });
eq('con la nube al día, dice "Al día"', AL_DIA.texto, 'Al día');
const SIN_COMPROBAR = correrCartel({ clave: 'sin-comprobar', color: '#6b7280', titulo: 'Estado de la nube: sin comprobar' });
eq('sin poder comprobar la nube, lo dice (no finge)', SIN_COMPROBAR.texto, 'Sin comprobar');
/* Sin comentarios: si no, la propia explicación de lo que se quitó daría el check por bueno.
   Solo se quitan bloques y líneas que EMPIEZAN por `//`, para no tocar las URL. */
function sinComentarios(texto) {
    return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const MENU_VIVO = sinComentarios(MENU);
check('El cartel arranca sin prometer nada (nada de "Datos sincronizados" VIVO: ni texto ni cadena)',
    MENU_VIVO.indexOf('Datos sincronizados') === -1,
    'aparece en código, no solo en un comentario');
check('El cartel muestra su estado inicial honesto en el HTML',
    MENU.indexOf('<span id="syncText">Estado de la nube: sin comprobar</span>') !== -1);
check('menu.html sigue SIN el punto #firebaseDot (T30b: no puede saber el estado de la nube)',
    MENU.indexOf('id="firebaseDot"') === -1);
check('menu.html carga conexion.js y ANTES de sesion.js (el estado está disponible)',
    MENU.indexOf('src="conexion.js"') !== -1 && MENU.indexOf('src="conexion.js"') < MENU.indexOf('src="sesion.js"'));

/* ------------------------------------------------------------------ */
titulo('5. Maqueta y conexiones: la franja, los destinos y el desborde');
/* ------------------------------------------------------------------ */
/* Sin comentarios: si no, la propia explicación de lo que se quitó daría el check por bueno. */
const CSS_VISTA = MENU.slice(MENU.indexOf('.module-view {'), MENU.indexOf('.module-view {') + 900)
    .replace(/\/\*[\s\S]*?\*\//g, '');
check('La vista del módulo ya NO se desplaza 20 px (causa del desborde lateral)',
    CSS_VISTA.indexOf('translateX(20px)') === -1);
check('…y sigue siendo una vista superpuesta con transición',
    /position:\s*absolute/.test(CSS_VISTA) && /transition:/.test(CSS_VISTA));
check('Existe la franja de atención', MENU.indexOf('id="atencionHoy"') !== -1);

{
    const iModulos = MENU.indexOf('class="main-modules"');
    const iFranja = MENU.indexOf('id="atencionHoy"');
    const iAccesos = MENU.indexOf('class="secondary-modules"');
    check('La franja va DESPUÉS de los módulos principales (el bloque «Acceso rápido»)',
        iModulos !== -1 && iFranja > iModulos, 'modulos=' + iModulos + ' franja=' + iFranja);
    check('…y ANTES de los accesos de abajo',
        iAccesos !== -1 && iFranja < iAccesos, 'franja=' + iFranja + ' accesos=' + iAccesos);
}

const FICHAS = (MENU.match(/class="atencion-ficha"/g) || []).length;
eq('La franja tiene 4 fichas (ni una más: no se inventan datos que el equipo no tiene)', FICHAS, 4);
const DESTINOS = (MENU.match(/abrirFichaAtencion\('([^']+)'\)/g) || [])
    .map(s => s.replace("abrirFichaAtencion('", '').replace("')", ''))
    .map(s => s.replace(/&amp;/g, '&'));
eq('Los destinos de las fichas llevan el filtro puesto',
    JSON.stringify(DESTINOS),
    JSON.stringify([
        'cuentas.html?estado=overdue',
        'cuentas.html?estado=pending&orden=vencimiento',
        'inventario.html',
        'cuentas.html?origen=pos'
    ]));
check('Los destinos existen de verdad: cuentas.html acepta estado/origen/orden',
    ['estado=overdue', 'estado=pending&orden=vencimiento', 'origen=pos'].every(function (q) {
        const filtro = q.split('&')[0].split('=')[0];
        return MENU.indexOf('atencionHoy') !== -1 && fs.readFileSync(path.join(RAIZ, 'cuentas.html'), 'utf8')
            .indexOf("params.get('" + filtro + "')") !== -1;
    }));
check('Las 4 fichas tienen su número y su detalle (ids para poder comprobarlas)',
    ['atencionVencidas', 'atencionVencenHoy', 'atencionSinStock', 'atencionFiados'].every(id => MENU.indexOf('id="' + id + '"') !== -1));

check('Las 3 tarjetas de módulo ya NO dicen "Disponible"',
    ['estadoOperaciones', 'estadoInventario', 'estadoResumen'].every(id => MENU.indexOf('id="' + id + '"') !== -1) &&
    (MENU.match(/<span class="status-text" id="estado/g) || []).length === 3);
check('Las cifras de ventas dicen que son de ESTE equipo (no afirman el total del negocio)',
        /USD en ventas de este equipo/.test(MENU) && /ticket\(s\) de este equipo/.test(MENU) &&
        /fiado hoy · este equipo/.test(MENU) && /Sin fiados hoy en este equipo/.test(MENU));
check('…y se entiende por qué: el menú lee solo el pos_sales del equipo, no el lector canónico',
    /leerListaLocal\('pos_sales'\)/.test(MENU) && MENU.indexOf('lectorVentas') === -1);

check('Cada tarjeta tiene su línea de datos reales',
    ['datosOperaciones', 'datosInventario', 'datosResumen'].every(id => MENU.indexOf('id="' + id + '"') !== -1));
{
    const iGlobal = MENU.indexOf('updateGlobalUI() {');
    const iCampana = MENU.indexOf('// Update notifications on UI load');
    const iLlamada = MENU.indexOf('this.actualizarAtencionHoy();', iCampana);
    check('La atención se pinta al CARGAR la interfaz (SystemManager), junto al refresco de la campana',
        iGlobal > -1 && iCampana > iGlobal && iLlamada > iCampana && (iLlamada - iCampana) < 220,
        'updateGlobalUI=' + iGlobal + ' campana=' + iCampana + ' llamada=' + iLlamada);
    /* Este fue un fallo REAL que solo vio la suite de navegador: la llamada estaba dentro
       de `initialize()` de InventoryManager, donde `this` no es el sistema, y la franja se
       quedaba en "Leyendo…" con "this.actualizarAtencionHoy is not a function". */
    check('…y NO se llama desde InventoryManager.initialize() (ahí `this` no es el sistema)',
        !/initialize\(\) \{[\s\S]{0,220}this\.actualizarAtencionHoy\(\);/.test(MENU));
}
check('…y se repinta cuando cambian las cuentas o el inventario',
    /if \(store === 'accounts' \|\| store === 'inventory'\) \{[\s\S]{0,80}this\.actualizarAtencionHoy\(\);/.test(MENU));
check('El menú sigue SIN escribir ciervo_accounts (un solo escritor: cuentas.html)',
    !/^\s*this\.saveData\('accounts'\);/m.test(MENU));
check('El guardián de cuota sigue protegiendo las escrituras del menú',
    /guardarLocalSeguro/.test(MENU) && /saveData\(store\) \{/.test(MENU));

/* ------------------------------------------------------------------ */
titulo('6. Diseño medido: alineación, teclado y personalización de accesos');
/* ------------------------------------------------------------------ */
{
    const CSS = MENU_VIVO;
    check('El contenido del dashboard NO pierde su margen lateral (estaba desalineado con la cabecera)',
        /\.dashboard-content\s*\{[^}]*padding:\s*2rem 1\.5rem/.test(CSS),
        'la regla .dashboard-content debe conservar el relleno horizontal');
    check('Los módulos y accesos se pueden enfocar con el teclado (role + tabindex + Enter/espacio)',
        /function hacerAccesosPulsablesConTeclado\(\)/.test(MENU) &&
        /setAttribute\('role', 'button'\)/.test(MENU) &&
        /setAttribute\('tabindex', '0'\)/.test(MENU) &&
        /ev\.key === 'Enter' \|\| ev\.key === ' '/.test(MENU));
    check('Hay un contorno visible al enfocar (quien navega con el teclado ve dónde está)',
        /\.module-card:focus-visible/.test(CSS) && /\.secondary-item:focus-visible/.test(CSS));
    check('El aviso «hacer clic» deja de depender del ratón en pantallas táctiles',
        /@media \(hover: none\)/.test(CSS) && /\.hover-text \{ opacity: 1; \}/.test(CSS));
    check('Con rol Vendedor no se ofrece personalizar y lo deshabilitado no se puede enfocar',
        /botonPersonalizarVendedor\.hidden = true/.test(MENU) &&
        /item\.removeAttribute\('tabindex'\)/.test(MENU));

    check('Existe el botón Personalizar con su estado accesible', MENU.indexOf('id="botonPersonalizar"') !== -1 &&
        /aria-pressed="false"/.test(MENU));
    check('Personalizar/Restablecer se ven como ENLACE subrayado, no como recuadro',
        /\.btn-personalizar \{[\s\S]{0,400}text-decoration: underline/.test(CSS) &&
        /\.btn-personalizar \{[\s\S]{0,400}background: none/.test(CSS) &&
        /\.btn-personalizar \{[\s\S]{0,400}border: 0/.test(CSS) &&
        !/\.btn-personalizar \{[\s\S]{0,400}border: 1px solid/.test(CSS));
    check('…pero sigue siendo un <button> (teclado y lector de pantalla)',
        /<button type="button" class="btn-personalizar" id="botonPersonalizar"/.test(MENU) &&
        /<button type="button" class="btn-personalizar" id="botonRestablecer"/.test(MENU));

    /* El correo del DUEÑO: en un panel desplegable, para no ensanchar el header. */
    check('El correo vive en un panel desplegable, no en una línea del header',
        /<div class="user-panel" id="userPanel" hidden>/.test(MENU) &&
        /<p class="user-panel-correo" id="user-email">/.test(MENU) &&
        !/class="user-email"/.test(MENU));
    check('El bloque de usuario es el disparador y declara su estado',
        /class="user-info" id="userInfo" onclick="alternarPanelUsuario\(\)"/.test(MENU) &&
        /aria-expanded="false" aria-controls="userPanel"/.test(MENU));
    check('El panel se abre, se cierra al pulsar fuera y con Escape',
        /function alternarPanelUsuario\(\)/.test(MENU) &&
        /function panelUsuarioAbierto\(\)/.test(MENU) &&
        /if \(ev\.key === 'Escape'\) pintarPanelUsuario\(false\)/.test(MENU) &&
        /!disparador\.contains\(ev\.target\)\) pintarPanelUsuario\(false\)/.test(MENU));
    check('Se puede copiar el correo sin cerrar el panel (la propagación se corta)',
        /function copiarCorreoDelDueno\(ev\)/.test(MENU) && /ev\.stopPropagation\(\)/.test(MENU));
    check('…y el correo se rellena al pintar la interfaz (updateGlobalUI)',
        /correoElemento\.textContent = correo \|\| 'Sin correo de dueño'/.test(MENU) &&
        /if \(accionCopiar\) accionCopiar\.hidden = !correo;/.test(MENU));
    check('El header sigue compacto: el disparador es el bloque de usuario (152 px), no una línea más',
        /\.user-info \{ position: relative; cursor: pointer; \}/.test(CSS) &&
        /\.user-panel\[hidden\] \{ display: none !important; \}/.test(CSS));

    const FUENTE_CORREO = extraerFuncion('correoDelDueno');
    check('La lectura del correo se puede aislar', !!FUENTE_CORREO);
    function correoCon(almacen, sesion) {
        const sandbox = banco({
            localStorage: { getItem: function (k) { return almacen[k] === undefined ? null : almacen[k]; } },
            sessionStorage: { getItem: function (k) { return sesion[k] === undefined ? null : sesion[k]; } }
        });
        vm.runInContext(FUENTE_CORREO, sandbox);
        return sandbox.correoDelDueno();
    }
    eq('el correo del dueño se lee de la sesión compartida',
        correoCon({ sesionActiva: '{"email":"dueno@negocio.com","uid":"x"}' }, {}), 'dueno@negocio.com');
    eq('si la marca está corrupta, se usa propietarioActual',
        correoCon({ sesionActiva: '{roto' }, { propietarioActual: 'otro@negocio.com' }), 'otro@negocio.com');
    eq('y si no, currentOwner',
        correoCon({}, { currentOwner: '{"email":"tercero@negocio.com"}' }), 'tercero@negocio.com');
    eq('sin ninguna marca no se inventa nada', correoCon({}, {}), '');
    eq('una sesión sin correo cae al respaldo',
        correoCon({ sesionActiva: '{"uid":"x"}' }, { propietarioActual: 'respaldo@negocio.com' }), 'respaldo@negocio.com');
    check('Existe Restablecer y empieza oculto (solo aparece si hay cambios)',
        /id="botonRestablecer"[\s\S]{0,80}hidden/.test(MENU));
    check('La disposición se guarda con el guardián de cuota, bajo su propia clave',
        /CLAVE_DISPOSICION = 'ciervo_menu_disposicion'/.test(MENU) &&
        /guardarLocalSeguro\(CLAVE_DISPOSICION, serializado\)/.test(MENU));
    check('Los botones de edición cortan la propagación (pulsarlos NO debe abrir el módulo)',
        /ev\.stopPropagation\(\)/.test(MENU));
    check('Reordenar y ocultar se aplican sobre los 11 accesos declarados',
        /IDS_ACCESOS_MENU = \[[\s\S]{0,400}'configItem'\s*\]/.test(MENU));

    /* La lectura de la disposición guardada, contra un almacén de mentira. */
    const FUENTE_LEER = extraerFuncion('leerDisposicionMenu');
    check('La lectura de la disposición se puede aislar', !!FUENTE_LEER);
    function leerCon(crudo) {
        const almacen = { getItem: function () { return crudo; } };
        const sandbox = banco({
            localStorage: almacen,
            console: { warn: function () { }, log: function () { } }
        });
        vm.runInContext('var CLAVE_DISPOSICION = "ciervo_menu_disposicion";\n' +
            'var IDS_ACCESOS_MENU = ' + JSON.stringify([
                'operacionesModuleCard', 'inventarioModuleCard', 'salesSummaryModuleCard',
                'catalogItem', 'userManagementItem', 'providersItem', 'accountsItem',
                'companyItem', 'priceCalculatorItem', 'clientsItem', 'configItem']) + ';\n' + FUENTE_LEER, sandbox);
        return sandbox.leerDisposicionMenu();
    }
    eq('sin nada guardado, la disposición está vacía', JSON.stringify(leerCon(null)),
        JSON.stringify({ orden: [], ocultos: [] }));
    eq('una disposición ilegible no rompe el menú', JSON.stringify(leerCon('{esto no es json')),
        JSON.stringify({ orden: [], ocultos: [] }));
    eq('los identificadores desconocidos se descartan (no se puede colar cualquier cosa)',
        JSON.stringify(leerCon('{"orden":["configItem","NO-EXISTE","catalogItem"],"ocultos":["tampoco"]}')),
        JSON.stringify({ orden: ['configItem', 'catalogItem'], ocultos: [] }));
    eq('una disposición válida se conserva entera',
        JSON.stringify(leerCon('{"orden":["accountsItem","catalogItem"],"ocultos":["providersItem"]}')),
        JSON.stringify({ orden: ['accountsItem', 'catalogItem'], ocultos: ['providersItem'] }));
}

/* ------------------------------------------------------------------ */
titulo('6.bis El centro de notificaciones: estructura, conexiones y un solo cálculo');
/* ------------------------------------------------------------------ */
{
    const iBoton = MENU.indexOf('id="botonNotificaciones"');
    const iCierre = MENU.indexOf('</button>', iBoton);
    const iPanel = MENU.indexOf('id="notificationPanel"');
    check('El panel ya NO vive dentro del botón de la campana (era HTML inválido y anulaba los clics)',
        iBoton !== -1 && iPanel !== -1 && iPanel > iCierre,
        'boton=' + iBoton + ' cierre=' + iCierre + ' panel=' + iPanel);
    check('La campana declara su estado para el teclado y el lector de pantalla',
        /id="botonNotificaciones"[\s\S]{0,220}aria-expanded="false"[\s\S]{0,80}aria-controls="notificationPanel"/.test(MENU));
    check('El panel se abre con hidden (no con la clase .show)',
        /id="notificationPanel"[\s\S]{0,140}hidden>/.test(MENU) && !/\.notification-panel\.show/.test(MENU));
    check('Los avisos son botones que llevan a la pantalla que los resuelve',
        /class="notification-item/.test(MENU) && /function abrirDesdeNotificacion\(destino\)/.test(MENU));
    check('Se cierra con Escape, con su botón y al pulsar fuera',
        /function cerrarNotificaciones\(\)/.test(MENU) && /panel\.hidden = true/.test(MENU) &&
        /if \(ev\.key === 'Escape'\) cerrarNotificaciones\(\)/.test(MENU) &&
        /!contenedor\.contains\(ev\.target\)\) cerrarNotificaciones\(\)/.test(MENU));
    check('UN SOLO cálculo del estado: la campana y la franja comparten estadoDelNegocio()',
        /estadoDelNegocio\(\) \{/.test(MENU) && /this\.estadoActualDelNegocio \|\| this\.estadoDelNegocio\(\)/.test(MENU),
        'la franja debe reutilizar el estado de la campana');
    eq('La clasificación de cuentas se hace en un único sitio (definición + 1 llamada)',
        (MENU.match(/cuentasEnAlertaLocal\(/g) || []).length, 2);
    eq('La de inventario, igual', (MENU.match(/inventarioEnAlertaLocal\(/g) || []).length, 2);
    check('El texto se escapa antes de inyectarlo en el panel',
        /function escaparTextoLocal\(/.test(MENU) &&
        /escaparTextoLocal\(a\.titulo\)/.test(MENU) && /escaparTextoLocal\(a\.detalle/.test(MENU));
    check('Los avisos nuevos usan datos que YA existen (copia, almacenamiento y tasa)',
        /window\.fechaUltimaCopia/.test(MENU) && /window\.estadoAlmacenamientoSimple/.test(MENU) &&
        /localStorage\.getItem\('pos_rate_history'\)/.test(MENU));
    check('No se inventan avisos: sin dato, el grupo de mantenimiento no aparece',
        /if \(m\.tasaAlDia === false\)/.test(MENU) && /m\.almacenamiento\.estado !== 'ok'/.test(MENU));
}

/* ------------------------------------------------------------------ */
titulo('7. Mutación: si alguien revierte las dos guardas clave, la suite lo dice');
/* ------------------------------------------------------------------ */
{
    // M1 · quitar la guarda de "saldada" en el estado derivado
    const fuente = FUENTES.estadoDeCuentaLocal;
    const mutada = fuente.replace("if (saldoDeCuentaLocal(cuenta) <= 0) return 'paid';", '');
    check('La mutación «sin la guarda de saldo» se pudo aplicar', mutada !== fuente);
    const sandbox = banco();
    vm.runInContext(mutada, sandbox);
    const conMutacion = sandbox.estadoDeCuentaLocal(cuenta({ payments: [{ amount: 50 }] }), '2026-02-01');
    eq('MUTACIÓN DETECTADA: sin la guarda, la cuenta saldada vuelve a salir como vencida', conMutacion, 'overdue');
}
{
    // M2 · quitar la exclusión del consumo interno en las ventas del día
    const fuente = FUENTES.resumenVentasDeHoyLocal;
    const mutada = fuente.replace('if (esConsumoInternoLocal(venta)) return;          // no es venta', '');
    check('La mutación «sin excluir el consumo interno» se pudo aplicar', mutada !== fuente);
    const sandbox = banco();
    vm.runInContext(mutada, sandbox);
    const r = sandbox.resumenVentasDeHoyLocal(VENTAS, MS_HOY);
    check('MUTACIÓN DETECTADA: sin la exclusión, el consumo interno entra como venta',
        r.cantidad === 5 && r.totalUSD === 237,
        'cantidad=' + r.cantidad + ' total=' + r.totalUSD);
}

/* ------------------------------------------------------------------ */
console.log('\n=====================================================================');
console.log('RESUMEN: ' + ok + ' OK · ' + fallos + ' FALLA');
console.log('=====================================================================');
process.exit(fallos ? 1 : 0);
