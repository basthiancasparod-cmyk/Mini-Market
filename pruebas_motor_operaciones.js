/* =====================================================================
   PRUEBAS DEL MOTOR DE OPERACIONES (Fase B de AUDITORIA_REPLICACION_SYNC.md)

   Se ejecuta con:  node pruebas_motor_operaciones.js

   QUÉ HACE
   --------
   No toca ningún archivo de la aplicación. Modela DOS motores de sincronización
   sobre el mismo servidor simulado y el mismo mock de Firebase v8, y compara el
   antes/después de cada escenario:

     * `clasico`     = el comportamiento de HOY: se sube el ARREGLO COMPLETO
                       (pos_sales.length ventas -> un solo .set) y al descargar se
                       REEMPLAZA lo local. Dos equipos se pisan entre sí.
     * `operaciones` = el diseño de DISENO_MOTOR_OPERACIONES.md: cola durable en
                       OPFS (append-only) escrita ANTES de tocar la red, subida
                       idempotente por operación (<deviceId>_<secuencia>),
                       confirmación antes de marcar/liberar, ventana caliente de
                       30 días y nube como fuente de verdad del histórico.

   MOCK FIEL (semántica ya verificada del SDK v8, ver pruebas_sincronizacion.js)
   --------------------------------------------------------------------------
   * Con conexión, `.set()` resuelve cuando el SERVIDOR confirma.
   * SIN conexión la promesa queda PENDIENTE y la escritura vive solo en la cola
     en memoria del SDK: si se "cierra el navegador", se pierde. Por eso el motor
     nuevo escribe en la cola DURABLE antes de intentar subir.
   * `.set()` rechaza si las reglas lo niegan (permission_denied).

   Formato: OK/FALLA por comprobación, resumen final y código de salida.
   ===================================================================== */
'use strict';

let ok = 0, fallos = 0;
const check = (nombre, condicion, extra = '') => {
    if (condicion) { ok++; console.log('OK    ' + nombre); }
    else { fallos++; console.log('FALLA ' + nombre + (extra !== '' ? '  -> ' + extra : '')); }
};
const nota = (t) => console.log('      ' + t);
const aviso = (t) => console.log('      [!] ' + t);
const titulo = (t) => console.log('\n' + t);
const json = (v) => JSON.stringify(v);

/* ===================== 1. SERVIDOR (Firebase RTDB simulado) ============= */

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

function crearServidor() {
    return {
        datos: {},
        cloudSync: true,
        modoSync: 'operaciones'
    };
}

/* Estado de red. `online:false` = .set() queda pendiente (mock fiel del SDK v8). */
function desconectarRed(s, nav) { s.online = false; if (nav) { nav.online = false; nav.conectado = false; } return new Promise(r => setImmediate(r)); }
/* Al reconectar, el SDK vacía su cola en memoria Y la app vuelve a preguntar el
   permiso de nube (Fase A, C6): el permiso no queda pegado en true tras la caída. */
async function reconectarRed(s, nav) {
    s.online = true;
    if (nav) { nav.online = true; nav.conectado = true; nav.guardia = true; reconectar(nav); }
    await new Promise(r => setImmediate(r));
}

/* Simula que checkCloudAccess() quedó cacheado en true durante una caída de red:
   es el caso real en el que el POS llama a fbSaveVentas() estando sin conexión. */
async function hacerPasarGuardia(nav) { nav.guardia = false; await new Promise(r => setImmediate(r)); }

/* Simula el ciclo de vida de una escritura del SDK v8. */
/* Las escrituras pendientes viven en la conexión de CADA pestaña (no en el servidor):
   si la pestaña se cierra, esa cola en memoria se va con ella. */
function servidorSet(conexion, ruta, valor) {
    return new Promise((resolve, reject) => {
        if (!conexion.online) { conexion.pendientes.push({ ruta, valor, resolve }); return; }
        if (conexion.fallarOps && ruta.indexOf('/ops/') !== -1) {
            const e = new Error('PERMISSION_DENIED: rules denied write at ' + ruta);
            e.code = 'PERMISSION_DENIED';
            reject(e);
            return;
        }
        conexion.escrituras++;
        escribirEn(conexion.datos, ruta, valor);
        resolve(true);
    });
}

/* El equipo "se reconecta": el SDK vacía su cola en memoria. */
function reconectar(conexion) {
    conexion.online = true;
    const cola = conexion.pendientes; conexion.pendientes = [];
    for (const o of cola) { conexion.escrituras++; escribirEn(conexion.datos, o.ruta, o.valor); o.resolve(true); }
}

const EMAIL_PATH = 'negocio_at_ejemplo_com';
const RAIZ = 'BBDD/' + EMAIL_PATH;
const rutaOps = (tipo) => RAIZ + '/ops/' + tipo;
const rutaOp = (op) => rutaOps(op.tipo) + '/' + op.deviceId + '_' + String(op.secuencia).padStart(4, '0');
const rutaVentasClasico = RAIZ + '/ventas/historial';
const rutaIndice = (fecha) => RAIZ + '/ventas_idx/' + fecha;
const rutaSuscripcion = RAIZ + '/suscripcion/';

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
}

/* ===================== 2. DISCO DEL NAVEGADOR ========================== */

/* `local`      = localStorage: rápido, pequeño, CUOTA de ~5 MB, se pierde al
                  "reiniciar de fábrica". Es donde vive el estado clásico.
   `caliente`   = OPFS: ventana de 30 días (ventas/compras/movimientos) + todos
                  los productos/clientes/cuentas.
   `cola`       = OPFS: cola durable append-only, una entrada por operación.
   Como OPFS es disco, todo esto SOBREVIVE al cierre del navegador. */
function crearDisco() { return { local: {}, caliente: {}, cola: [] }; }

function reiniciarFabrica(disco) { disco.local = {}; disco.caliente = {}; disco.cola = []; }

/* ===================== 3. NAVEGADOR Y EQUIPO =========================== */

function crearNavegador(id, disco, servidor) {
    return {
        id, disco, servidor,
        datos: servidor.datos,             // la base es del servidor, compartida
        online: true,
        conectado: true,
        cerrado: false,
        guardia: true,                     // true = checkCloudAccess() responde de verdad
        modoSyncCacheado: undefined,       // como sessionStorage: se pierde al cerrar
        pendientes: [],                    // cola EN MEMORIA del SDK de ESTA pestaña
        escrituras: 0,
        fallarOps: false,                  // interruptor de prueba: las reglas niegan ops/*
        estaConectado() { return this.conectado && !this.cerrado; },
        desconectar() { this.conectado = false; this.online = false; },
        reconectar() { this.conectado = true; reconectar(this); },
        /* Cerrar el navegador = la pestaña se va: la cola en memoria del SDK se pierde
           (es la pérdida documentada), pero el DISCO (localStorage + OPFS) queda. */
        cerrar() { this.cerrado = true; this.conectado = false; this.online = false; this.pendientes = []; },
        abrir() { this.cerrado = false; this.conectado = true; this.online = true; this.guardia = true; this.modoSyncCacheado = undefined; },
        /* .set() con la semántica del SDK v8 (ver cabecera). */
        set(ruta, valor) {
            if (this.cerrado) return Promise.reject(new Error('navegador cerrado'));
            return servidorSet(this, ruta, valor);   // sin red: queda pendiente
        },
        /* BBDD/<emailPath>/suscripcion/modoSync. Si no existe o falla -> 'clasico'. */
        async leerModoSync() {
            if (this.modoSyncCacheado !== undefined) return this.modoSyncCacheado;
            try {
                if (!this.estaConectado()) return 'clasico';       // sin red: no se inventa un modo
                const v = leerDe(this.servidor.datos, rutaSuscripcion + 'modoSync');
                const modo = (v === 'operaciones') ? 'operaciones' : 'clasico';
                this.modoSyncCacheado = modo;
                return modo;
            } catch (e) { return 'clasico'; }
        },
        /* Permiso de nube del cliente (suscripcion/cloudSync). Sin red NO se cachea el fallo. */
        async checkCloudAccess() {
            if (!this.guardia) return this.servidor.cloudSync === true;
            if (!this.estaConectado()) return false;
            return this.servidor.cloudSync === true;
        }
    };
}

/* ===================== 4. MOTOR CLÁSICO (lo de hoy) ==================== */

function crearMotorClasico(nav) { return { tipo: 'clasico', nav }; }

async function clasicoGuardarVenta(m, venta) {
    // Camino real de processSale(): guarda en localStorage y luego llama a
    // fbSaveVentas(ventas) SIN volver a comprobar el permiso, así que el .set() se
    // ejecuta y, sin conexión, queda pendiente en la cola en memoria del SDK.
    return clasicoVenderSinCola(m, venta);
}

/* Abrir el POS: sube lo pendiente o descarga REEMPLAZANDO (si puede).
   `tienePendiente` = la marca durable de Fase A (`_pendSync_pos_<negocio>`) sobrevive
   al cierre, así que la página sube ANTES de descargar y no se pisa a sí misma. */
