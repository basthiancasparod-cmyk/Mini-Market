/**
 * pruebas_indicador_conexion.js
 *
 * El indicador de conexión (#firebaseDot) aparecía con CUATRO colores distintos a
 * la vez, medido en el mismo instante y con la misma cuenta:
 *   - VERDE "Firebase conectado" en compras.html y gestion_usuario.html (miraban
 *     .info/connected, que solo dice que hay socket: con cloudSync=false el verde
 *     era mentira);
 *   - ÁMBAR en inventario.html (miraba el permiso de nube);
 *   - GRIS con el estado del motor en el POS;
 *   - GRIS con el texto del HTML en clientes, cuentas, proveedores, empresa y
 *     resumen (su monitor nunca llegaba a ejecutarse);
 *   - y sin indicador en catalogo.html, config_recibo.html y menu.html.
 *
 * Ahora hay UNA sola autoridad (conexion.js) que sustituye a `setFirebaseDot` de
 * todas las páginas. Esta suite ejecuta el módulo REAL en un sandbox y fija:
 *
 *   1. los cinco estados y su color y su texto;
 *   2. el ORDEN de las preguntas (red antes que nube, y por qué);
 *   3. que ninguna página puede volver a pintar un color propio;
 *   4. que el módulo NUNCA inicializa Firebase (una página que hoy no toca la nube
 *      no debe empezar a conectarse solo por pintar un punto);
 *   5. que el contexto extra de una página se AÑADE, nunca sustituye;
 *   6. invariantes de archivo: las 12 páginas cargan el módulo antes de sesion.js.
 *
 * Uso:  node pruebas_indicador_conexion.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
let pruebas = 0;
let fallos = 0;

function check(nombre, condicion, detalle) {
    pruebas++;
    if (!condicion) fallos++;
    console.log((condicion ? '  OK   ' : '  FALLA') + ' · ' + nombre +
        (condicion || detalle === undefined ? '' : '   [' + detalle + ']'));
}
function titulo(t) { console.log('\n=== ' + t + ' ==='); }

// Páginas que pueden saber el estado de la nube (todas tienen checkCloudAccess o
// inicializan Firebase al cargar). menu.html NO está: no carga el SDK ni tiene
// checkCloudAccess, así que solo podría decir "sin comprobar", que es justo la
// inconsistencia que se está arreglando. Se comprueba aparte (T30b).
const PAGINAS_CON_PUNTO = [
    'compras.html', 'cuentas.html', 'gestion_usuario.html', 'gestion_proveedores.html',
    'gestion_empresa.html', 'inventario.html', 'listado_clientes.html',
    'mini_market_pos.html', 'mini_market_pos_resumen.html',
    'catalogo.html', 'config_recibo.html'
];

/* ------------------------------------------------------------------ */
/* Sandbox                                                            */
/* ------------------------------------------------------------------ */

function crearEntorno(op) {
    op = op || {};
    const almacen = new Map();
    if (op.local) Object.keys(op.local).forEach(k => almacen.set(String(k), String(op.local[k])));
    const registro = { initializeApp: 0, lecturas: [], consultasNube: 0 };
    const punto = { style: {}, title: '' };

    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        JSON, Object, Array, String, Number, Boolean, Date, Math, Promise,
        isNaN, parseInt, parseFloat,
        navigator: { onLine: op.onLine !== false },
        localStorage: {
            getItem: k => (almacen.has(String(k)) ? almacen.get(String(k)) : null),
            setItem: (k, v) => { almacen.set(String(k), String(v)); },
            removeItem: k => { almacen.delete(String(k)); },
            key: i => Array.from(almacen.keys())[i],
            get length() { return almacen.size; }
        },
        document: {
            readyState: 'complete',
            getElementById: id => (id === 'firebaseDot' ? punto : null),
            addEventListener: () => {}
        },
        addEventListener: () => {},
        setTimeout: setTimeout,             // real: las pruebas esperan microtareas
        setInterval: () => 0,               // simulado: no debe dejar el proceso vivo
        firebase: {
            apps: op.apps || [],
            initializeApp: function () { registro.initializeApp++; return {}; },
            database: function () {
                return {
                    ref: function (ruta) {
                        return {
                            once: function () {
                                registro.lecturas.push(ruta);
                                return Promise.resolve({ val: function () { return op.cloudSyncVal; } });
                            }
                        };
                    }
                };
            }
        }
    };
    // `sesionLista` lo expone sesion.js. El módulo ESPERA a que resuelva antes de
    // preguntar por la nube, así que en las pruebas hay que simularlo (salvo en las
    // pruebas que comprueban justo esa espera).
    if (!op.sinSesionLista) {
        ctx.sesionLista = Promise.resolve(op.estadoSesion || 'usuario');
    }
    if (op.checkCloudAccess !== undefined) {
        ctx.checkCloudAccess = function () {
            registro.consultasNube++;
            return Promise.resolve(op.checkCloudAccess);
        };
    }
    if (op.pendientes) ctx.pendientesSync = function () { return op.pendientes; };
    ctx.window = ctx;
    return { ctx, almacen, registro, punto };
}

