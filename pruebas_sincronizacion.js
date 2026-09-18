/* =====================================================================
   PRUEBAS DE SINCRONIZACIÓN (Fase A de AUDITORIA_ALMACENAMIENTO.md)

   Se ejecuta con:  node pruebas_sincronizacion.js

   Tiene dos partes:

   A) SIMULADOR de comportamiento. Reproduce las operaciones de la app sobre
      un servidor y varios "dispositivos", con la semántica REAL del SDK v8
      (verificada leyendo su código): sin conexión, la promesa de .set() NO
      resuelve ni rechaza —queda pendiente— y la escritura vive solo en la cola
      en memoria, que se pierde al cerrar el navegador. Cada escenario se corre
      con la política ANTIGUA y con la de FASE A, para ver la diferencia.

   B) INVARIANTES sobre los archivos reales: que todas las páginas carguen el
      ayudante, que marquen antes de subir, que tengan la guardia de descarga,
      que no quede la marca global compartida y que sus scripts no tengan
      errores de sintaxis.
   ===================================================================== */
const fs = require('fs');
const vm = require('vm');
let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);
const aviso = (t) => console.log('      [!] ' + t);

/* ============ 1. SERVIDOR Y DISPOSITIVOS (semántica del SDK v8) ============ */
function clonar(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function escribirEn(raiz, ruta, valor) {
    const partes = ruta.split('/').filter(Boolean);
    let nodo = raiz;
    for (let i = 0; i < partes.length - 1; i++) {
        if (nodo[partes[i]] === null || typeof nodo[partes[i]] !== 'object') nodo[partes[i]] = {};
        nodo = nodo[partes[i]];
    }
    nodo[partes[partes.length - 1]] = clonar(valor);
}
function leerDe(raiz, ruta) {
    let nodo = raiz;
    for (const p of ruta.split('/').filter(Boolean)) {
        if (nodo === null || typeof nodo !== 'object') return null;
        nodo = nodo[p];
    }
    return nodo === undefined ? null : clonar(nodo);
}

function crearServidor() { return { datos: {}, cloudSync: true }; }

function crearDispositivo(nombre, servidor, pol) {
    const almacen = {};
    const dev = {
        nombre, servidor, pol, conectado: true, colaEnMemoria: [], permisoConsultado: false, permiso: null,
        local: {
            getItem: (k) => (k in almacen ? almacen[k] : null),
            setItem: (k, v) => { almacen[k] = String(v); },
            removeItem: (k) => { delete almacen[k]; },
            key: (i) => Object.keys(almacen)[i],
            get length() { return Object.keys(almacen).length; }
        },
        claves: () => Object.keys(almacen),
        /* .set(): con conexión resuelve cuando el servidor confirma; sin conexión
           queda PENDIENTE y la escritura se guarda en la cola en memoria. */
        set(ruta, valor) {
            return new Promise((resolve) => {
                if (dev.conectado) { escribirEn(servidor.datos, ruta, valor); resolve(true); }
                else dev.colaEnMemoria.push({ ruta, valor, resolve });
            });
        },
        /* .transaction(): el servidor aplica la función de forma atómica */
        transaction(ruta, fn) {
            return new Promise((resolve) => {
                if (dev.conectado) { escribirEn(servidor.datos, ruta, fn(leerDe(servidor.datos, ruta))); resolve(true); }
                else dev.colaEnMemoria.push({ ruta, fn, resolve });
            });
        },
        /* .once('value') sobre la suscripción: sin conexión el SDK devuelve la caché
           local (null), que NO es una respuesta del servidor. */
        leerCloudSync() {
            if (!dev.conectado) return Promise.resolve(null);
            return Promise.resolve(servidor.cloudSync);
        },
        async checkCloudAccess() {
            if (dev.permisoConsultado) return dev.permiso;      // caché de la página
            const v = await dev.leerCloudSync();
            if (v === null) {
                // Política antigua: un fallo de red dejaba el permiso cacheado en falso,
                // y ya no se volvía a preguntar en toda la sesión de esa página (C6).
                if (dev.pol && dev.pol.cacheaFalloOffline) { dev.permisoConsultado = true; dev.permiso = false; }
                return false;
            }
            dev.permisoConsultado = true; dev.permiso = v === true;
            return dev.permiso;
        },
        /* Réplica de fbSaveX(...): si no hay permiso devuelve false SIN escribir. */
        async escribirSiHayPermiso(ruta, valor) {
            if (!(await dev.checkCloudAccess())) return false;
            await dev.set(ruta, valor);
            return true;
        },
        desconectar() { dev.conectado = false; },
        reconectar() {
            dev.conectado = true;
            const cola = dev.colaEnMemoria; dev.colaEnMemoria = [];
            for (const o of cola) {
                escribirEn(servidor.datos, o.ruta, o.fn ? o.fn(leerDe(servidor.datos, o.ruta)) : o.valor);
                o.resolve(true);
            }
        },
        cerrarNavegador() { dev.colaEnMemoria = []; dev.conectado = false; dev.permisoConsultado = false; }
    };
    return dev;
}

/* ============ 2. MODELO DE LA APP: política antigua vs Fase A ============ */
const ANTES = { nombre: 'antes', marcaAntesDeSubir: false, marcaGlobal: true, guardiaDescarga: false, invalidaPermisoAlReconectar: false, cacheaFalloOffline: true };
const FASE_A = { nombre: 'faseA', marcaAntesDeSubir: true, marcaGlobal: false, guardiaDescarga: true, invalidaPermisoAlReconectar: true, cacheaFalloOffline: false };

const leerLocalJson = (dev, k) => JSON.parse(dev.local.getItem(k) || '[]');
const guardarLocalJson = (dev, k, v) => dev.local.setItem(k, JSON.stringify(v));
const claveMarca = (modulo, pol) => pol.marcaGlobal ? '_pendingFirebaseChanges' : '_pendSync_' + modulo + '_negocio';
function marcar(dev, modulo, pol) { dev.local.setItem(claveMarca(modulo, pol), '1'); }
function limpiar(dev, modulo, pol) { dev.local.removeItem(claveMarca(modulo, pol)); }
function hayPendiente(dev, modulo, pol) {
    if (dev.local.getItem(claveMarca(modulo, pol))) return true;
    if (!pol.marcaGlobal && dev.local.getItem('_pendingFirebaseChanges') === 'true') return true;   // compatibilidad
    return false;
}
function hayAlgunPendiente(dev) {
    return dev.claves().some((k) => k.indexOf('_pendSync_') === 0 || k === '_pendingFirebaseChanges');
}

/* Guarda una venta y la sube. Réplica de mini_market_pos.html */
async function guardarVenta(dev, venta, pol) {
    const ventas = leerLocalJson(dev, 'pos_sales');
    ventas.push(venta);
    guardarLocalJson(dev, 'pos_sales', ventas);
    if (pol.marcaAntesDeSubir) marcar(dev, 'pos', pol);
    try {
        const subida = await dev.escribirSiHayPermiso('BBDD/negocio/ventas/historial', ventas);
        if (subida) { limpiar(dev, 'pos', pol); return true; }
        return false;
    } catch (e) { marcar(dev, 'pos', pol); return false; }
}

/* Abre el POS: si hay pendientes sube; si no, descarga (y REEMPLAZA lo local) */
async function cargarPOS(dev, pol) {
    if (hayPendiente(dev, 'pos', pol)) {
        const ventas = leerLocalJson(dev, 'pos_sales');
        const subida = await dev.escribirSiHayPermiso('BBDD/negocio/ventas/historial', ventas);
        if (subida) limpiar(dev, 'pos', pol);
        return 'sube';
    }
    if (pol.guardiaDescarga && hayAlgunPendiente(dev)) return 'no descarga (hay pendientes)';
    // La app nunca descarga sin permiso de nube: no pisa los datos locales (C10)
    if (!(await dev.checkCloudAccess())) return 'sin nube: no descarga';
    guardarLocalJson(dev, 'pos_sales', leerDe(dev.servidor.datos, 'BBDD/negocio/ventas/historial') || []);
    return 'descarga';
}

/* Guarda una compra (otro módulo) y la sube */
async function guardarCompra(dev, compra, pol) {
    const compras = leerLocalJson(dev, 'ciervo_purchases');
    compras.push(compra);
    guardarLocalJson(dev, 'ciervo_purchases', compras);
    if (pol.marcaAntesDeSubir) marcar(dev, 'compras', pol);
    try {
        const subida = await dev.escribirSiHayPermiso('BBDD/negocio/compras', compras);
        if (subida) { limpiar(dev, 'compras', pol); return true; }
        return false;
    } catch (e) { marcar(dev, 'compras', pol); return false; }
}
async function cargarCompras(dev, pol) {
    if (hayPendiente(dev, 'compras', pol)) return 'sube';
    if (pol.guardiaDescarga && hayAlgunPendiente(dev)) return 'no descarga (hay pendientes)';
    if (!(await dev.checkCloudAccess())) return 'sin nube: no descarga';
    guardarLocalJson(dev, 'ciervo_purchases', leerDe(dev.servidor.datos, 'BBDD/negocio/compras') || []);
    return 'descarga';
}

/* ============ 3. ESCENARIOS ============ */
(async function main() {
console.log('================ A. SIMULADOR DE COMPORTAMIENTO ================\n');

console.log('T1 · Venta sin conexión, se cierra el navegador, vuelve la conexión (hallazgo C1)');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        const dev = crearDispositivo('caja', s, pol);
        dev.desconectar();
        await guardarVenta(dev, { id: 'V-LOCAL-0001', total: 10 }, pol);
        dev.cerrarNavegador();
        dev.reconectar();
        await cargarPOS(dev, pol);
        resultado[pol.nombre] = {
            enEquipo: leerLocalJson(dev, 'pos_sales').length,
            enNube: (leerDe(s.datos, 'BBDD/negocio/ventas/historial') || []).length
        };
    }
    nota('antes -> ventas en el equipo: ' + resultado.antes.enEquipo + ' | en la nube: ' + resultado.antes.enNube);
    nota('faseA -> ventas en el equipo: ' + resultado.faseA.enEquipo + ' | en la nube: ' + resultado.faseA.enNube);
    check('T1 · con la política antigua la venta SE PIERDE (fallo documentado)',
        resultado.antes.enEquipo === 0 && resultado.antes.enNube === 0);
    check('T1 · con Fase A la venta se conserva y llega a la nube',
        resultado.faseA.enEquipo === 1 && resultado.faseA.enNube === 1);
}

console.log('\nT2 · Dos dispositivos, cada uno con su propia sesión (hallazgo C2)');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        const A = crearDispositivo('cajaA', s, pol);
        const B = crearDispositivo('cajaB', s, pol);
        await guardarVenta(A, { id: 'V-A-1', total: 10 }, pol);   // A vende y sube
        await guardarVenta(B, { id: 'V-B-1', total: 20 }, pol);   // B, que nunca descargó, sube su arreglo
        resultado[pol.nombre] = (leerDe(s.datos, 'BBDD/negocio/ventas/historial') || []).map((v) => v.id);
    }
    nota('antes -> la nube queda con: ' + JSON.stringify(resultado.antes));
    nota('faseA -> la nube queda con: ' + JSON.stringify(resultado.faseA));
    check('T2 · sigue abierto (documentado): la subida de un equipo borra las ventas del otro',
        resultado.antes.indexOf('V-A-1') === -1 && resultado.faseA.indexOf('V-A-1') === -1);
    aviso('C2 NO se arregla con la Fase A: hay que subir OPERACIONES en vez de arreglos completos (Fase B).');
    aviso('La Fase A evita que quien descarga pierda lo suyo, pero quien sube sigue pisando al otro.');
}

