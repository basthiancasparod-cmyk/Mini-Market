/* =====================================================================
   PRUEBAS DEL GUARDIÁN "UNA CUENTA POR EQUIPO" (cuenta_local.js)

   Se ejecuta con:  node pruebas_cuenta_local.js

   Comprueba, sobre el ARCHIVO REAL cargado en un `vm` con almacenamiento falso:

     1. Sin marcador -> 'reclamado' y queda escrito el emailPath correcto.
     2. La misma cuenta después -> 'coincide' y no cambia absolutamente nada.
     3. Otra cuenta -> 'ajena' (y el marcador del dueño no se pisa).
     4. Sin sesión -> 'sin-sesion' y no se escribe nada.
     5. liberarEquipo() borra el marcador y la siguiente cuenta lo reclama.
     6. El aviso: texto exigido, botón de descarga, botón de volver, freno del
        arranque y NINGÚN dato de negocio borrado ni modificado.
     7. Invariantes de archivos: CRLF, sintaxis, las 12 páginas lo cargan y los
        bloques en línea de index.html y config.html compilan.
   ===================================================================== */
const fs = require('fs');
const vm = require('vm');
let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);

/* ============ 1. DOM FALSO MÍNIMO (sin navegador) ============ */
function crearElemento(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        type: '',
        textContent: '',
        parentNode: null,
        children: [],
        atributos: {},
        onclick: null,
        setAttribute: (k, v) => { el.atributos[k] = String(v); if (k === 'id') el.id = String(v); },
        getAttribute: (k) => (k in el.atributos ? el.atributos[k] : null),
        appendChild: (hijo) => { hijo.parentNode = el; el.children.push(hijo); return hijo; }
    };
    return el;
}

function buscar(raiz, condicion) {
    for (const hijo of raiz.children) {
        if (condicion(hijo)) return hijo;
        const encontrado = buscar(hijo, condicion);
        if (encontrado) return encontrado;
    }
    return null;
}

function textoDe(raiz) {
    let texto = raiz.textContent || '';
    for (const hijo of raiz.children) texto += ' ' + textoDe(hijo);
    return texto;
}

function crearDocumento() {
    const doc = {
        documentElement: crearElemento('html'),
        body: crearElemento('body'),
        oyentes: [],
        createElement: (tag) => crearElemento(tag),
        addEventListener: (tipo, fn, captura) => { doc.oyentes.push({ tipo, fn, captura: !!captura }); },
        getElementById: (id) => buscar(doc.documentElement, (e) => e.id === id)
    };
    doc.documentElement.appendChild(doc.body);
    return doc;
}

// Reproduce el orden real: si un manejador frena la propagación, los siguientes NO corren.
function dispararDOMContentLoaded(doc) {
    let propagacionDetenida = false;
    const evento = { stopImmediatePropagation: () => { propagacionDetenida = true; } };
    for (const oyente of doc.oyentes) {
        if (oyente.tipo !== 'DOMContentLoaded') continue;
        oyente.fn(evento);
        if (propagacionDetenida) break;
    }
    return propagacionDetenida;
}

function crearAlmacen(inicial) {
    const datos = Object.assign({}, inicial || {});
    return {
        datos,
        getItem: (k) => (k in datos ? datos[k] : null),
        setItem: (k, v) => { datos[k] = String(v); },
        removeItem: (k) => { delete datos[k]; },
        clear: () => { Object.keys(datos).forEach((k) => { delete datos[k]; }); },
        key: (i) => Object.keys(datos)[i],
        get length() { return Object.keys(datos).length; }
    };
}

/* ============ 2. CARGA DEL ARCHIVO REAL EN UN SANDBOX ============ */
const CRUDO = fs.readFileSync('cuenta_local.js', 'utf8');

const DATOS_NEGOCIO = {
    ciervo_inventory: JSON.stringify([{ id: 1, nombre: 'Arroz' }]),
    ciervo_inventory_history: '[]',
    pos_sales: JSON.stringify([{ id: 'V-1', total: 5 }]),
    ciervo_clients: JSON.stringify([{ id: 'C-1', nombre: 'Ana' }]),
    ciervo_suppliers: '[]',
    companyData: JSON.stringify({ nombre: 'Bodega A' })
};

function clavesDeNegocioIntactas(almacen) {
    return Object.keys(DATOS_NEGOCIO).every((k) => almacen[k] === DATOS_NEGOCIO[k]);
}