async function clasicoAbrir(m, { tienePendiente = false } = {}) {
    const d = m.nav.disco;
    if (tienePendiente) {
        if (await m.nav.checkCloudAccess()) {
            if ((d.local.ventas || []).length) await m.nav.set(rutaVentasClasico, d.local.ventas);
            return 'sube';
        }
        return 'no sube (sin nube)';
    }
    if (!(await m.nav.checkCloudAccess())) return 'sin nube: no descarga';
    const nube = leerDe(m.nav.servidor.datos, rutaVentasClasico);
    d.local.ventas = nube ? clonar(nube) : [];      // REEMPLAZA: lo local se pierde
    return 'descarga (reemplaza lo local)';
}

/* Venta sin cola durable: append al arreglo local + `.set()` que puede quedar
   pendiente en el SDK. Es la base de las dos variantes clásicas (con y sin Fase A). */
async function clasicoVenderSinCola(m, venta) {
    const d = m.nav.disco;
    d.local.ventas = d.local.ventas || [];
    d.local.ventas.push(venta);
    if (!(await m.nav.checkCloudAccess())) return { subida: false, encoladoEnSdk: false };
    m.nav.set(rutaVentasClasico, d.local.ventas);   // ARREGLO COMPLETO
    return { subida: true, encoladoEnSdk: !m.nav.online };
}

/* Clásico PRE Fase A: no hay marca durable de pendientes, así que al reabrir la
   página la venta hecha sin conexión se pisa con el arreglo de la nube (hallazgo C1). */
const clasicoVenderSinFaseA = clasicoVenderSinCola;

/* Clásico CON Fase A (lo que hay hoy en la rama): pone la marca ANTES de subir y la
   limpia solo si el servidor confirma. La marca vive en localStorage y sobrevive al
   cierre, así que al reabrir recupera el pendiente. Solo se pierde si ese
   localStorage se purga o está lleno (guardarLocalSeguro falla). */
async function clasicoVenderConFaseA(m, venta) {
    const d = m.nav.disco;
    d.local.ventas = d.local.ventas || [];
    d.local.ventas.push(venta);
    d.local.marca = true;                                   // marcarPendienteSync('pos')
    m.nav.set(rutaVentasClasico, d.local.ventas)
        .then(() => { d.local.marca = false; })              // limpiarPendienteSync('pos')
        .catch(() => { d.local.marca = true; });
    return { subida: true, encoladoEnSdk: !m.nav.online };
}

/* Sube el arreglo COMPLETO tal cual lo llama processSale(). Es lo que pisa al otro equipo. */
async function clasicoSubirArreglo(m) {
    if (!(await m.nav.checkCloudAccess())) return false;
    await m.nav.set(rutaVentasClasico, m.nav.disco.local.ventas || []);
    return true;
}

function clasicoEstado(m) {
    const d = m.nav.disco;
    return {
        equipo: {
            ventas: (d.local.ventas || []).map(v => v.id),
            productos: (d.local.productos || []).map(p => p.id),
            colaSdkPendiente: m.nav.pendientes.length
        },
        nube: {
            ventas: (leerDe(m.nav.servidor.datos, rutaVentasClasico) || []).map(v => v.id)
        }
    };
}

/* ===================== 5. MOTOR DE OPERACIONES ========================= */

const VENTANA_CALIENTE_DIAS = 30;
const DIA_MS = 24 * 60 * 60 * 1000;

function crearMotorOperaciones(nav) {
    return {
        tipo: 'operaciones',
        nav,
        indice: {},              // ventas_idx reconstruible
        historicoLocal: []       // caché de consultas bajo demanda (no es caliente)
    };
}

/* `pos_last_sale_number` del equipo: vive en disco (localStorage), no en memoria,
   así que sobrevive al cierre y NO se comparte con otros equipos. */
function siguienteSecuencia(m) {
    var seq = Number(m.nav.disco.local.seq) || 0;
    seq++;
    m.nav.disco.local.seq = seq;
    return seq;
}

const ah = (ms) => new Date(ms).toISOString();
const fechaDia = (iso) => String(iso).slice(0, 10);

/* --- 5.1 Cola durable (cola.jsonl en OPFS) --- */

function encolar(m, op) {
    const disco = m.nav.disco;
    // append-only + flush: queda en DISCO antes de tocar la red.
    disco.cola.push({
        clave: claveCola(op),
        tipo: op.tipo,
        payload: op,
        estado: 'pendiente',
        intentos: 0,
        ts: op.fechaISO
    });
}

/* La clave es `tipo/<deviceId>_<secuencia a 4 dígitos>`: es la ruta de la nube y la
   clave de idempotencia y de la cola. */
function claveCola(op) { return op.tipo + '/' + op.deviceId + '_' + String(op.secuencia).padStart(4, '0'); }
const secuenciaDeClave = (clave) => Number(String(clave).slice(String(clave).lastIndexOf('_') + 1));

function entradaCola(m, op) {
    return m.nav.disco.cola.find(e => e.clave === claveCola(op));
}

function resumenCola(m) {
    const c = { pendiente: 0, subida: 0, fallo: 0, conflicto: 0 };
    for (const e of m.nav.disco.cola) c[e.estado] = (c[e.estado] || 0) + 1;
    return c;
}

/* --- 5.2 Ventana caliente --- */

function opsCalientes(m, tipo) {
    const arr = m.nav.disco.caliente[tipo] || [];
    return arr.filter(o => o.tipo === tipo);
}

function esCaliente(fechaISO, ahoraMs) {
    return !fechaISO || (ahoraMs - Date.parse(fechaISO)) <= VENTANA_CALIENTE_DIAS * DIA_MS;
}

function guardarCaliente(m, tipo, op) {
    const c = m.nav.disco.caliente;
    c[tipo] = c[tipo] || [];
    const i = c[tipo].findIndex(o => o.id === op.id);
    if (i === -1) c[tipo].push(op); else c[tipo][i] = op;
}

function guardarDoc(m, nombre, claveRuta, valor) {
    const c = m.nav.disco.caliente;
    c[nombre] = c[nombre] || {};
    c[nombre][claveRuta] = valor;
}

/* --- 5.3 Aplicar una operación a memoria/caliente --- */