console.log('\nT3 · Marca compartida: un módulo borra el pendiente de otro (hallazgo C4)');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        const dev = crearDispositivo('equipo', s, pol);
        // Compras intenta subir y falla (por ejemplo, reglas): queda pendiente
        marcar(dev, 'compras', pol);
        guardarLocalJson(dev, 'ciervo_purchases', [{ id: 'C-1' }]);
        // Inventario sube bien: con la marca global, borra el pendiente de compras
        const subida = await dev.escribirSiHayPermiso('BBDD/negocio/productos', [{ id: 1 }]);
        if (subida) limpiar(dev, 'inventario', pol);
        await cargarCompras(dev, pol);
        resultado[pol.nombre] = leerLocalJson(dev, 'ciervo_purchases').length;
    }
    nota('antes -> compras en el equipo tras abrir el módulo: ' + resultado.antes);
    nota('faseA -> compras en el equipo tras abrir el módulo: ' + resultado.faseA);
    check('T3 · con la política antigua el cambio de compras SE PIERDE (fallo documentado)', resultado.antes === 0);
    check('T3 · con Fase A el cambio de compras se conserva', resultado.faseA === 1);
}

console.log('\nT4 · La página se abre sin internet y la conexión vuelve (hallazgo C6)');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        const dev = crearDispositivo('equipo', s, pol);
        dev.desconectar();
        marcar(dev, 'pos', pol);
        guardarLocalJson(dev, 'pos_sales', [{ id: 'V-1' }]);
        await dev.checkCloudAccess();                       // primer chequeo: sin conexión
        dev.reconectar();
        // Al reconectar, la app vuelve a preguntar el permiso (Fase A, C6)
        if (pol.invalidaPermisoAlReconectar) { dev.permisoConsultado = false; dev.permiso = null; }
        await dev.checkCloudAccess();
        const ventas = leerLocalJson(dev, 'pos_sales');
        await dev.escribirSiHayPermiso('BBDD/negocio/ventas/historial', ventas);
        resultado[pol.nombre] = (leerDe(s.datos, 'BBDD/negocio/ventas/historial') || []).length;
    }
    nota('antes -> ventas que llegaron a la nube al reconectar: ' + resultado.antes);
    nota('faseA -> ventas que llegaron a la nube al reconectar: ' + resultado.faseA);
    check('T4 · con la política antigua el permiso queda cacheado en falso y no sube (fallo documentado)', resultado.antes === 0);
    check('T4 · con Fase A se vuelve a preguntar el permiso y sube solo', resultado.faseA === 1);
}