function cargarGuardian(opciones) {
    const op = opciones || {};
    const almacen = crearAlmacen(op.local);
    const sesion = crearAlmacen(op.session);
    const doc = crearDocumento();
    const descargas = { veces: 0 };
    const redirecciones = [];

    const ctx = {
        console, JSON, Object, String, Number, Array, Date, parseInt, isNaN, setTimeout,
        localStorage: almacen,
        sessionStorage: sesion,
        document: doc,
        location: {
            replace: (destino) => { redirecciones.push(String(destino)); },
            set href(v) { redirecciones.push(String(v)); },
            get href() { return ''; }
        }
    };
    ctx.window = ctx;
    if (op.descargarRespaldo) ctx.descargarRespaldo = () => { descargas.veces++; };
    if (op.cerrarSesionApp) {
        ctx.cerrarSesionApp = (destino) => {
            redirecciones.push('cerrarSesionApp:' + (destino || ''));
            almacen.removeItem('sesionActiva');
        };
    }
    if (op.sanitizeEmailForDb) {
        ctx.sanitizeEmailForDb = (e) => String(e).replace('@', '_at_').replace(/\./g, '_');
    }

    vm.createContext(ctx);
    vm.runInContext(CRUDO, ctx);
    return { ctx, doc, almacen, sesion, descargas, redirecciones, api: ctx.cuentaLocal };
}

/* =====================================================================
   A. COMPORTAMIENTO DEL GUARDIÁN
   ===================================================================== */
console.log('\n================ A. GUARDIÁN cuenta_local.js ================\n');

/* --- 1) Sin marcador: se reclama para la cuenta que entra --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO });
    nota('al cargar sin sesión tampoco se marca nada: ' + JSON.stringify(Object.keys(g.almacen.datos)));
    check('A1 · al cargar sin sesión no se escribe el marcador',
        g.almacen.datos['datosDeCuenta'] === undefined, JSON.stringify(Object.keys(g.almacen.datos)));

    const info = g.api.reclamarOComprobar('Juan@X.com');
    check('1 · sin marcador -> reclamado', info.estado === 'reclamado', info.estado);
    check('1 · queda escrito el emailPath correcto (minúsculas, @ y TODOS los puntos)',
        g.almacen.datos['datosDeCuenta'] === 'juan_at_x_com', g.almacen.datos['datosDeCuenta']);
    check('1 · el dueño informado es esa misma ruta', info.dueño === 'juan_at_x_com', info.dueño);
    check('1 · el correo normalizado se informa tal cual', info.email === 'juan_at_x_com', info.email);
    check('1 · reclamar NO toca ningún dato de negocio', clavesDeNegocioIntactas(g.almacen.datos));

    /* --- 2) La misma cuenta después: coincide y no cambia nada --- */
    const antes = JSON.stringify(g.almacen.datos);
    const info2 = g.api.reclamarOComprobar('juan@x.com');
    check('2 · la misma cuenta -> coincide', info2.estado === 'coincide', info2.estado);
    const info3 = g.api.reclamarOComprobar('  JUAN@X.com  ');
    check('2 · da igual mayúsculas y espacios: sigue coincidiendo', info3.estado === 'coincide', info3.estado);
    check('2 · no cambia absolutamente nada en el equipo',
        JSON.stringify(g.almacen.datos) === antes, JSON.stringify(g.almacen.datos));

    /* --- 3) Otra cuenta: ajena --- */
    const infoAjeno = g.api.reclamarOComprobar('pedro@otro.com');
    check('3 · otra cuenta -> ajena', infoAjeno.estado === 'ajena', infoAjeno.estado);
    check('3 · se informa el dueño REAL de los datos', infoAjeno.dueño === 'juan_at_x_com', infoAjeno.dueño);
    check('3 · el marcador del dueño NO se pisa',
        g.almacen.datos['datosDeCuenta'] === 'juan_at_x_com', g.almacen.datos['datosDeCuenta']);
    check('3 · comprobar una cuenta ajena tampoco toca los datos de negocio',
        clavesDeNegocioIntactas(g.almacen.datos));
}