function claveNaturalCliente(p) {
    return p.documento
        ? String(p.documento).replace(/[.#$/\[\]]/g, '_')
        : (String(p.nombre || '') + '_' + String(p.telefono || '')).replace(/[.#$/\[\]]/g, '_');
}

/* Merge de producto POR CAMPO: gana el mtime más reciente de cada campo.
   `payload.fijos` son los campos que no son "de edición" (id, nombre, etc.) y que
   viajan en la operación para que un equipo nuevo pueda reconstruir el producto. */
function fusionarProducto(local, payload, fechaISO) {
    const base = Object.assign({}, local || {}, payload.fijos || {});
    const mtMapa = Object.assign({}, (local && local.camposMtime) || {});
    const mtLocal = mtMapa[payload.campo] || (local && local.mtime) || '1970-01-01T00:00:00.000Z';
    if (fechaISO >= mtLocal) {
        base[payload.campo] = payload.valor;
        mtMapa[payload.campo] = fechaISO;
    }
    base.camposMtime = mtMapa;
    base.mtime = fechaISO > ((local && local.mtime) || '') ? fechaISO : (local && local.mtime) || fechaISO;
    return base;
}

function aplicarOperacion(m, op) {
    const c = m.nav.disco.caliente;
    switch (op.tipo) {
        case 'venta':
            guardarCaliente(m, 'venta', op);
            m.indice[fechaDia(op.fechaISO)] = m.indice[fechaDia(op.fechaISO)] || {};
            m.indice[fechaDia(op.fechaISO)][op.id] = {
                total: op.payload.total, items: op.payload.productos.length, metodo: op.payload.metodo
            };
            break;
        case 'compra':
            guardarCaliente(m, 'compra', op);
            break;
        case 'movimiento':
            guardarCaliente(m, 'movimiento', op);
            break;
        case 'producto':
            guardarDoc(m, 'producto', op.payload.id, fusionarProducto(c.producto && c.producto[op.payload.id], op.payload, op.fechaISO));
            break;
        case 'cliente':
            guardarDoc(m, 'cliente', op.payload.clave, fusionarProducto(c.cliente && c.cliente[op.payload.clave], op.payload, op.fechaISO));
            break;
        case 'cuenta':
            guardarDoc(m, 'cuenta', op.payload.clave, fusionarProducto(c.cuenta && c.cuenta[op.payload.clave], op.payload, op.fechaISO));
            break;
        default: throw new Error('tipo de operación desconocido: ' + op.tipo);
    }
}

/* --- 5.4 Registrar (encolar ANTES de la red) --- */

function registrarOperacion(m, op) {
    op.deviceId = op.deviceId || m.nav.id;
    op.tipo = op.tipo;
    op.version = 1;
    op.id = op.id || (m.nav.id + '_' + siguienteSecuencia(m));
    op.fechaISO = op.fechaISO || new Date().toISOString();
    encolar(m, op);            // 1) disco, append-only
    aplicarOperacion(m, op);   // 2) memoria/caliente: la venta ya se puede cobrar
    return op;
}

function ventaPayload(total, metodo, nItems, id, anterior) {
    return {
        id, total, metodo, moneda: 'USD',
        productos: [{ producto: 'HARINA-PAN', cantidad: nItems, precio: total / nItems }],
        anula: anterior
    };
}

function registrarVenta(m, datos) {
    const deviceId = (datos && datos.deviceId) || m.nav.id;
    const secuencia = (datos && datos.secuencia) || siguienteSecuencia(m);
    const fechaISO = (datos && datos.fechaISO) || new Date().toISOString();
    const id = (datos && datos.id) || 'V-LOCAL-' + deviceId + '-' + String(secuencia).padStart(4, '0');
    return registrarOperacion(m, {
        tipo: 'venta', deviceId, id, secuencia, fechaISO, operador: 'maria',
        payload: ventaPayload(datos.total, datos.metodo || 'efectivo', datos.nItems || 1, id, datos.anterior)
    });
}

function registrarProducto(m, campos) {
    const { id, campo, valor, fechaISO, deviceId } = campos;
    return registrarOperacion(m, {
        tipo: 'producto', deviceId,
        id: campos.opId,
        // Toda operación lleva secuencia: es su orden de subida, no solo la de ventas.
        secuencia: campos.secuencia || siguienteSecuencia(m),
        fechaISO: fechaISO || new Date().toISOString(), operador: 'maria',
        // `fijos` = datos que no cambian (nombre, etc.) para reconstruir el producto en frío.
        payload: { id, campo, valor, fijos: campos.fijos || {} }
    });
}

/* --- 5.5 Subir en orden de secuencia, con confirmación --- */

function pendientesEnOrden(m) {
    return m.nav.disco.cola
        .filter(e => e.estado === 'pendiente' || e.estado === 'fallo' || e.estado === 'conflicto')
        .sort((a, b) => secuenciaDeClave(a.clave) - secuenciaDeClave(b.clave));
}

async function subirOperacion(m, op) {
    const ruta = rutaOp(op);
    const yaEsta = leerDe(m.nav.servidor.datos, ruta);
    if (yaEsta) {
        // Idempotencia por clave: si el contenido es el mismo, no se reescribe nada.
        if (deepEqual(yaEsta, clonar(op))) return 'ya-estaba';
        return 'conflicto';                       // misma clave, contenido distinto: NUNCA se pisa
    }
    await m.nav.set(ruta, op);                    // resuelve solo si el servidor confirmó
    // Índice de agregados: misma clave que la operación, escrito SOLO tras confirmarla.
    await m.nav.set(rutaIndice(fechaDia(op.fechaISO)) + '/' + claveIndice(op), {
        total: op.payload.total, items: op.payload.productos ? op.payload.productos.length : 0, metodo: op.payload.metodo
    });
    return 'subida';
}

/* Vaciado de la cola. Devuelve un resumen para los escenarios. */
async function sincronizar(m, { liberar = true } = {}) {
    const r = { intentadas: 0, subidas: 0, yaEstaban: 0, fallos: 0, conflictos: 0, liberadas: [] };
    const nav = m.nav;
    if (!nav.estaConectado()) return r;                      // sin red: la cola espera
    if (!(await nav.checkCloudAccess())) return r;
    // Orden por SECUENCIA del equipo (no por orden de inserción).
    for (const e of pendientesEnOrden(m)) {
        r.intentadas++;
        let res;
        try { res = await subirOperacion(m, e.payload); }
        catch (err) {
            e.estado = 'fallo';
            e.intentos++;
            e.error = err.code || err.message;
            r.fallos++;
            break;                                            // no se salta el orden
        }
        if (res === 'subida' || res === 'ya-estaba') {
            // Se marca `subida` SOLO tras la confirmación del servidor.
            e.estado = 'subida';
            e.intentos++;
            if (res === 'ya-estaba') r.yaEstaban++; else r.subidas++;
        } else if (res === 'conflicto') {
            e.estado = 'conflicto';
            e.intentos++;
            r.conflictos++;
        }
    }
    if (liberar) r.liberadas = liberarCaliente(m);
    return r;
}

/* --- 5.6 Liberar de caliente SOLO si está confirmada y tiene más de 30 días --- */

function liberarCaliente(m, ahoraMs = Date.now()) {
    const c = m.nav.disco.caliente;
    const liberadas = [];
    for (const tipo of ['venta', 'compra', 'movimiento']) {
        const arr = c[tipo] || [];
        const quedan = [];
        for (const op of arr) {
            const e = entradaCola(m, op);
            const confirmada = e && e.estado === 'subida';
            const vieja = (ahoraMs - Date.parse(op.fechaISO)) > VENTANA_CALIENTE_DIAS * DIA_MS;
            if (confirmada && vieja) liberadas.push(op.id); else quedan.push(op);
        }
        c[tipo] = quedan;
    }
    return liberadas;
}

/* --- 5.7 Descarga / unión --- */

function opsNube(servidor, tipo) {
    const nodo = leerDe(servidor.datos, rutaOps(tipo)) || {};
    return Object.keys(nodo).map(k => nodo[k]).sort((a, b) => {
        const f = String(a.fechaISO).localeCompare(String(b.fechaISO));
        return f !== 0 ? f : (a.deviceId + a.secuencia).localeCompare(b.deviceId + b.secuencia);
    });
}

/* Equipo nuevo: baja productos/clientes/cuentas + la ventana de 30 días. */
async function descargarVentana(m, ahoraMs = Date.now()) {
    const nav = m.nav;
    if (!nav.estaConectado() || !(await nav.checkCloudAccess())) return { productos: 0, ventas: 0 };
    for (const tipo of ['producto', 'cliente', 'cuenta']) {
        for (const op of opsNube(nav.servidor, tipo)) aplicarOperacion(m, op);
    }
    let ventas = 0;
    for (const tipo of ['venta', 'compra', 'movimiento']) {
        for (const op of opsNube(nav.servidor, tipo)) {
            if (esCaliente(op.fechaISO, ahoraMs)) { aplicarOperacion(m, op); if (tipo === 'venta') ventas++; }
        }
    }
    clavesFaltantesEnIndice(m);
    return { productos: Object.keys(m.nav.disco.caliente.producto || {}).length, ventas };
}

/* Igual que syncFromFirebase(): el equipo que llega nuevo toma el consecutivo de la
   nube para no reutilizar una secuencia ya usada por ESTE dispositivo. */
function reservarSecuenciaDesdeNube(m) {
    let max = 0;
    for (const tipo of ['venta', 'compra', 'movimiento', 'producto', 'cliente', 'cuenta']) {
        for (const op of opsNube(m.nav.servidor, tipo)) {
            if (op.deviceId === m.nav.id && op.secuencia > max) max = op.secuencia;
        }
    }
    const local = Number(m.nav.disco.local.seq) || 0;
    if (max > local) m.nav.disco.local.seq = max;
    return m.nav.disco.local.seq;
}

/* Histórico anterior a la ventana: se pide a la nube BAJO DEMANDA y PAGINADO. */
async function consultarHistoricoPaginado(m, { hastaDias = 30, tamano = 200, ahoraMs = Date.now() } = {}) {
    const limite = ah(ahoraMs - hastaDias * DIA_MS);
    const todas = opsNube(m.nav.servidor, 'venta').filter(o => o.fechaISO < limite);
    const paginas = [];
    for (let i = todas.length; i > 0; i -= tamano) paginas.push(todas.slice(Math.max(0, i - tamano), i));
    const leidas = [];
    for (const p of paginas) {
        for (const op of p) leidas.push(op);
        // Se muestra y se guarda en un caché de consulta, NUNCA en caliente.
    }
    m.historicoLocal = m.historicoLocal.concat(leidas);
    return { paginas: paginas.length, operaciones: leidas.length, ids: leidas.map(o => o.id) };
}

/* El índice es derivable: si le falta alguna clave de operación (o la entrada existe
   pero está vacía), hay que reconstruirlo desde ops/venta. Se comparan CLAVES, no
   solo recuentos: así también se detecta una entrada borrada o pisada. */
function clavesFaltantesEnIndice(m) {
    const idx = leerDe(m.nav.servidor.datos, RAIZ + '/ventas_idx') || {};
    const faltantes = [];
    for (const op of opsNube(m.nav.servidor, 'venta')) {
        const dia = fechaDia(op.fechaISO);
        const entrada = (idx[dia] || {})[claveIndice(op)];
        if (!entrada || typeof entrada !== 'object' || entrada.total === undefined) faltantes.push(dia + '/' + claveIndice(op));
    }
    return faltantes;
}

/* --- 5.8 Límites de almacenamiento --- */

/* Plan gratuito: 1 GB. Se borra lo MÁS ANTIGUO (de caliente y de la cola ya
   confirmada) hasta bajar del 90 %. Nunca toca la nube: no hay nube. */
function planGratuito(m, { limiteMB = 1024, pesoBytes = 2048, umbral = 100, recorte = 90 } = {}) {
    const limiteBytes = limiteMB * 1048576;
    let peso = 0;
    for (const tipo of ['venta', 'compra', 'movimiento']) peso += opsCalientes(m, tipo).length * pesoBytes;
    for (const doc of ['producto', 'cliente', 'cuenta']) peso += Object.keys(m.nav.disco.caliente[doc] || {}).length * pesoBytes;
    peso += m.nav.disco.cola.length * 256;
    const porcentaje = Math.round((peso / limiteBytes) * 1000) / 10;
    if (porcentaje < umbral) return { accion: 'nada', porcentaje, borradas: 0, ids: [] };
    const objetivo = limiteBytes * recorte / 100;
    const eventos = [];
    for (const tipo of ['venta', 'compra', 'movimiento']) {
        for (const op of opsCalientes(m, tipo)) eventos.push({ tipo, op });
    }
    eventos.sort((a, b) => String(a.op.fechaISO).localeCompare(String(b.op.fechaISO)));  // más antiguo primero
    const ids = [];
    const aBorrar = {};
    for (const ev of eventos) {
        if (peso <= objetivo) break;
        (aBorrar[ev.tipo] = aBorrar[ev.tipo] || {})[ev.op.id] = true;
        peso -= pesoBytes;
        ids.push(ev.op.id);
    }
    for (const tipo of Object.keys(aBorrar)) {
        m.nav.disco.caliente[tipo] = opsCalientes(m, tipo).filter(o => !aBorrar[tipo][o.id]);
    }
    return { accion: ids.length ? 'recortado' : 'lleno', porcentaje, borradas: ids.length, ids, pesoFinal: peso };
}

/* Con nube: sin límite práctico. Se libera tras confirmar y se conservan 30 días. */
function planConNube(m, { limiteMB = 1024, pesoBytes = 2048, ahoraMs = Date.now() } = {}) {
    const liberadas = liberarCaliente(m, ahoraMs);
    let peso = 0;
    for (const tipo of ['venta', 'compra', 'movimiento']) peso += opsCalientes(m, tipo).length * pesoBytes;
    return { accion: 'liberado', liberadas: liberadas.length, pesoBytes: peso, limiteBytes: limiteMB * 1048576 };
}

/* --- 5.9 Informes --- */

function estadoOps(m, ahoraMs = Date.now()) {
    const c = m.nav.disco.caliente;
    return {
        equipo: {
            caliente_ventas: opsCalientes(m, 'venta').map(o => o.id),
            caliente_ventas_fueraDeVentana: opsCalientes(m, 'venta').filter(o => !esCaliente(o.fechaISO, ahoraMs)).length,
            productos: Object.keys(c.producto || {}),
            clientes: Object.keys(c.cliente || {}),
            cuenta: Object.keys(c.cuenta || {}),
            cola: resumenCola(m),
            cola_pendientes: m.nav.disco.cola.filter(e => e.estado !== 'subida').map(e => e.payload.id)
        },
        nube: {
            ops_venta: opsNube(m.nav.servidor, 'venta').map(o => o.id),
            ops_producto: opsNube(m.nav.servidor, 'producto').map(o => o.payload.id + ':' + o.payload.campo + '=' + o.payload.valor),
            ops_cliente: opsNube(m.nav.servidor, 'cliente').map(o => o.payload.clave),
            productos: Object.keys(leerDe(m.nav.servidor.datos, rutaOps('producto')) || {}),
            dias_en_indice: Object.keys(leerDe(m.nav.servidor.datos, RAIZ + '/ventas_idx') || {})
        }
    };
}

/* ===================== 6. UTILIDADES DE ESCENARIO ====================== */

/* Dispositivo ficticio en la nube: se usa para "sembrar" operaciones viejas sin
   tener que simular el paso del tiempo. No es un equipo del negocio. */
function sembrarOperacion(servidor, tipo, deviceId, secuencia, fechaISO, payload) {
    const op = { id: payload.id || (tipo.toUpperCase() + '-SEED-' + deviceId + '-' + secuencia), tipo, deviceId, secuencia, fechaISO, operador: 'seed', version: 1, payload };
    const ruta = rutaOps(tipo) + '/' + deviceId + '_' + String(secuencia).padStart(4, '0');
    // Se devuelve una copia del valor ya escrito en la nube, como haría el motor real
    // con el objeto que recibe de una lectura.
    escribirEn(servidor.datos, ruta, op);
    escribirEn(servidor.datos, rutaIndice(fechaDia(fechaISO)) + '/' + deviceId + '_' + String(secuencia).padStart(4, '0'), {
        total: payload.total, items: payload.productos ? payload.productos.length : 0, metodo: payload.metodo
    });
    return leerDe(servidor.datos, ruta);
}

function claveIndice(op) { return op.deviceId + '_' + String(op.secuencia).padStart(4, '0'); }

/* Índice de agregados `ventas_idx/<día>/<clave>`: caché derivado, NUNCA fuente de
   verdad. Si falta o discrepa, se reconstruye desde ops/venta. */
function construirIndice(servidor, tipo) {
    const idx = {};
    for (const op of opsNube(servidor, tipo)) {
        const dia = fechaDia(op.fechaISO);
        idx[dia] = idx[dia] || {};
        idx[dia][claveIndice(op)] = {
            total: op.payload.total,
            items: op.payload.productos ? op.payload.productos.length : 0,
            metodo: op.payload.metodo
        };
    }
    return idx;
}

/* ===================== 7. ESCENARIOS ================================== */

(async function main() {
    console.log('========== PRUEBAS DEL MOTOR DE OPERACIONES (Fase B) ==========');
    console.log('Mock del SDK v8: con conexión .set() resuelve al confirmar el servidor;');
    console.log('sin conexión la promesa queda PENDIENTE y se pierde al cerrar el navegador.\n');

    /* ---------------- T1 ---------------- */
    titulo('T1 · Venta sin conexión + cierre del navegador + reconexión');
    {
        const r = {};
        const SALE = { id: 'V-LOCAL-7K3F9QAB-0001', total: 12 };
        // ---- clásico PRE Fase A: al reabrir descarga y pisa ----
        {
            const s = crearServidor();
            const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
            const m = crearMotorClasico(nav);
            await desconectarRed(s, nav);                      // la red se cae
            await hacerPasarGuardia(nav);
            const guardado = await clasicoVenderSinFaseA(m, SALE);
            const antes = clasicoEstado(m);                    // instante del cierre
            nav.cerrar();                                      // se cierra el navegador
            const alCerrar = clasicoEstado(m);                 // el .set() pendiente se fue con la pestaña
            nav.abrir(); await reconectarRed(s, nav);
            await clasicoAbrir(m, { tienePendiente: false });  // no hay marca durable
            r.sinFaseA = {
                antes,
                alCerrar,
                // Se congelan los números ANTES de que el siguiente bloque toque nada.
                antesVentas: antes.equipo.ventas.length,
                antesNube: antes.nube.ventas.length,
                alCerrarPendientes: alCerrar.equipo.colaSdkPendiente,
                despuesVentas: m.nav.disco.local.ventas.length,
                despuesNube: (leerDe(s.datos, rutaVentasClasico) || []).length,
                encoladoEnSdk: guardado.encoladoEnSdk
            };
            nota('clasico (pre Fase A) -> al apagarse: equipo ' + json(antes.equipo.ventas) +
                 ' | .set() pendiente en el SDK: ' + guardado.encoladoEnSdk + ' | nube ' + json(antes.nube.ventas));
            nota('                        la pestaña se cierra: el pendiente se pierde (' + alCerrar.equipo.colaSdkPendiente + ' en la cola del SDK)');
            nota('                        al reabrir: equipo ' + json(m.nav.disco.local.ventas.map(v => v.id)) +
                 ' | nube ' + json(r.sinFaseA.despuesNube));
        }
        // ---- clásico CON Fase A: la marca durable rescata la venta de localStorage ----
        {
            const s = crearServidor();
            const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
            const m = crearMotorClasico(nav);
            await desconectarRed(s, nav);
            await hacerPasarGuardia(nav);
            const guardado = await clasicoVenderConFaseA(m, SALE);
            const antes = clasicoEstado(m);
            nav.cerrar();
            const alCerrar = clasicoEstado(m);
            nav.abrir(); await reconectarRed(s, nav);
            const marca = !!(nav.disco.local.marca);
            await clasicoAbrir(m, { tienePendiente: marca });
            r.conFaseA = {
                antes, alCerrar,
                marca,
                antesVentas: antes.equipo.ventas.length,
                alCerrarNube: alCerrar.nube.ventas.length,
                despuesVentas: m.nav.disco.local.ventas.length,
                despuesNube: (leerDe(s.datos, rutaVentasClasico) || []).length
            };
            nota('clasico (con Fase A) -> al apagarse: equipo ' + json(antes.equipo.ventas) +
                 ' | marca durable: ' + marca + ' | nube ' + json(antes.nube.ventas));
            nota('                        al reabrir: equipo ' + json(m.nav.disco.local.ventas.map(v => v.id)) +
                 ' | nube ' + json((leerDe(s.datos, rutaVentasClasico) || []).map(v => v.id)) +
                 '  (rescate por el arreglo COMPLETO en localStorage, no por una cola)');
        }
        // ---- operaciones ----
        {
            const s = crearServidor();
            const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
            const m = crearMotorOperaciones(nav);
            const op = registrarVenta(m, { id: SALE.id, secuencia: 1, total: 12 });
            const colaAntes = resumenCola(m);
            nota('operaciones -> la operación ya está en la COLA DURABLE antes de tocar la red: ' + json(colaAntes));
            nav.cerrar();                                  // se cierra el navegador
            nav.abrir(); await reconectarRed(s, nav);      // vuelve la conexión
            await sincronizar(m);
            r.operaciones = estadoOps(m);
            nota('operaciones -> op.id: ' + op.id + ' | ruta en la nube: ' + rutaOp(op));
            nota('              equipo: ' + json(r.operaciones.equipo));
            nota('              nube:   ' + json(r.operaciones.nube));
        }
        check('T1 · clasico pre Fase A: la venta se PIERDE (se fue con la pestaña y la descarga pisa el resto)',
            r.sinFaseA.antesVentas === 1 && r.sinFaseA.antesNube === 0 &&
            r.sinFaseA.alCerrarPendientes === 0 &&
            r.sinFaseA.despuesVentas === 0 && r.sinFaseA.despuesNube === 0,
            json(r.sinFaseA));
        check('T1 · clasico con Fase A: se rescata solo porque la marca durable sobrevivió (nada de esto es una cola)',
            r.conFaseA.marca === true && r.conFaseA.alCerrarNube === 0 && r.conFaseA.despuesNube === 1,
            json(r.conFaseA));
        check('T1 · operaciones: la venta sobrevive al cierre y llega a la nube sin depender de localStorage',
            r.operaciones.equipo.caliente_ventas.length === 1 && r.operaciones.nube.ops_venta.length === 1,
            json(r.operaciones));
        aviso('En clasico el pendiente es un .set() en MEMORIA del SDK (más una marca en localStorage);');
        aviso('en operaciones la operación está en disco (OPFS) ANTES de intentar subir.');
    }

    /* ---------------- T2 ---------------- */
    titulo('T2 · Dos equipos vendiendo (uno sin conexión y luego reconecta)');
    {
        const r = {};
        // ---- clásico: dos dispositivos, cada uno con su estado local completo ----
        {
            const s = crearServidor();
            const navA = crearNavegador('AAAA1111', crearDisco(), s);
            const navB = crearNavegador('BBBB2222', crearDisco(), s);
            const A = crearMotorClasico(navA), B = crearMotorClasico(navB);
            await clasicoGuardarVenta(A, { id: 'V-LOCAL-AAAA1111-0001', total: 5 });   // A descargó y vendió
            // B estuvo sin conexión: vendió 2 veces sobre SU copia (que no tiene la venta de A)
            await desconectarRed(s, navB);
            await hacerPasarGuardia(navB);
            await clasicoGuardarVenta(B, { id: 'V-LOCAL-BBBB2222-0001', total: 7 });
            await clasicoGuardarVenta(B, { id: 'V-LOCAL-BBBB2222-0002', total: 9 });
            // B reconecta: el SDK vacía su cola y la página sube su ARREGLO COMPLETO
            await reconectarRed(s, navB);
            await clasicoSubirArreglo(B);
            nota('clasico     -> nube al reconectar B: ' + json((leerDe(s.datos, rutaVentasClasico) || []).map(v => v.id)));
            // A abre el POS. Ninguna de las dos ventas tiene marca de módulo (Fase A no
            // está activa en esta variante), así que A descarga y REEMPLAZA lo suyo.
            await clasicoAbrir(A, { tienePendiente: false });
            r.clasico = { A: clasicoEstado(A), B: clasicoEstado(B) };
            nota('clasico     -> nube:        ' + json(r.clasico.A.nube.ventas));
            nota('              equipo A:    ' + json(r.clasico.A.equipo.ventas));
            nota('              equipo B:    ' + json(r.clasico.B.equipo.ventas));
        }
        // ---- operaciones ----
        {
            const s = crearServidor();
            const navA = crearNavegador('AAAA1111', crearDisco(), s);
            const navB = crearNavegador('BBBB2222', crearDisco(), s);
            const A = crearMotorOperaciones(navA);
            // A descarga su ventana (nube vacía) y vende
            await descargarVentana(A);
            reservarSecuenciaDesdeNube(A);
            registrarVenta(A, {});
            await sincronizar(A);
            // B vende 2 veces sin conexión
            const B = crearMotorOperaciones(navB);
            await descargarVentana(B);
            reservarSecuenciaDesdeNube(B);
            await desconectarRed(s, navB);
            registrarVenta(B, {});
            registrarVenta(B, {});
            // B reconecta: sube sus operaciones (solo las suyas, no un arreglo completo)
            await reconectarRed(s, navB);
            await sincronizar(B);
            // A vuelve a sincronizar y descarga: unión por id, converge
            await sincronizar(A);
            await descargarVentana(A);
            r.operaciones = { A: estadoOps(A), B: estadoOps(B) };
            nota('operaciones -> nube:        ' + json(r.operaciones.A.nube.ops_venta));
            nota('              equipo A:    ' + json(r.operaciones.A.equipo.caliente_ventas));
            nota('              equipo B:    ' + json(r.operaciones.B.equipo.caliente_ventas));
        }
        const nubeClasico = r.clasico.A.nube.ventas;
        check('T2 · clasico: la nube queda con las ventas de B y la venta de A SE PIERDE',
            nubeClasico.length === 2 && nubeClasico.indexOf('V-LOCAL-AAAA1111-0001') === -1 &&
            nubeClasico.indexOf('V-LOCAL-BBBB2222-0002') !== -1,
            json(nubeClasico));
        check('T2 · clasico: A tampoco conserva su propia venta al descargar (se pisa a sí mismo)',
            r.clasico.A.equipo.ventas.indexOf('V-LOCAL-AAAA1111-0001') === -1,
            json(r.clasico.A.equipo.ventas));
        const nubeOps = r.operaciones.A.nube.ops_venta;
        check('T2 · operaciones: la nube conserva LAS TRES ventas',
            nubeOps.length === 3 &&
            nubeOps.indexOf('V-LOCAL-AAAA1111-0001') !== -1 &&
            nubeOps.indexOf('V-LOCAL-BBBB2222-0001') !== -1 &&
            nubeOps.indexOf('V-LOCAL-BBBB2222-0002') !== -1,
            json(nubeOps));
        check('T2 · operaciones: ningún equipo pierde nada (los dos ven las 3 ventas)',
            r.operaciones.A.equipo.caliente_ventas.length === 3 && r.operaciones.B.equipo.caliente_ventas.length === 3,
            json({ A: r.operaciones.A.equipo.caliente_ventas, B: r.operaciones.B.equipo.caliente_ventas }));
    }

    /* ---------------- T3 ---------------- */
    titulo('T3 · Reintento duplicado (se sube dos veces la misma operación)');
    {
        const s = crearServidor();
        const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const op = registrarVenta(m, {});
        const r1 = await sincronizar(m);
        // El mismo payload se reintenta a mano (como haría un reintento tras un timeout).
        const r2 = await subirOperacion(m, op);
        const r3 = await subirOperacion(m, op);
        const rConflicto = await subirOperacion(m, Object.assign({}, op, { payload: Object.assign({}, op.payload, { total: 999 }) }));
        const nube = opsNube(s, 'venta');
        nota('1er vaciado de cola: ' + json(r1));
        nota('reintento directo:   ' + r2 + ' / ' + r3);
        nota('misma clave, otro contenido -> ' + rConflicto);
        nota('nube -> ops/venta:   ' + json(nube.map(o => o.id)) + ' (escrituras aplicadas: ' + nav.escrituras + ')');
        nota('equipo -> cola:      ' + json(resumenCola(m)));
        check('T3 · la operación existe UNA sola vez en la nube', nube.length === 1 && nube[0].id === op.id, json(nube.map(o => o.id)));
        check('T3 · el reintento con el mismo contenido no reescribe nada (ya-estaba)',
            r2 === 'ya-estaba' && r3 === 'ya-estaba', r2 + '/' + r3);
        check('T3 · la misma clave con contenido DISTINTO no pisa la nube (conflicto)', rConflicto === 'conflicto', rConflicto);
        check('T3 · la venta original sigue intacta tras el conflicto',
            leerDe(s.datos, rutaOp(op)).payload.total !== 999);
    }

    /* ---------------- T4 ---------------- */
    titulo('T4 · Subida que falla (las reglas niegan la escritura): NO se libera del equipo');
    {
        const s = crearServidor();
        const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        // Productos y clientes suben bien (van primero en la secuencia); después se
        // rompen las reglas justo antes de la venta.
        const producto = registrarProducto(m, { id: 'P1', campo: 'precio', valor: 1.5, opId: 'PROD-1' });
        const venta = registrarVenta(m, {});
        nav.fallarOps = true;          // desde aquí las reglas niegan la escritura en ops/*
        const r = await sincronizar(m);
        const colaTrasFallo = resumenCola(m);
        const calienteTrasFallo = opsCalientes(m, 'venta').map(o => o.id);
        const nubeTrasFallo = Object.keys(leerDe(s.datos, rutaOps('venta')) || {}).length;
        const entradaTrasFallo = Object.assign({}, entradaCola(m, producto));
        const entradaVenta = Object.assign({}, entradaCola(m, venta));
        nav.fallarOps = false;
        const r2 = await sincronizar(m);
        nota('intento con fallo   -> ' + json(r));
        nota('equipo -> entrada que falló (' + producto.id + '): ' + json({ estado: entradaTrasFallo.estado, intentos: entradaTrasFallo.intentos, error: entradaTrasFallo.error }));
        nota('equipo -> cola:       ' + json(colaTrasFallo));
        nota('equipo -> la venta queda esperando su turno (orden por secuencia): ' +
             json(entradaVenta.estado));
        nota('equipo -> caliente:   ' + json(calienteTrasFallo));
        nota('nube tras el fallo:   ' + nubeTrasFallo + ' operaciones de venta');
        nota('segundo intento (reglas arregladas) -> ' + json(r2));
        check('T4 · el fallo se registra como tal (fallo + intentos)', r.fallos === 1, json(r));
        check('T4 · el producto sí subió; la venta no (se corta el orden, no se salta)',
            (leerDe(s.datos, rutaOps('producto')) || {}) && Object.keys(leerDe(s.datos, rutaOps('producto')) || {}).length === 1,
            json(Object.keys(leerDe(s.datos, rutaOps('producto')) || {})));
        check('T4 · la operación que falló NO se marca como subida',
            r.subidas === 0 && entradaTrasFallo.estado === 'fallo', json(entradaTrasFallo));
        check('T4 · la siguiente de la cola sigue sin subir, sin saltarse el orden',
            entradaVenta.estado === 'pendiente', json(entradaVenta.estado));
        check('T4 · la operación NO se libera del equipo (sigue en caliente)',
            calienteTrasFallo.indexOf(venta.id) !== -1, json(calienteTrasFallo));
        check('T4 · nada de esa venta llegó a la nube', nubeTrasFallo === 0, String(nubeTrasFallo));
        check('T4 · al desaparecer el fallo, la cola se vacía y la operación sube',
            r2.fallos === 0 && r2.subidas + r2.yaEstaban === 2 && entradaCola(m, venta).estado === 'subida',
            json(r2));
    }

    /* ---------------- T5 ---------------- */
    titulo('T5 · Liberación tras confirmar (40 días se libera, 10 días no)');
    {
        const s = crearServidor();
        const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const AHORA = Date.parse('2026-02-14T12:00:00.000Z');
        // El equipo tiene la operación vieja en caliente (por ejemplo, tras sincronizar
        // una ventana ampliada o porque estuvo 40 días sin conectarse).
        const vieja = sembrarOperacion(s, 'venta', 'VIEJO111', 1, ah('2026-01-05T10:00:00.000Z'), { id: 'V-LOCAL-VIEJO111-0001', total: 20, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 20 }] });
        aplicarOperacion(m, vieja); encolar(m, vieja); entradaCola(m, vieja).estado = 'subida';
        // Y una venta reciente, ya confirmada, de hace 10 días.
        const joven = sembrarOperacion(s, 'venta', 'JOVEN222', 1, ah('2026-02-04T10:00:00.000Z'), { id: 'V-LOCAL-JOVEN222-0001', total: 30, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 30 }] });
        aplicarOperacion(m, joven); encolar(m, joven); entradaCola(m, joven).estado = 'subida';
        const antes = opsCalientes(m, 'venta').map(o => o.id);
        const liberadas = liberarCaliente(m, AHORA);
        const despues = opsCalientes(m, 'venta').map(o => o.id);
        nota('antes  -> caliente: ' + json(antes));
        nota('liberadas (40 días, confirmada): ' + json(liberadas));
        nota('después -> caliente: ' + json(despues));
        nota('nube   -> sigue teniendo: ' + json(opsNube(s, 'venta').map(o => o.id)));
        check('T5 · la operación de hace 40 días, ya confirmada, SÍ se libera del equipo',
            liberadas.indexOf('V-LOCAL-VIEJO111-0001') !== -1 && despues.indexOf('V-LOCAL-VIEJO111-0001') === -1,
            json({ liberadas, despues }));
        check('T5 · la operación de hace 10 días NO se libera',
            liberadas.indexOf('V-LOCAL-JOVEN222-0001') === -1 && despues.indexOf('V-LOCAL-JOVEN222-0001') !== -1,
            json(despues));
        check('T5 · las dos siguen en la nube (la ventana caliente no es la copia de seguridad)',
            opsNube(s, 'venta').length === 2, json(opsNube(s, 'venta').map(o => o.id)));
    }

    /* ---------------- T5b ---------------- */
    titulo('T5b · No se libera NUNCA sin confirmación (aunque tenga más de 30 días)');
    {
        const s = crearServidor();
        const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const AHORA = Date.parse('2026-02-14T12:00:00.000Z');
        const op = {
            id: 'V-LOCAL-VIEJO111-0002', tipo: 'venta', deviceId: 'VIEJO111', secuencia: 2,
            fechaISO: ah('2026-01-05T10:00:00.000Z'), operador: 'seed', version: 1,
            payload: { id: 'V-LOCAL-VIEJO111-0002', total: 44, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 44 }] }
        };
        // Está en caliente y su entrada de la cola sigue PENDIENTE (la subida falló).
        aplicarOperacion(m, op); encolar(m, op);
        const liberadas = liberarCaliente(m, AHORA);
        nota('cola: ' + json(resumenCola(m)) + ' | liberadas: ' + json(liberadas));
        nota('caliente: ' + json(opsCalientes(m, 'venta').map(o => o.id)));
        check('T5b · una operación vieja SIN confirmar no se libera jamás',
            liberadas.length === 0 && opsCalientes(m, 'venta').length === 1, json({ liberadas }));
        // Se sube (sin liberar, para ver los dos pasos por separado). La nube ya tenía el
        // contenido, así que la idempotencia lo reconoce y no reescribe nada.
        const subida = await sincronizar(m, { liberar: false });
        const reconociendola = subida.subidas + subida.yaEstaban === 1;
        const confirmada = entradaCola(m, op).estado === 'subida';
        const sigueEnCaliente = opsCalientes(m, 'venta').length === 1;
        const liberadas2 = liberarCaliente(m, AHORA);
        nota('tras subir: ' + json(subida) + ' | confirmada: ' + confirmada + ' | seguía en caliente: ' + sigueEnCaliente);
        nota('segundo paso (liberar): ' + json(liberadas2) + ' | caliente: ' + json(opsCalientes(m, 'venta').map(o => o.id)));
        check('T5b · tras confirmarse sigue en el equipo hasta el paso de liberación',
            reconociendola && confirmada && sigueEnCaliente);
        check('T5b · y solo entonces se libera de la ventana caliente',
            liberadas2.indexOf('V-LOCAL-VIEJO111-0002') !== -1 && opsCalientes(m, 'venta').length === 0);
    }

    /* ---------------- T6 ---------------- */
    titulo('T6 · Equipo nuevo (arranca vacío; ventana de 30 días; histórico paginado)');
    {
        const s = crearServidor();
        const AHORA = Date.parse('2026-02-14T12:00:00.000Z');
        // La nube de un negocio que lleva 60 días operando.
        sembrarOperacion(s, 'producto', 'VIEJO111', 1, ah('2026-01-01T09:00:00.000Z'), { id: 'P1', campo: 'precio', valor: 1.5 });
        sembrarOperacion(s, 'producto', 'VIEJO111', 2, ah('2026-01-01T09:00:01.000Z'), { id: 'P2', campo: 'precio', valor: 2.5 });
        sembrarOperacion(s, 'cliente', 'VIEJO111', 3, ah('2026-01-01T09:00:02.000Z'), { clave: 'V-12345678', campo: 'nombre', valor: 'Ana' });
        sembrarOperacion(s, 'venta', 'VIEJO111', 1, ah('2025-12-16T10:00:00.000Z'), { id: 'V-LOCAL-VIEJO111-0001', total: 10, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 10 }] });
        sembrarOperacion(s, 'venta', 'VIEJO111', 2, ah('2026-02-01T10:00:00.000Z'), { id: 'V-LOCAL-VIEJO111-0002', total: 20, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 20 }] });
        sembrarOperacion(s, 'venta', 'VIEJO111', 3, ah('2026-02-10T10:00:00.000Z'), { id: 'V-LOCAL-VIEJO111-0003', total: 30, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 30 }] });
        const nav = crearNavegador('NUEVO333', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const antes = estadoOps(m, AHORA);
        const descarga = await descargarVentana(m, AHORA);
        const puedeVender = registrarVenta(m, {});
        await sincronizar(m);
        const estado = estadoOps(m, AHORA);
        const historico = await consultarHistoricoPaginado(m, { hastaDias: 30, tamano: 1, ahoraMs: AHORA });
        nota('equipo nuevo ANTES de descargar -> ' + json(antes.equipo));
        nota('descarga de la ventana -> ' + json(descarga));
        nota('equipo nuevo DESPUÉS -> ' + json(estado.equipo));
        nota('nube -> ' + json(estado.nube));
        nota('histórico de 60 días bajo demanda (paginado de a 1) -> ' + json(historico));
        nota('caché de consulta (no es caliente) -> ' + json(m.historicoLocal.map(o => o.id)));
        check('T6 · el equipo nuevo arranca vacío (sin productos ni ventas)',
            antes.equipo.productos.length === 0 && antes.equipo.caliente_ventas.length === 0, json(antes.equipo));
        check('T6 · descarga todos los productos y clientes y las ventas de los últimos 30 días',
            descarga.productos === 2 && descarga.ventas === 2, json(descarga));
        check('T6 · la venta de hace 60 días NO está en la ventana caliente',
            estado.equipo.caliente_ventas.indexOf('V-LOCAL-VIEJO111-0001') === -1 &&
            estado.equipo.caliente_ventas.indexOf('V-LOCAL-VIEJO111-0002') !== -1 &&
            estado.equipo.caliente_ventas.indexOf('V-LOCAL-VIEJO111-0003') !== -1 &&
            estado.equipo.caliente_ventas.indexOf(puedeVender.id) !== -1,
            json(estado.equipo.caliente_ventas));
        check('T6 · el equipo nuevo puede vender y su venta llega a la nube',
            estado.nube.ops_venta.indexOf(puedeVender.id) !== -1 &&
            estado.nube.ops_venta.length === 4, json(estado.nube.ops_venta));
        check('T6 · el histórico anterior a la ventana se lee de la nube, paginado',
            historico.paginas === 1 && historico.ids[0] === 'V-LOCAL-VIEJO111-0001', json(historico));
    }

    /* ---------------- T7 ---------------- */
    titulo('T7 · Interruptor modoSync (regresión: por defecto y con fallo se usa clasico)');
    {
        const nodoSinDefinir = crearServidor(); nodoSinDefinir.modoSync = undefined;
        const nodoRoto = crearServidor(); nodoRoto.modoSync = 'modo-que-no-existe';
        const nodoNuevo = crearServidor(); nodoNuevo.modoSync = 'operaciones';
        escribirEn(nodoNuevo.datos, rutaSuscripcion + 'modoSync', 'operaciones');
        escribirEn(nodoRoto.datos, rutaSuscripcion + 'modoSync', 'modo-que-no-existe');

        const navSin = crearNavegador('AAAA1111', crearDisco(), nodoSinDefinir);
        const navRoto = crearNavegador('AAAA1111', crearDisco(), nodoRoto);
        const navNuevo = crearNavegador('AAAA1111', crearDisco(), nodoNuevo);
        const modoSin = await navSin.leerModoSync();
        const modoRoto = await navRoto.leerModoSync();
        const modoNuevo = await navNuevo.leerModoSync();

        // Con modoSync = clasico, el POS usa el motor clásico (arreglo completo).
        const s = crearServidor();
        const nav = crearNavegador('AAAA1111', crearDisco(), s);
        const motor = (await nav.leerModoSync()) === 'operaciones' ? crearMotorOperaciones(nav) : crearMotorClasico(nav);
        await clasicoGuardarVenta(motor, { id: 'V-LOCAL-AAAA1111-0001', total: 5 });
        const nubeClasico = (leerDe(s.datos, rutaVentasClasico) || []).map(v => v.id);
        const nubeOps = Object.keys(leerDe(s.datos, rutaOps('venta')) || {}).length;
        nota('modoSync ausente -> ' + modoSin + ' | valor inválido -> ' + modoRoto + ' | valor válido -> ' + modoNuevo);
        nota('con clasico la nube usa ventas/historial -> ' + json(nubeClasico) + ' y ops/venta tiene ' + nubeOps);
        check('T7 · sin el nodo modoSync se usa clasico (comportamiento de hoy)', modoSin === 'clasico', modoSin);
        check('T7 · con un valor inválido se usa clasico', modoRoto === 'clasico', modoRoto);
        check('T7 · con el valor "operaciones" se usa el motor nuevo', modoNuevo === 'operaciones', modoNuevo);
        check('T7 · en modo clasico se sube el arreglo completo a ventas/historial y no se escriben operaciones',
            JSON.stringify(nubeClasico) === JSON.stringify(['V-LOCAL-AAAA1111-0001']) && nubeOps === 0,
            json({ nubeClasico, nubeOps }));

        // El reinicio de fábrica (config.html) borra lo local A PROPÓSITO: el motor
        // tampoco debe reintentar subir lo que ya no existe.
        const s2 = crearServidor();
        const nav2 = crearNavegador('AAAA1111', crearDisco(), s2);
        const m2 = crearMotorOperaciones(nav2);
        registrarVenta(m2, { total: 3 });
        const colaAntes = resumenCola(m2);
        reiniciarFabrica(nav2.disco);                 // olvidarPendientesSync + borrado local
        const trasReinicio = { cola: resumenCola(m2), ventas: opsCalientes(m2, 'venta').length, seq: nav2.disco.local.seq || 0 };
        await sincronizar(m2);
        nota('reinicio de fábrica -> antes: ' + json(colaAntes) + ' | después: ' + json(trasReinicio) +
             ' | nube: ' + json(opsNube(s2, 'venta').map(o => o.id)));
        check('T7 · el reinicio de fábrica vacía cola y ventana caliente y no sube nada',
            trasReinicio.cola.pendiente === 0 && trasReinicio.ventas === 0 &&
            opsNube(s2, 'venta').length === 0, json({ trasReinicio }));
    }

    /* ---------------- T8 ---------------- */
    titulo('T8 · Plan gratuito: al llegar a 1 GB se borra lo más antiguo sin tocar la nube');
    {
        // Nube de verdad (otro negocio con plan) para demostrar que el borrado local no la toca.
        const s = crearServidor();
        const nav = crearNavegador('GRATIS99', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const AHORA = Date.parse('2026-02-14T12:00:00.000Z');
        // 1 GB / 2 KB por venta = 524288 entradas. Se siembra el equivalente por conteo
        // (mismo camino de código que el recorte real, sin reservar 1 GB de RAM).
        const TOTAL = Math.ceil(1024 * 1048576 / 2048);
        const nubePrevia = [];
        for (let i = 1; i <= TOTAL; i++) {
            const op = {
                tipo: 'venta', deviceId: 'GRATIS99', secuencia: i, id: 'V-LOCAL-GRATIS99-' + String(i).padStart(6, '0'),
                fechaISO: ah(AHORA - (TOTAL - i) * 60000), operador: 'maria', version: 1,
                payload: { id: 'V-LOCAL-GRATIS99-' + String(i).padStart(6, '0'), total: 1, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 1 }] }
            };
            if (i <= 3 || i % 100000 === 0) nubePrevia.push(op.id);   // muestra del histórico viejo
            m.nav.disco.caliente.venta = m.nav.disco.caliente.venta || [];
            m.nav.disco.caliente.venta.push(op);                       // en el equipo
            escribirEn(s.datos, rutaOp(op), op);                       // y en la nube
        }
        const antes = opsCalientes(m, 'venta').length;
        const recorte = planGratuito(m, { limiteMB: 1024, pesoBytes: 2048 });
        const despues = opsCalientes(m, 'venta').length;
        const nubeDespues = opsNube(s, 'venta').length;
        nota('límite: 1024 MB · ' + TOTAL + ' ventas de 2 KB en el equipo');
        nota('recorte -> ' + json({ accion: recorte.accion, porcentaje: recorte.porcentaje, borradas: recorte.borradas }));
        nota('borradas (las más antiguas): ' + json(recorte.ids.slice(0, 3)) + ' ... de ' + recorte.borradas);
        nota('equipo -> ventas: ' + antes + ' antes, ' + despues + ' después');
        nota('nube   -> sigue con ' + nubeDespues + ' ventas; muestra vieja: ' + json(nubePrevia));
        check('T8 · al 100 % del límite se recorta hasta bajar del 90 %',
            recorte.accion === 'recortado' && recorte.borradas > 0 && despues < TOTAL, json(recorte));
        check('T8 · se borran las MÁS ANTIGUAS (la primera venta se va, la última queda)',
            recorte.ids.indexOf('V-LOCAL-GRATIS99-000001') !== -1 &&
            opsCalientes(m, 'venta').some(o => o.id === 'V-LOCAL-GRATIS99-' + String(TOTAL).padStart(6, '0')),
            json({ primeraBorrada: recorte.ids.indexOf('V-LOCAL-GRATIS99-000001') !== -1 }));
        check('T8 · el recorte NO toca la nube', nubeDespues === TOTAL, String(nubeDespues));
        // Con nube (plan de pago): no hay recorte; se libera tras confirmar y se guardan 30 días.
        const s2 = crearServidor();
        const nav2 = crearNavegador('PAGADO01', crearDisco(), s2);
        const m2 = crearMotorOperaciones(nav2);
        for (let i = 1; i <= 5; i++) {
            const op = sembrarOperacion(s2, 'venta', 'PAGADO01', i, ah(AHORA - (i === 1 ? 40 : 5) * DIA_MS), { id: 'V-PAGADO-' + i, total: 1, metodo: 'efectivo', moneda: 'USD', productos: [{ producto: 'P1', cantidad: 1, precio: 1 }] });
            aplicarOperacion(m2, op); encolar(m2, op);
        }
        await sincronizar(m2, { liberar: false });
        const rLib = planConNube(m2, { ahoraMs: AHORA });
        nota('con nube -> ' + json(rLib) + ' | caliente: ' + json(opsCalientes(m2, 'venta').map(o => o.id)));
        check('T8 · con nube no hay recorte por límite y solo se libera lo confirmado de más de 30 días',
            rLib.liberadas === 1 && opsCalientes(m2, 'venta').length === 4 &&
            opsCalientes(m2, 'venta').every(o => o.id !== 'V-PAGADO-1'), json(rLib));
    }

    /* ---------------- T9 ---------------- */
    titulo('T9 · Conflicto de producto en dos equipos: merge por campo');
    {
        const s = crearServidor();
        const AHORA = Date.parse('2026-02-14T12:00:00.000Z');
        const navA = crearNavegador('AAAA1111', crearDisco(), s);
        const navB = crearNavegador('BBBB2222', crearDisco(), s);
        const A = crearMotorOperaciones(navA), B = crearMotorOperaciones(navB);
        // Punto de partida común: P1 con precio 1.0 y stock 10.
        sembrarOperacion(s, 'producto', 'SEED0001', 1, ah(Date.parse('2026-02-01T08:00:00.000Z')), { id: 'P1', campo: 'precio', valor: 1.0 });
        sembrarOperacion(s, 'producto', 'SEED0001', 2, ah(Date.parse('2026-02-01T08:00:01.000Z')), { id: 'P1', campo: 'stock', valor: 10 });
        await descargarVentana(A, AHORA);
        await descargarVentana(B, AHORA);
        reservarSecuenciaDesdeNube(A); reservarSecuenciaDesdeNube(B);
        // A cambia el precio a las 10:00:05; B cambia el stock a las 10:00:06 (ambos sin conexión).
        await desconectarRed(s, navA); await desconectarRed(s, navB);
        registrarProducto(A, { id: 'P1', campo: 'precio', valor: 1.8, opId: 'PROD-A-1', secuencia: 10, fechaISO: ah(Date.parse('2026-02-14T10:00:05.000Z')) });
        registrarProducto(B, { id: 'P1', campo: 'stock', valor: 4, opId: 'PROD-B-1', secuencia: 11, fechaISO: ah(Date.parse('2026-02-14T10:00:06.000Z')) });
        await reconectarRed(s, navA); await reconectarRed(s, navB);
        await sincronizar(A);
        await sincronizar(B);
        await descargarVentana(A, AHORA);
        await descargarVentana(B, AHORA);
        const pA = A.nav.disco.caliente.producto.P1, pB = B.nav.disco.caliente.producto.P1;
        nota('equipo A -> P1: ' + json({ precio: pA.precio, stock: pA.stock }));
        nota('equipo B -> P1: ' + json({ precio: pB.precio, stock: pB.stock }));
        check('T9 · los dos cambios sobreviven (precio de A y stock de B)',
            pA.precio === 1.8 && pA.stock === 4 && pB.precio === 1.8 && pB.stock === 4,
            json({ A: { precio: pA.precio, stock: pA.stock }, B: { precio: pB.precio, stock: pB.stock } }));
        check('T9 · los dos equipos convergen al mismo producto', deepEqual(pA, pB));
        // Mismo campo: gana el mtime más reciente (B, 10:00:06).
        const s2 = crearServidor();
        sembrarOperacion(s2, 'producto', 'SEED0001', 1, ah(Date.parse('2026-02-01T08:00:00.000Z')), { id: 'P1', campo: 'precio', valor: 1.0 });
        const C = crearMotorOperaciones(crearNavegador('CCCC3333', crearDisco(), s2));
        await descargarVentana(C, AHORA);
        await desconectarRed(s2, C.nav);
        registrarProducto(C, { id: 'P1', campo: 'precio', valor: 1.5, opId: 'PROD-C-1', secuencia: 20, fechaISO: ah(Date.parse('2026-02-14T10:00:05.000Z')) });
        await reconectarRed(s2, C.nav);
        await sincronizar(C);
        aplicarOperacion(C, sembrarOperacion(s2, 'producto', 'DDDD4444', 21, ah(Date.parse('2026-02-14T10:00:06.000Z')), { id: 'P1', campo: 'precio', valor: 2.2 }));
        nota('mismo campo, gana el más reciente -> P1.precio = ' + C.nav.disco.caliente.producto.P1.precio);
        check('T9 · en el mismo campo gana el mtime más reciente (2.2 de las 10:00:06)',
            C.nav.disco.caliente.producto.P1.precio === 2.2, String(C.nav.disco.caliente.producto.P1.precio));
    }

    /* ---------------- T10 ---------------- */
    titulo('T10 · Robustez del esquema y del índice');
    {
        const s = crearServidor();
        const nav = crearNavegador('7K3F9QAB', crearDisco(), s);
        const m = crearMotorOperaciones(nav);
        const op = registrarVenta(m, { secuencia: 1, total: 100 });
        const op2 = registrarVenta(m, { secuencia: 2, total: 40 });
        await sincronizar(m);
        const enNube = leerDe(s.datos, rutaOp(op));
        nota('ruta: ' + rutaOp(op));
        nota('valor: ' + json(enNube));
        check('T10 · la ruta es ops/<tipo>/<deviceId>_<secuencia> con secuencia a 4 dígitos',
            /\/ops\/venta\/7K3F9QAB_0001$/.test(rutaOp(op)), rutaOp(op));
        check('T10 · deviceId tiene 8 caracteres', String(enNube.deviceId).length === 8, enNube.deviceId);
        check('T10 · el valor lleva id, tipo, deviceId, secuencia, fechaISO, operador, version y payload',
            ['id', 'tipo', 'deviceId', 'secuencia', 'fechaISO', 'operador', 'version', 'payload'].every(k => k in enNube),
            json(Object.keys(enNube)));
        check('T10 · version empieza en 1 y no hay valores undefined en el payload',
            enNube.version === 1 && !json(enNube.payload).includes('undefined'), json(enNube.payload));
        const tieneIndice1 = !!leerDe(s.datos, rutaIndice(fechaDia(op.fechaISO)) + '/' + claveIndice(op));
        const tieneIndice2 = !!leerDe(s.datos, rutaIndice(fechaDia(op2.fechaISO)) + '/' + claveIndice(op2));
        check('T10 · el índice del día queda con la clave de la operación',
            tieneIndice1 && tieneIndice2, json(leerDe(s.datos, RAIZ + '/ventas_idx')));
        // Se pierde una entrada del índice (escritura fallida en el equipo o borrado a mano).
        escribirEn(s.datos, rutaIndice(fechaDia(op2.fechaISO)) + '/' + claveIndice(op2), null);
        const faltantes = clavesFaltantesEnIndice(m).length;
        const indiceRoto = leerDe(s.datos, RAIZ + '/ventas_idx');
        // Reconstrucción desde las operaciones (el índice NUNCA es fuente de verdad).
        const reconstruido = construirIndice(s, 'venta');
        const dia = fechaDia(op.fechaISO);
        const totalReconstruido = Object.keys(reconstruido[dia])
            .reduce((suma, k) => suma + reconstruido[dia][k].total, 0);        escribirEn(s.datos, RAIZ + '/ventas_idx', reconstruido);
        const faltantesTrasReconstruir = clavesFaltantesEnIndice(m).length;
        nota('índice roto -> faltan ' + faltantes + ' entradas | reconstruido -> ' + json(reconstruido[dia]));
        nota('total reconstruido del día (140 esperado): ' + totalReconstruido +
             ' | sin faltantes después: ' + faltantesTrasReconstruir);
        check('T10 · el índice incompleto se detecta (faltaba 1 entrada)',
            faltantes === 1 && !(indiceRoto[dia][claveIndice(op2)]), json({ faltantes, indiceRoto }));
        check('T10 · el índice se reconstruye desde ops/venta con los totales correctos',
            totalReconstruido === 140 && faltantesTrasReconstruir === 0, json({ totalReconstruido, faltantesTrasReconstruir }));
        // La nube no se reescribe al reconstruir (sigue append-only).
        check('T10 · las operaciones de la nube no se tocan durante el mantenimiento del índice',
            opsNube(s, 'venta').length === 2 && nav.escrituras > 0, String(opsNube(s, 'venta').length));
    }

    console.log('\n================ ' + ok + ' OK, ' + fallos + ' FALLAS ================');
    if (fallos === 0) {
        console.log('El diseño del motor de operaciones pasa los 8 escenarios obligatorios + 2 extra.');
        console.log('Recordatorio: esto NO es el motor; es el simulador del diseño.');
    }
    process.exit(fallos === 0 ? 0 : 1);
})();