console.log('\nT5 · Contador de tickets que no debe retroceder (hallazgo C3)');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        const A = crearDispositivo('cajaA', s, pol);
        const B = crearDispositivo('cajaB', s, pol);
        escribirEn(s.datos, 'BBDD/negocio/ventas/ultimo_numero', 100);   // la nube ya va por 100
        if (pol.nombre === 'antes') {
            // Comportamiento antiguo: cada equipo escribe su número local sin mirar la nube
            await A.set('BBDD/negocio/ventas/ultimo_numero', 100);
            await B.set('BBDD/negocio/ventas/ultimo_numero', 90);        // B venía atrasado
        } else {
            // Fase A: transacción con máximo → nunca retrocede
            await A.transaction('BBDD/negocio/ventas/ultimo_numero', (a) => Math.max(Number(a) || 0, 100));
            await B.transaction('BBDD/negocio/ventas/ultimo_numero', (a) => Math.max(Number(a) || 0, 90));
        }
        resultado[pol.nombre] = leerDe(s.datos, 'BBDD/negocio/ventas/ultimo_numero');
    }
    nota('antes -> contador final en la nube: ' + resultado.antes);
    nota('faseA -> contador final en la nube: ' + resultado.faseA);
    check('T5 · con la política antigua el contador retrocede (fallo documentado)', resultado.antes === 90);
    check('T5 · con Fase A el contador nunca retrocede', resultado.faseA === 100);
}