/* --- 4) Sin sesión: no se hace nada --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO });
    const info = g.api.reclamarOComprobar('');
    check("4 · sin correo -> 'sin-sesion'", info.estado === 'sin-sesion', info.estado);
    check('4 · sin correo no se escribe el marcador',
        g.almacen.datos['datosDeCuenta'] === undefined, JSON.stringify(Object.keys(g.almacen.datos)));
    check("4 · null y undefined también dan 'sin-sesion'",
        g.api.reclamarOComprobar(null).estado === 'sin-sesion' &&
        g.api.reclamarOComprobar(undefined).estado === 'sin-sesion');
    check("4 · sin sesión no se escribe NADA (ni claves de negocio nuevas)",
        JSON.stringify(g.almacen.datos) === JSON.stringify(DATOS_NEGOCIO));
}

/* --- 5) liberarEquipo() (reinicio de fábrica) --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO });
    g.api.reclamarOComprobar('ana@negocio.com');
    const antes = g.almacen.datos['datosDeCuenta'];
    const liberado = g.api.liberarEquipo();
    check('5 · liberarEquipo() borra el marcador',
        liberado === true && g.almacen.datos['datosDeCuenta'] === undefined, String(antes));
    check('5 · liberarEquipo() NO toca los datos de negocio', clavesDeNegocioIntactas(g.almacen.datos));
    const info = g.api.reclamarOComprobar('otro@negocio.com');
    check('5 · la siguiente cuenta lo reclama',
        info.estado === 'reclamado' && g.almacen.datos['datosDeCuenta'] === 'otro_at_negocio_com',
        info.estado + ' / ' + g.almacen.datos['datosDeCuenta']);
}

/* --- 6) El aviso de bloqueo --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO, descargarRespaldo: true });
    g.almacen.datos['datosDeCuenta'] = 'juan_at_negocio_com';
    const info = g.api.reclamarOComprobar('nuevo@negocio.com');
    check("6 · el veredicto es 'ajena'", info.estado === 'ajena', info.estado);

    g.api.avisarYBloquearSesionAjena(info);
    const capa = g.doc.getElementById('avisoCuentaAjena');
    check('6 · el aviso existe', !!capa);
    const estilo = capa ? capa.getAttribute('style') : '';
    check('6 · el aviso cubre la pantalla con estilos en línea',
        /position:fixed/.test(estilo) && /top:0/.test(estilo) && /z-index:2147483647/.test(estilo), estilo);

    const TEXTO = 'Este equipo tiene datos guardados de otra cuenta (juan@negocio.com). ' +
        'Para no mezclar negocios, esta cuenta no puede usarlos. ' +
        'Descarga una copia de seguridad y consulta con el administrador.';
    check('6 · el aviso lleva el texto exigido', textoDe(capa).includes(TEXTO), textoDe(capa));

    const botonDescarga = buscar(capa, (e) => e.getAttribute('data-cuenta-accion') === 'descargar');
    const botonVolver = buscar(capa, (e) => e.getAttribute('data-cuenta-accion') === 'volver');
    check('6 · tiene el botón "Descargar copia de seguridad"',
        !!botonDescarga && botonDescarga.textContent === 'Descargar copia de seguridad');
    check('6 · tiene el botón "Volver al inicio de sesión"',
        !!botonVolver && botonVolver.textContent === 'Volver al inicio de sesión');

    botonDescarga.onclick();
    check('6 · el botón de descarga llama a window.descargarRespaldo',
        g.descargas.veces === 1, String(g.descargas.veces));

    check('6 · tras el aviso los datos de negocio siguen intactos', clavesDeNegocioIntactas(g.almacen.datos));

    // El aviso frena el arranque: un manejador añadido después (sesion.js o la página) no corre
    let otroManejadorEjecutado = false;
    g.doc.addEventListener('DOMContentLoaded', () => { otroManejadorEjecutado = true; });
    const detenido = dispararDOMContentLoaded(g.doc);
    check('6 · el aviso frena el arranque de la página (stopImmediatePropagation)',
        detenido === true && otroManejadorEjecutado === false);
    check('6 · el aviso termina dentro de <body>', capa.parentNode === g.doc.body);

    // "Volver al inicio de sesión": limpia la sesión, no los datos
    g.almacen.datos['sesionActiva'] = JSON.stringify({ email: 'nuevo@negocio.com' });
    g.sesion.datos['propietarioActual'] = 'nuevo@negocio.com';
    botonVolver.onclick();
    check('6 · "Volver" limpia la sesión y va a index.html',
        g.almacen.datos['sesionActiva'] === undefined &&
        g.redirecciones[g.redirecciones.length - 1] === 'index.html',
        JSON.stringify(g.redirecciones));
    check('6 · "Volver" tampoco borra datos de negocio', clavesDeNegocioIntactas(g.almacen.datos));
    check('6 · y limpia el sessionStorage de la pestaña',
        JSON.stringify(g.sesion.datos) === '{}', JSON.stringify(g.sesion.datos));
}

/* --- 6b) Sin window.descargarRespaldo el botón de descarga se oculta --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO });
    g.almacen.datos['datosDeCuenta'] = 'juan_at_negocio_com';
    g.api.avisarYBloquearSesionAjena({ estado: 'ajena', dueño: 'juan_at_negocio_com', email: 'nuevo_at_negocio_com' });
    const capa = g.doc.getElementById('avisoCuentaAjena');
    check('6b · sin window.descargarRespaldo el botón de descarga se oculta',
        buscar(capa, (e) => e.getAttribute('data-cuenta-accion') === 'descargar') === null);
    check('6b · el botón de volver al login sigue disponible',
        !!buscar(capa, (e) => e.getAttribute('data-cuenta-accion') === 'volver'));
}

/* --- 6c) Con window.cerrarSesionApp se usa ese cierre de sesión --- */
{
    const g = cargarGuardian({ local: DATOS_NEGOCIO, cerrarSesionApp: true });
    g.almacen.datos['datosDeCuenta'] = 'juan_at_negocio_com';
    g.almacen.datos['sesionActiva'] = JSON.stringify({ email: 'nuevo@negocio.com' });
    g.api.avisarYBloquearSesionAjena({ estado: 'ajena', dueño: 'juan_at_negocio_com', email: 'nuevo_at_negocio_com' });
    const capa = g.doc.getElementById('avisoCuentaAjena');
    buscar(capa, (e) => e.getAttribute('data-cuenta-accion') === 'volver').onclick();
    check('6c · "Volver" usa window.cerrarSesionApp cuando existe',
        g.redirecciones[g.redirecciones.length - 1] === 'cerrarSesionApp:index.html' &&
        g.almacen.datos['sesionActiva'] === undefined,
        JSON.stringify(g.redirecciones));
}