function cargar(op) {
    const e = crearEntorno(op);
    vm.createContext(e.ctx);
    vm.runInContext(fs.readFileSync(path.join(RAIZ, 'conexion.js'), 'utf8'), e.ctx, { filename: 'conexion.js' });
    return e;
}

async function medir(op) {
    const e = cargar(op);
    await e.ctx.conexion.actualizar();
    const est = e.ctx.conexion.estado();
    return { e, est, color: e.punto.style.background, title: e.punto.title };
}

/* ------------------------------------------------------------------ */
/* 1. Los cinco estados                                               */
/* ------------------------------------------------------------------ */
async function probarEstados() {
    titulo('1. Los cinco estados: color y texto');

    const red = await medir({ onLine: false });
    check('T1 · sin red -> ROJO y lo dice', red.est.clave === 'sin-red' && red.color === '#ef4444',
        JSON.stringify({ clave: red.est.clave, color: red.color }));
    check('T2 · sin red: el texto habla de internet y de que se guarda aquí',
        /Sin internet/i.test(red.title) && /se guardan en este equipo/i.test(red.title), red.title);

    const sinNube = await medir({ onLine: true, checkCloudAccess: false });
    check('T3 · sin nube -> GRIS', sinNube.est.clave === 'sin-nube' && sinNube.color === '#94a3b8',
        JSON.stringify({ clave: sinNube.est.clave, color: sinNube.color }));
    check('T4 · sin nube: el texto dice que los datos se guardan aquí',
        /Solo en este equipo \(sin nube\)/i.test(sinNube.title), sinNube.title);

    const alDia = await medir({ onLine: true, checkCloudAccess: true, pendientes: [] });
    check('T5 · con nube y sin pendientes -> VERDE', alDia.est.clave === 'al-dia' && alDia.color === '#22c55e',
        JSON.stringify({ clave: alDia.est.clave, color: alDia.color }));
    check('T6 · verde significa "todo subido", no "hay socket"', /Todo subido a la nube/i.test(alDia.title), alDia.title);

    const tres = await medir({ onLine: true, checkCloudAccess: true, pendientes: ['pos', 'inventario', 'catalogo'] });
    check('T7 · con nube y 3 pendientes -> ÁMBAR', tres.est.clave === 'pendientes' && tres.color === '#f59e0b',
        JSON.stringify({ clave: tres.est.clave, color: tres.color }));
    check('T8 · ámbar dice CUÁNTOS y en plural', /^3 cambios sin subir a la nube/.test(tres.title), tres.title);

    const uno = await medir({ onLine: true, checkCloudAccess: true, pendientes: ['pos'] });
    check('T9 · con 1 pendiente el texto va en singular', /^1 cambio sin subir a la nube/.test(uno.title), uno.title);

    const incognita = await medir({ onLine: true });
    check('T10 · sin poder saber nada -> GRIS "sin comprobar" (no se inventa un color)',
        incognita.est.clave === 'sin-comprobar' && incognita.color === '#6b7280',
        JSON.stringify({ clave: incognita.est.clave, color: incognita.color }));

    check('T11 · los cinco estados tienen color propio',
        new Set(['sin-red', 'sin-nube', 'pendientes', 'al-dia', 'sin-comprobar']
            .map(k => incognita.e.ctx.conexion.colores[k])).size === 5);
}