console.log('\nT6 · Cliente sin permiso de nube: no se sube nada y no se pierde nada');
{
    const resultado = {};
    for (const pol of [ANTES, FASE_A]) {
        const s = crearServidor();
        s.cloudSync = false;                                 // el cliente no paga
        const dev = crearDispositivo('equipo', s, pol);
        await guardarVenta(dev, { id: 'V-1', total: 5 }, pol);
        await cargarPOS(dev, pol);
        resultado[pol.nombre] = {
            enEquipo: leerLocalJson(dev, 'pos_sales').length,
            enNube: (leerDe(s.datos, 'BBDD/negocio/ventas/historial') || []).length,
            pendiente: hayAlgunPendiente(dev)
        };
    }
    nota('antes -> equipo: ' + resultado.antes.enEquipo + ' | nube: ' + resultado.antes.enNube + ' | pendiente: ' + resultado.antes.pendiente);
    nota('faseA -> equipo: ' + resultado.faseA.enEquipo + ' | nube: ' + resultado.faseA.enNube + ' | pendiente: ' + resultado.faseA.pendiente);
    check('T6 · sin permiso no se escribe en la nube (las dos políticas)',
        resultado.antes.enNube === 0 && resultado.faseA.enNube === 0);
    check('T6 · los datos del cliente se conservan en su equipo (las dos políticas)',
        resultado.antes.enEquipo === 1 && resultado.faseA.enEquipo === 1);
    check('T6 · con Fase A queda marcado como pendiente (se subirá si algún día paga)', resultado.faseA.pendiente === true);
}