/* --- 6d) Comprobación automática al cargar la página (páginas de datos) --- */
{
    const conSesion = Object.assign({}, DATOS_NEGOCIO);
    conSesion['sesionActiva'] = JSON.stringify({ email: 'dueno@negocio.com' });
    const g = cargarGuardian({ local: conSesion });
    check('6d · al cargar, con sesión y sin marcador, el equipo queda reclamado por esa cuenta',
        g.almacen.datos['datosDeCuenta'] === 'dueno_at_negocio_com', g.almacen.datos['datosDeCuenta']);

    const ajeno = Object.assign({}, DATOS_NEGOCIO);
    ajeno['sesionActiva'] = JSON.stringify({ email: 'intruso@negocio.com' });
    ajeno['datosDeCuenta'] = 'dueno_at_negocio_com';
    const g2 = cargarGuardian({ local: ajeno });
    check('6d · al cargar con marcador ajeno la página arranca bloqueada',
        !!g2.doc.getElementById('avisoCuentaAjena'));
    check('6d · y el marcador del dueño no se pisa',
        g2.almacen.datos['datosDeCuenta'] === 'dueno_at_negocio_com', g2.almacen.datos['datosDeCuenta']);
    check('6d · el equipo del intruso no gana ninguna clave nueva de negocio', clavesDeNegocioIntactas(g2.almacen.datos));

    // El respaldo de sessionStorage['propietarioActual'] también sirve para saber la cuenta
    const conPropietario = Object.assign({}, DATOS_NEGOCIO);
    const g3 = cargarGuardian({ local: conPropietario, session: { propietarioActual: 'jefa@negocio.com' } });
    check('6d · sin sesionActiva se usa el propietario del sessionStorage',
        g3.almacen.datos['datosDeCuenta'] === 'jefa_at_negocio_com', g3.almacen.datos['datosDeCuenta']);

    // Si la página expone su propio sanitizeEmailForDb, se reutiliza
    const g4 = cargarGuardian({ local: DATOS_NEGOCIO, sanitizeEmailForDb: true });
    const info = g4.api.reclamarOComprobar('Maria@Negocio.com');
    check('6d · reutiliza window.sanitizeEmailForDb si existe',
        g4.almacen.datos['datosDeCuenta'] === 'maria_at_negocio_com', g4.almacen.datos['datosDeCuenta']);
}

/* =====================================================================
   B. INVARIANTES SOBRE LOS ARCHIVOS REALES
   ===================================================================== */
console.log('\n================ B. ARCHIVOS REALES ================\n');