/* ------------------------------------------------------------------ */
/* 2. El orden de las preguntas                                       */
/* ------------------------------------------------------------------ */
async function probarOrden() {
    titulo('2. Orden de las preguntas (por qué "sin red" va antes que "sin nube")');

    const ambas = await medir({ onLine: false, checkCloudAccess: false });
    check('T12 · sin red Y sin nube -> gana "sin red" (hecho local y comprobable)',
        ambas.est.clave === 'sin-red', ambas.est.clave);

    const sinNubeConPendientes = await medir({ onLine: true, checkCloudAccess: false, pendientes: ['pos', 'compras'] });
    check('T13 · sin nube manda sobre los pendientes (a un cliente sin nube no se le habla de la nube)',
        sinNubeConPendientes.est.clave === 'sin-nube', sinNubeConPendientes.est.clave);
}

/* ------------------------------------------------------------------ */
/* 3. Una sola autoridad                                              */
/* ------------------------------------------------------------------ */
async function probarAutoridad() {
    titulo('3. Ninguna página puede volver a pintar su propio color');

    const e = cargar({ onLine: true, checkCloudAccess: false });
    await e.ctx.conexion.actualizar();
    check('T14 · el módulo pinta el elemento de verdad',
        e.punto.style.background === '#94a3b8' && e.punto.title.length > 0,
        JSON.stringify({ color: e.punto.style.background, title: e.punto.title }));

    // Una página llama a su viejo setFirebaseDot con un color inventado.
    e.ctx.setFirebaseDot('#ff0000', 'mentira');
    await new Promise(r => setTimeout(r, 20));
    check('T15 · setFirebaseDot ya NO pinta lo que le digan: se ignora el color de la página',
        e.punto.style.background !== '#ff0000' && e.punto.title !== 'mentira',
        JSON.stringify({ color: e.punto.style.background, title: e.punto.title }));
    check('T16 · y recalculado deja el estado canónico', e.punto.style.background === '#94a3b8',
        e.punto.style.background);

    const antes = e.punto.style.background;
    e.ctx.conexion.estado();
    check('T17 · estado() es puro: calcular no pinta', e.punto.style.background === antes);
}

/* ------------------------------------------------------------------ */
/* 4. No inicializa Firebase                                          */
/* ------------------------------------------------------------------ */
async function probarNoInicializa() {
    titulo('4. El módulo NUNCA inicializa Firebase');

    const e = cargar({ onLine: true, apps: [] });
    await e.ctx.conexion.actualizar();
    await new Promise(r => setTimeout(r, 10));
    check('T18 · con la app SIN inicializar no llama a initializeApp',
        e.registro.initializeApp === 0, 'llamadas=' + e.registro.initializeApp);
    check('T19 · y deja el estado en "sin comprobar" en vez de inventarse uno',
        e.ctx.conexion.estado().clave === 'sin-comprobar', e.ctx.conexion.estado().clave);

    const conApp = cargar({
        onLine: true, apps: [{}], cloudSyncVal: true,
        local: { sesionActiva: JSON.stringify({ email: 'Dueno@Negocio.com' }) }
    });
    await conApp.ctx.conexion.actualizar();
    check('T20 · con la app YA inicializada sí lee la nube por la vía directa',
        conApp.registro.lecturas.length > 0, JSON.stringify(conApp.registro.lecturas));
    check('T21 · y usa la ruta del correo normalizada (emailPath)',
        conApp.registro.lecturas.some(r => r === 'BBDD/dueno_at_negocio_com/suscripcion/cloudSync'),
        JSON.stringify(conApp.registro.lecturas));
    check('T22 · cloudSync=true -> VERDE', conApp.ctx.conexion.estado().clave === 'al-dia',
        conApp.ctx.conexion.estado().clave);
    check('T23 · cloudSync=false por la vía directa -> GRIS "sin nube"',
        (await medir({ onLine: true, apps: [{}], cloudSyncVal: false, local: { sesionActiva: '{"email":"a@b.com"}' } }))
            .est.clave === 'sin-nube');

    check('T24 · el módulo no contiene ninguna llamada a initializeApp',
        !/initializeApp/.test(fs.readFileSync(path.join(RAIZ, 'conexion.js'), 'utf8')));
}