/* ============ 4. INVARIANTES SOBRE LOS ARCHIVOS REALES ============ */
console.log('\n================ B. ARCHIVOS REALES ================\n');
const PAGINAS = [
    { archivo: 'inventario.html', modulo: 'inventario', sube: true },
    { archivo: 'mini_market_pos.html', modulo: 'pos', sube: true },
    { archivo: 'compras.html', modulo: 'compras', sube: true },
    { archivo: 'catalogo.html', modulo: 'catalogo', sube: true, descarga: false },  // solo sube: no tiene función de descarga
    { archivo: 'cuentas.html', modulo: 'cuentas', sube: true },
    { archivo: 'config_recibo.html', modulo: 'config_recibo', sube: false },  // página de solo lectura
    { archivo: 'gestion_empresa.html', modulo: 'empresa', sube: true },
    { archivo: 'gestion_proveedores.html', modulo: 'proveedores', sube: true },
    { archivo: 'listado_clientes.html', modulo: 'clientes', sube: true },
    { archivo: 'mini_market_pos_resumen.html', modulo: 'resumen', sube: false }
];

for (const p of PAGINAS) {
    let t;
    try { t = fs.readFileSync(p.archivo, 'utf8'); }
    catch (e) { check(p.archivo + ' existe', false, e.message); continue; }

    check(p.archivo + ' · carga sincronizacion.js', /<script[^>]+src=["']sincronizacion\.js["']/.test(t));
    if (p.descarga !== false) {
        check(p.archivo + ' · tiene la guardia de descarga (puedeSobrescribirLocalSync)', t.includes('puedeSobrescribirLocalSync'));
    }
    check(p.archivo + ' · ya no borra la marca global compartida',
        !/removeItem\(\s*['"]_pendingFirebaseChanges['"]\s*\)/.test(t));
    if (p.sube) {
        check(p.archivo + ' · marca pendiente de "' + p.modulo + '" antes de subir',
            t.includes("marcarPendienteSync('" + p.modulo + "')"));
        check(p.archivo + ' · limpia el pendiente de "' + p.modulo + '"',
            t.includes("limpiarPendienteSync('" + p.modulo + "')"));
    }
    const bloques = [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    let errorSintaxis = '';
    for (const b of bloques) {
        try { new vm.Script(b); } catch (e) { errorSintaxis = e.message; break; }
    }
    check(p.archivo + ' · sintaxis de sus scripts en línea', !errorSintaxis, errorSintaxis);
}

try {
    const helper = fs.readFileSync('sincronizacion.js', 'utf8');
    let err = '';
    try { new vm.Script(helper); } catch (e) { err = e.message; }
    check('sincronizacion.js · sintaxis', !err, err);
    const funciones = ['marcarPendienteSync', 'limpiarPendienteSync', 'hayPendientesSync', 'pendientesSync', 'puedeSobrescribirLocalSync', 'subirConMarcaSync'];
    check('sincronizacion.js · expone las 6 funciones', funciones.every((f) => helper.includes('window.' + f + ' =')));
} catch (e) { check('sincronizacion.js existe', false, e.message); }

try {
    const pos = fs.readFileSync('mini_market_pos.html', 'utf8').replace(/\/\/[^\n]*/g, '');
    check('mini_market_pos.html · ya no llama a la función inexistente fbReserveSaleNumber', !/fbReserveSaleNumber\s*\(/.test(pos));
    check('mini_market_pos.html · el contador de la nube usa transaction (no puede retroceder)', /ultimo_numero'\)\.transaction/.test(pos));
} catch (e) { check('mini_market_pos.html legible', false, e.message); }

/* ============ 5. AYUDANTE REAL: sincronizacion.js en un sandbox ============ */
console.log('\n================ C. AYUDANTE sincronizacion.js ================\n');
{
    const almacen = {};
    const ctx = {
        console, Date, JSON, Object, String, Number, isNaN, parseInt,
        localStorage: {
            getItem: (k) => (k in almacen ? almacen[k] : null),
            setItem: (k, v) => { almacen[k] = String(v); },
            removeItem: (k) => { delete almacen[k]; },
            key: (i) => Object.keys(almacen)[i],
            get length() { return Object.keys(almacen).length; }
        }
    };
    ctx.window = ctx;
    const sandbox = vm.createContext(ctx);
    vm.runInContext(fs.readFileSync('sincronizacion.js', 'utf8'), sandbox);
    const w = sandbox.window;
    const claves = () => Object.keys(almacen);
    w.sanitizeEmailForDb = (e) => String(e).trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');

    // 1) Sin sesión todavía (el ayudante se carga en el <head>): no debe migrar nada
    almacen['_pendingFirebaseChanges'] = 'true';
    w.pendientesSync();
    check('C1 · sin sesión no se crean marcas "sin_sesion"',
        !claves().some((k) => k.indexOf('_pendSync_') === 0), JSON.stringify(claves()));

    // 2) Con sesión, la marca antigua se convierte en marcas por módulo (solo los que escriben)
    w.getCurrentUserEmail = () => 'cliente@ejemplo.com';
    const migrados = w.pendientesSync();
    check('C2 · la marca antigua se migra a los 8 módulos que escriben (sin "resumen")',
        migrados.length === 8 && migrados.indexOf('resumen') === -1, JSON.stringify(migrados));

    migrados.forEach((m) => w.limpiarPendienteSync(m));
    check('C3 · sin pendientes se puede descargar de la nube', w.puedeSobrescribirLocalSync() === true);
    check('C4 · hayPendientesSync() queda en falso tras limpiar todos', w.hayPendientesSync() === false);

    w.marcarPendienteSync('pos');
    check('C5 · marcar "pos" lo deja pendiente', w.hayPendientesSync('pos') === true);
    check('C6 · marcar "pos" NO marca a otro módulo', w.hayPendientesSync('inventario') === false);
    check('C7 · la marca nueva ya no escribe la marca antigua compartida',
        almacen['_pendingFirebaseChanges'] === undefined);
    check('C8 · con un pendiente reciente no se descarga encima', w.puedeSobrescribirLocalSync() === false);

    // 3) Un pendiente VIEJO de otro módulo no puede congelar la app para siempre
    w.limpiarPendienteSync('pos');
    const claveCompras = '_pendSync_compras_cliente_at_ejemplo_com';
    almacen[claveCompras] = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    check('C9 · un pendiente viejo de otro módulo no bloquea la descarga', w.puedeSobrescribirLocalSync() === true);
    check('C10 · pero ese módulo sigue subiendo primero al abrir su página', w.hayPendientesSync('compras') === true);
    almacen[claveCompras] = new Date().toISOString();
    check('C11 · un pendiente reciente de otro módulo sí bloquea la descarga', w.puedeSobrescribirLocalSync() === false);

    w.olvidarPendientesSync();
    check('C12 · olvidarPendientesSync deja todo limpio (reinicio de fábrica)',
        !claves().some((k) => k.indexOf('_pendSync_') === 0) && almacen['_pendingFirebaseChanges'] === undefined);
}

console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
console.log('Nota: T2 (multi-dispositivo) sigue abierto a propósito: es la Fase B del informe.');
process.exit(fallos === 0 ? 0 : 1);
})();