const PAGINAS = [
    'index.html',
    'inventario.html',
    'catalogo.html',
    'compras.html',
    'cuentas.html',
    'config_recibo.html',
    'gestion_empresa.html',
    'gestion_proveedores.html',
    'listado_clientes.html',
    'mini_market_pos.html',
    'mini_market_pos_resumen.html',
    'config.html'
];

try {
    let err = '';
    try { new vm.Script(CRUDO); } catch (e) { err = e.message; }
    check('cuenta_local.js · compila', !err, err);
    check('cuenta_local.js · usa CRLF en todas sus líneas', !/(?<!\r)\n/.test(CRUDO));
    check('cuenta_local.js · guarda el marcador en la clave datosDeCuenta',
        CRUDO.includes("var CLAVE_MARCADOR = 'datosDeCuenta';"));
    check('cuenta_local.js · expone la API en window.cuentaLocal',
        ['reclamarOComprobar', 'avisarYBloquearSesionAjena', 'liberarEquipo']
            .every((f) => new RegExp(f + '\\s*:').test(CRUDO)));
    const borrados = [...CRUDO.matchAll(/removeItem\(([^)]*)\)/g)].map((m) => m[1].trim());
    check('cuenta_local.js · solo borra el marcador y la marca de sesión',
        borrados.length > 0 && borrados.every((b) => b === 'CLAVE_MARCADOR' || b === 'CLAVE_SESION'),
        JSON.stringify(borrados));
    check('cuenta_local.js · no menciona ninguna clave de negocio (nada destructivo)',
        !/ciervo_inventory|pos_sales|ciervo_clients|ciervo_suppliers|companyData/
            .test(CRUDO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
} catch (e) {
    check('cuenta_local.js legible', false, e.message);
}

check('son las 12 páginas esperadas (index + 10 de datos + config)', PAGINAS.length === 12);

for (const archivo of PAGINAS) {
    let t;
    try { t = fs.readFileSync(archivo, 'utf8'); }
    catch (e) { check(archivo + ' legible', false, e.message); continue; }

    check(archivo + ' · carga cuenta_local.js',
        /<script[^>]+src=["']cuenta_local\.js["']/.test(t));
    check(archivo + ' · usa CRLF en todas sus líneas', !/(?<!\r)\n/.test(t));
}

/* Los bloques en línea de las páginas tocadas deben seguir compilando */
for (const archivo of ['index.html', 'config.html']) {
    const t = fs.readFileSync(archivo, 'utf8');
    const bloques = [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    let errorSintaxis = '';
    for (const b of bloques) {
        try { new vm.Script(b); } catch (e) { errorSintaxis = e.message; break; }
    }
    check(archivo + ' · sintaxis de sus ' + bloques.length + ' bloques en línea', !errorSintaxis, errorSintaxis);
}

/* Integración concreta en el login y en el reinicio de fábrica */
try {
    const indice = fs.readFileSync('index.html', 'utf8');
    check('index.html · el login comprueba/reclama el equipo al conocer el correo',
        /cuentaLocal\.reclamarOComprobar\(email\)/.test(indice));
    check('index.html · si el equipo es de otra cuenta bloquea el uso',
        /estado === 'ajena'/.test(indice) && /avisarYBloquearSesionAjena\(veredicto\)/.test(indice));
    const config = fs.readFileSync('config.html', 'utf8');
    const posFunc = config.indexOf('function clearOtherSystemData');
    const posLiberar = config.indexOf('liberarEquipo()');
    check('config.html · el reinicio de fábrica libera el equipo', posLiberar !== -1);
    // Dentro del cuerpo de clearOtherSystemData: sus llaves siguen abiertas al llegar la llamada
    let dentroDeLimpieza = false;
    if (posFunc !== -1 && posLiberar > posFunc) {
        const cuerpo = config.slice(posFunc, posLiberar);
        dentroDeLimpieza = (cuerpo.split('{').length - cuerpo.split('}').length) >= 1;
    }
    check('config.html · la liberación va dentro del bloque de limpieza (clearOtherSystemData)',
        dentroDeLimpieza);
} catch (e) {
    check('index.html/config.html legibles', false, e.message);
}

console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
console.log('Nota: el aislamiento completo (claves por cuenta y archivos del motor por negocio)');
console.log('      sigue pendiente: esta fase solo marca el equipo y bloquea la cuenta ajena.');
process.exit(fallos === 0 ? 0 : 1);