/* ------------------------------------------------------------------ */
/* 4-bis. La espera a la sesión (evita el "false" pegajoso)           */
/* ------------------------------------------------------------------ */
async function probarEsperaSesion() {
    titulo('4-bis. No se pregunta por la nube antes de que la sesión esté lista');

    const sinSesion = await medir({ onLine: true, sinSesionLista: true, checkCloudAccess: true });
    check('T38 · sin sesionLista NO se llama a checkCloudAccess (evita el "false" pegajoso)',
        sinSesion.e.registro.consultasNube === 0, 'consultas=' + sinSesion.e.registro.consultasNube);
    check('T39 · y el estado queda en "sin comprobar", no en uno inventado',
        sinSesion.est.clave === 'sin-comprobar', sinSesion.est.clave);

    const rechazada = await medir({ onLine: true, estadoSesion: 'sin-sesion', checkCloudAccess: true });
    check('T40 · con la sesión rechazada tampoco se pregunta',
        rechazada.e.registro.consultasNube === 0 && rechazada.est.clave === 'sin-comprobar',
        JSON.stringify({ consultas: rechazada.e.registro.consultasNube, clave: rechazada.est.clave }));

    const trasEspera = await medir({ onLine: true, estadoSesion: 'sin-comprobacion', checkCloudAccess: false });
    check('T41 · cuando la sesión ya resolvió, sí se pregunta y se dice la verdad',
        trasEspera.e.registro.consultasNube === 1 && trasEspera.est.clave === 'sin-nube',
        JSON.stringify({ consultas: trasEspera.e.registro.consultasNube, clave: trasEspera.est.clave }));
}

/* ------------------------------------------------------------------ */
/* 5. El contexto extra se AÑADE                                      */
/* ------------------------------------------------------------------ */
async function probarDetalle() {
    titulo('5. El detalle de una página se añade, nunca sustituye');

    const e = cargar({ onLine: true, checkCloudAccess: true, pendientes: [] });
    await e.ctx.conexion.detalle(function () { return 'motor: error (X)'; });
    await e.ctx.conexion.actualizar();
    check('T25 · el detalle se añade al final', / · motor: error \(X\)$/.test(e.punto.title), e.punto.title);
    check('T26 · y el mensaje canónico sigue delante', /^Todo subido a la nube/.test(e.punto.title), e.punto.title);
    check('T27 · el detalle no puede cambiar el color', e.punto.style.background === '#22c55e', e.punto.style.background);

    const roto = cargar({ onLine: true, checkCloudAccess: false });
    await roto.ctx.conexion.detalle(function () { throw new Error('detalle roto'); });
    await roto.ctx.conexion.actualizar();
    check('T28 · un detalle que lanza no rompe el punto',
        roto.ctx.conexion.estado().clave === 'sin-nube' && !/·/.test(roto.punto.title), roto.punto.title);

    await roto.ctx.conexion.detalle(null);
    check('T29 · detalle(null) lo quita', roto.ctx.conexion.estado().titulo.indexOf('·') === -1);
}

/* ------------------------------------------------------------------ */
/* 6. Invariantes de archivo                                          */
/* ------------------------------------------------------------------ */
function probarArchivos() {
    titulo('6. Invariantes de archivo');

    const sinModulo = [], malOrden = [], sinPunto = [];
    PAGINAS_CON_PUNTO.forEach(function (p) {
        let t = '';
        try { t = fs.readFileSync(path.join(RAIZ, p), 'utf8'); } catch (e) { sinModulo.push(p + ' (ilegible)'); return; }
        const pCon = t.indexOf('src="conexion.js"');
        const pSes = t.indexOf('src="sesion.js"');
        if (pCon === -1) sinModulo.push(p);
        else if (pSes !== -1 && pCon > pSes) malOrden.push(p);
        if (t.indexOf('id="firebaseDot"') === -1) sinPunto.push(p);
    });
    check('T30 · las 11 páginas con punto cargan conexion.js', sinModulo.length === 0, sinModulo.join(', '));
    check('T31 · en las 11, conexion.js va ANTES de sesion.js', malOrden.length === 0, malOrden.join(', '));
    check('T32 · las 11 páginas tienen el punto #firebaseDot', sinPunto.length === 0, sinPunto.join(', '));

    // menu.html no tiene punto a propósito: no carga Firebase ni tiene
    // checkCloudAccess, así que solo podría decir "sin comprobar" y volveríamos a
    // tener un color distinto al de las demás.
    const menu = fs.readFileSync(path.join(RAIZ, 'menu.html'), 'utf8');
    check('T30b · menu.html NO tiene punto (no puede saber el estado de la nube)',
        menu.indexOf('id="firebaseDot"') === -1);
    const menuSinFirebase = !/firebase-app\.js/.test(menu);
    check('T30c · y de verdad no puede saberlo: menu.html no carga el SDK de Firebase', menuSinFirebase);

    const htmls = fs.readdirSync(RAIZ).filter(f => /\.html$/.test(f));
    const conPuntoSinModulo = htmls.filter(function (f) {
        const t = fs.readFileSync(path.join(RAIZ, f), 'utf8');
        return t.indexOf('id="firebaseDot"') !== -1 && t.indexOf('src="conexion.js"') === -1;
    });
    check('T33 · ninguna página tiene punto sin cargar el módulo', conPuntoSinModulo.length === 0,
        conPuntoSinModulo.join(', '));

    const modulo = fs.readFileSync(path.join(RAIZ, 'conexion.js'), 'utf8');
    check('T34 · el módulo sustituye window.setFirebaseDot (una sola autoridad)',
        /window\.setFirebaseDot\s*=/.test(modulo));
    check('T35 · y expone el estado para las pruebas (conexion.estado)',
        /estado:\s*calcular/.test(modulo));

    const crlf = (modulo.match(/\r\n/g) || []).length, lf = (modulo.match(/\n/g) || []).length;
    check('T36 · conexion.js es CRLF (sin LF sueltos)', crlf > 0 && (lf - crlf) === 0,
        'CRLF=' + crlf + ' sueltos=' + (lf - crlf));

    const pos = fs.readFileSync(path.join(RAIZ, 'mini_market_pos.html'), 'utf8');
    // Se quitan los comentarios ANTES de buscar: un comentario que mencione la llamada
    // haría pasar la comprobación aunque el código real la hiciera (ya pasó DOS veces
    // con esta misma guardia: primero por un comentario de línea, después por uno de
    // bloque). Se quitan los dos tipos, y el `[^:]` delante de `//` protege los
    // literales 'https://...', que NO son comentarios.
    const posSinComentarios = pos
        .replace(/\/\*[\s\S]*?\*\//g, '')          // comentarios de bloque /* ... */
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');     // comentarios de línea, sin tocar https://
    check('T37 · el POS aporta el detalle del motor (no lo pierde)',
        posSinComentarios.indexOf('window.conexionDetalle = function') !== -1);
    check('T37b · y sin depender del orden de carga: NO llama a conexion.detalle(), que en ese script todavía no existe',
        posSinComentarios.indexOf('window.conexion.detalle(') === -1);
}

/* ------------------------------------------------------------------ */
(async function () {
    console.log('Pruebas del indicador de conexión único');
    console.log('Node ' + process.version);

    await probarEstados();
    await probarOrden();
    await probarAutoridad();
    await probarNoInicializa();
    await probarEsperaSesion();
    await probarDetalle();
    probarArchivos();

    console.log('\n----------------------------------------');
    console.log('RESULTADO: ' + (pruebas - fallos) + '/' + pruebas + ' comprobaciones OK' + (fallos ? ' · ' + fallos + ' FALLA(S)' : ' · sin fallos'));
    process.exit(fallos ? 1 : 0);
})().catch(function (e) {
    console.error('ERROR INESPERADO EN LAS PRUEBAS:', e);
    process.exit(1);
});
