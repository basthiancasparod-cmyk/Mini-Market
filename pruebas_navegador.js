/* =====================================================================
   PRUEBAS EN NAVEGADOR REAL · Ciervo Mini Market
   ---------------------------------------------------------------------
   Valida en un Chromium de verdad (Playwright) los cambios del día:

     A) Migración de datos en navegador real (lo más importante)
     B) Datos de muestra fuera
     C) Aislamiento entre dos cuentas
     D) Guardián de cuota
     E) Restaurar un respaldo no retrocede el contador
     F) Motor de operaciones (opcional, solo con --motor)

   REGLAS DE SEGURIDAD DE ESTA SUITE
     - Prueba SIEMPRE contra el servidor local http://127.0.0.1:5500.
       Nunca contra ciervoadministrativo.shop ni datos de clientes reales.
     - Las cuentas de prueba se crean con Firebase Auth REST y se BORRAN
       al terminar. Los correos son prueba.playwright.<marca>@example.com.
     - No toca datos de negocios existentes.

   USO
     node pruebas_navegador.js                 suite completa
     node pruebas_navegador.js --preflight     solo comprobaciones previas (sin navegador)
     node pruebas_navegador.js --motor         incluye el escenario F (motor de operaciones)
     node pruebas_navegador.js --autoaprobar   intenta aprobar la cuenta A por REST
     node pruebas_navegador.js --sin-cdn       aborta las rutas externas (ver más abajo)

   VARIABLES DE ENTORNO (opcionales)
     PW_EMAIL_A / PW_PASS_A    cuenta A ya aprobada por el administrador
     PW_EMAIL_B / PW_PASS_B    cuenta B ya existente (no necesita aprobación)
     PW_CDP=http://127.0.0.1:9222   adjuntarse a un Chrome ya abierto con depuración
     PW_HEADFUL=1              mostrar el navegador (no headless)
     PW_PLAYWRIGHT=<ruta>      ruta explícita al paquete 'playwright'
     PW_AUTOAPROBAR=1          igual que --autoaprobar
     PW_SIN_CDN=1              igual que --sin-cdn
     PW_TIMEOUT=60000          tiempo máximo de cada navegación/espera (ms)
     PW_WAITUNTIL=commit       evento con el que se da por hecha una navegación
                               ('commit' | 'domcontentloaded' | 'load' | 'networkidle')
     PW_TIMEOUT_DOM=15000      espera máxima (opcional) a DOMContentLoaded

   SOBRE LA CARGA DE PÁGINA (importante)
     Las páginas traen <script src="https://..."> SÍNCRONOS en el <head> (Firebase,
     Lucide, Font Awesome, Tailwind, fuentes). Si un CDN tarda o está bloqueado, el
     parser se queda esperando, DOMContentLoaded NO llega nunca y una espera por
     evento se cuelga. Por eso la suite navega con 'commit' (vuelve en cuanto el
     servidor responde), espera por SELECTOR lo que necesita y, si algo no aparece,
     VUELCA el diagnóstico: consola, peticiones en vuelo, peticiones fallidas,
     respuestas con error y una captura.
     El preflight comprueba explícitamente si el NAVEGADOR alcanza los CDN.
     Si no los alcanza, NO es un fallo de la aplicación: use --sin-cdn para ver
     hasta dónde llega el HTML y el aislamiento (el login con Firebase no podrá
     funcionar en ese modo).

   SALIDA
     - Una línea OK/FALLA por comprobación.
     - Capturas en capturas_navegador/ (una por hito).
     - Código de salida 0 si todo pasó; 1 si algo falló; 2 si el navegador
       no se pudo lanzar; 3 si faltó una precondición (cuenta sin aprobar).
   ===================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* =====================================================================
   1. CONFIGURACIÓN
   ===================================================================== */

const RAIZ = __dirname;
const PUERTO = 5500;
const ORIGEN = 'http://127.0.0.1:' + PUERTO;
const CARPETA_CAPTURAS = path.join(RAIZ, 'capturas_navegador');
const LOG_SERVIDOR = path.join(RAIZ, '_salida_servidor_navegador.log');

// Datos públicos del proyecto: son los MISMOS que ya están incrustados en la
// app (apiKey pública de Firebase). No hay credenciales secretas aquí.
const API_KEY = 'AIzaSyCyaIC2-pCCQf_mJWGtG6v-0kA1l2Or2CQ';
const DB_URL = 'https://mini-market-ciervo-index-default-rtdb.firebaseio.com';
const AUTH_REST = 'https://identitytoolkit.googleapis.com/v1/accounts:';

// Claves que NUNCA se prefijan (datos_cuenta.js -> CLAVES_DE_EQUIPO) y PREFIJOS de
// claves de equipo (datos_cuenta.js -> PREFIJOS_DE_EQUIPO). El SDK de Firebase Auth
// persiste la sesión como 'firebase:authUser:<apiKey>:[DEFAULT]' y es del EQUIPO, no
// del negocio: si se prefijara, al activarse el aislamiento el SDK perdería la sesión
// y sesion.js devolvería la página al login (fallo 1 del 21/09/2026).
const CLAVES_EQUIPO = ['datosDeCuenta', 'sesionActiva', 'rememberedEmail', 'darkMode', 'theme'];
const PREFIJOS_EQUIPO = ['firebase:', 'firebaseLocalStorage'];
// Restos que no son de nadie: la migración los ignora y limpiarCuenta() no los borra.
const PREFIJO_CUARENTENA = '_legacy_:';
const CLAVE_MARCADOR = 'datosDeCuenta';
const PREFIJO_CUENTA = 'cuenta:';

/** ¿Esta clave física puede estar SIN prefijo sin ser un fallo de aislamiento? */
function esClaveSinPrefijoLegitima(nombre) {
    if (CLAVES_EQUIPO.indexOf(nombre) !== -1) return true;
    if (nombre.indexOf(PREFIJO_CUARENTENA) === 0) return true;
    return PREFIJOS_EQUIPO.some((p) => nombre.indexOf(p) === 0);
}

const ARGUMENTOS = process.argv.slice(2);
const OPCIONES = {
    preflight: ARGUMENTOS.indexOf('--preflight') !== -1,
    motor: ARGUMENTOS.indexOf('--motor') !== -1,
    autoaprobar: ARGUMENTOS.indexOf('--autoaprobar') !== -1 || process.env.PW_AUTOAPROBAR === '1',
    headful: process.env.PW_HEADFUL === '1',
    cdn: ARGUMENTOS.indexOf('--sin-cdn') !== -1 || process.env.PW_SIN_CDN === '1',
    cdp: process.env.PW_CDP || '',
    emailA: process.env.PW_EMAIL_A || '',
    passA: process.env.PW_PASS_A || '',
    emailB: process.env.PW_EMAIL_B || '',
    passB: process.env.PW_PASS_B || '',
    // Tiempo máximo de CUALQUIER navegación/espera (ms).
    timeout: Number(process.env.PW_TIMEOUT || 60000),
    // Evento con el que se da por hecha una navegación.
    // 'commit' devuelve el control en cuanto el servidor responde, SIN esperar a
    // que terminen los CDN (Firebase, Lucide, Tailwind, fuentes...). Es lo que
    // evita que la suite se cuelgue esperando 'domcontentloaded'.
    waitUntil: process.env.PW_WAITUNTIL || 'commit',
    // Espera máxima (opcional) para que la página dispare DOMContentLoaded.
    timeoutDom: Number(process.env.PW_TIMEOUT_DOM || 15000)
};

/* ---------------------------------------------------------------------
   CDN que usa la app. Se comprueban desde el NAVEGADOR en el preflight:
   si el navegador no los alcanza, el login con Firebase es imposible y hay
   que saberlo antes de culpar a la aplicación.
   --------------------------------------------------------------------- */
const CDN_CLAVE = [
    'https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/8.10.0/firebase-auth.js',
    'https://cdn.jsdelivr.net/npm/lucide@0.263.1/dist/umd/lucide.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

/* ---------------------------------------------------------------------
   Datos de negocio SEMBRADOS (sin prefijo, como los de un cliente actual).
   Son 7 claves: las del enunciado del escenario A.
   --------------------------------------------------------------------- */
const PRODUCTOS_SEMBRADOS = [
    { id: 1, code: 'SEM-001', name: 'Producto sembrado 1', stock: 11, cost: 10, price: 15 },
    { id: 2, code: 'SEM-002', name: 'Producto sembrado 2', stock: 22, cost: 20, price: 30 },
    { id: 3, code: 'SEM-003', name: 'Producto sembrado 3', stock: 33, cost: 30, price: 45 }
];

const SEMILLA = {
    ciervo_inventory: JSON.stringify(PRODUCTOS_SEMBRADOS),
    ciervo_categories: JSON.stringify([
        { id: 1, name: 'Categoría sembrada 1' },
        { id: 2, name: 'Categoría sembrada 2' }
    ]),
    pos_sales: JSON.stringify([
        { id: 1, number: 1, total: 100, date: '2026-01-01' },
        { id: 2, number: 2, total: 200, date: '2026-01-02' }
    ]),
    pos_last_sale_number: '7',
    companyData: JSON.stringify({ companyName: 'NEGOCIO SEMBRADO C.A.', rif: 'J-99999999', address: 'Calle Sembrada' }),
    ciervo_clients: JSON.stringify([{ id: 1, name: 'Cliente sembrado' }]),
    ciervo_suppliers: JSON.stringify([{ id: 1, name: 'Proveedor sembrado' }])
};

const CLAVES_SEMILLA = Object.keys(SEMILLA);

// Marcas de "dato de muestra" que NO deben aparecer tras la limpieza de hoy.
const MARCAS_MUESTRA = [
    'LAP-HP-001', 'TEL-SAM-002', 'AUD-SON-003', 'CAM-NIK-004', 'CAF-NES-005',
    'Cliente A', 'Proveedor X', 'Empresa B', 'Arrendador', 'Cliente C',
    'TIENDA DE EJEMPLO', 'J-12345678'
];

const TEXTO_AVISO_POCO_ESPACIO = 'le queda muy poco espacio';
const TEXTO_CONTADOR_PROTEGIDO = 'contador más alto';

/* =====================================================================
   2. UTILIDADES DE INFORME
   ===================================================================== */

let CONTADOR_OK = 0;
let CONTADOR_FALLA = 0;
let CONTADOR_SALTADO = 0;
const RESULTADOS = [];
let NUMERO_CAPTURA = 0;

function titulo(texto) {
    console.log('');
    console.log('='.repeat(72));
    console.log(texto);
    console.log('='.repeat(72));
}

function nota(texto) {
    console.log('      ' + texto);
}

/** Comprobación con resultado OK/FALLA. */
function check(nombre, condicion, extra) {
    const paso = !!condicion;
    if (paso) {
        CONTADOR_OK += 1;
        console.log('OK    ' + nombre);
    } else {
        CONTADOR_FALLA += 1;
        console.log('FALLA ' + nombre + (extra ? '  -> ' + extra : ''));
    }
    RESULTADOS.push({ nombre: nombre, paso: paso, extra: extra || '' });
    return paso;
}

/** Comprobación que no bloquea (dato informativo). */
function info(nombre, valor) {
    console.log('INFO  ' + nombre + ': ' + String(valor));
}

/** Escenario que no se pudo ejecutar por falta de precondición. */
function saltar(nombre, motivo) {
    CONTADOR_SALTADO += 1;
    console.log('SALTA ' + nombre + '  -> ' + motivo);
    RESULTADOS.push({ nombre: nombre, paso: null, extra: motivo });
}

function crearCarpetaCapturas() {
    try { fs.mkdirSync(CARPETA_CAPTURAS, { recursive: true }); } catch (e) { /* ya existe */ }
}

/** Guarda una captura de pantalla y devuelve su ruta relativa. */
async function captura(page, nombre) {
    NUMERO_CAPTURA += 1;
    const archivo = String(NUMERO_CAPTURA).padStart(2, '0') + '_' + nombre + '.png';
    const destino = path.join(CARPETA_CAPTURAS, archivo);
    try {
        await page.screenshot({ path: destino, fullPage: true });
        nota('captura: capturas_navegador/' + archivo);
        return destino;
    } catch (e) {
        nota('no se pudo capturar ' + archivo + ': ' + e.message);
        return null;
    }
}

/* =====================================================================
   3. RESOLUCIÓN DE PLAYWRIGHT
   ===================================================================== */

/** Busca el paquete 'playwright' en las ubicaciones razonables del equipo. */
function resolverPlaywright() {
    const candidatos = [];
    if (process.env.PW_PLAYWRIGHT) candidatos.push(process.env.PW_PLAYWRIGHT);
    candidatos.push('playwright');
    candidatos.push(path.join(RAIZ, 'node_modules', 'playwright'));
    candidatos.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'));
    // Instalaciones previas conocidas en este PC (proyectos anteriores).
    candidatos.push('C:/Users/FOLGORESB/Desktop/TEA/ruta-tea/node_modules/playwright');

    for (let i = 0; i < candidatos.length; i++) {
        try {
            const mod = require(candidatos[i]);
            if (mod && mod.chromium) {
                let version = 'desconocida';
                try { version = require(path.join(candidatos[i], 'package.json')).version; } catch (e) { /* opcional */ }
                return { modulo: mod, version: version, ruta: candidatos[i] };
            }
        } catch (e) { /* siguiente candidato */ }
    }
    return null;
}

/* =====================================================================
   4. SERVIDOR LOCAL (node _servidor_pruebas.js)
   ===================================================================== */

const ESTADO = {
    servidorPropio: null,     // proceso hijo, si lo arrancamos nosotros
    navegador: null,
    navegadorPropio: false,
    cuentasCreadas: [],       // [{email, idToken, localId}]
    nodosCreados: []          // ['usuarios/<uid>', ...]
};

/** ¿Responde el servidor local? */
async function servidorResponde() {
    try {
        const r = await fetch(ORIGEN + '/index.html', { method: 'GET' });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Garantiza que el servidor local esté escuchando en 5500.
 * Si no lo está, lo arranca (con la salida a un archivo: en entornos
 * confinados los pipes con nombre no están permitidos).
 */
async function asegurarServidor() {
    titulo('0. SERVIDOR LOCAL');
    if (await servidorResponde()) {
        nota('ya había un servidor escuchando en ' + ORIGEN + ' (se reutiliza)');
        check('Servidor local disponible en ' + ORIGEN, true);
        return;
    }

    const script = path.join(RAIZ, '_servidor_pruebas.js');
    if (!fs.existsSync(script)) {
        check('Servidor local disponible en ' + ORIGEN, false, 'no existe ' + script);
        return;
    }

    let descriptor = 'ignore';
    try { descriptor = fs.openSync(LOG_SERVIDOR, 'w'); } catch (e) { descriptor = 'ignore'; }

    ESTADO.servidorPropio = spawn(process.execPath, [script], {
        cwd: RAIZ,
        stdio: ['ignore', descriptor, descriptor],
        windowsHide: true
    });
    ESTADO.servidorPropio.on('error', (e) => nota('no se pudo arrancar el servidor: ' + e.message));

    for (let i = 0; i < 40; i++) {
        if (await servidorResponde()) break;
        await esperar(250);
    }
    const listo = await servidorResponde();
    check('Servidor local arrancado en ' + ORIGEN, listo, listo ? '' : 'revisa ' + LOG_SERVIDOR);
    return;
}

function esperar(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------------------------------------------
   VIGILANCIA DE PÁGINA: consola, red y errores.
   Sirve para saber SI el cuelgue son los CDN, el servidor o la app.
   --------------------------------------------------------------------- */
const VIGILANCIAS = new Map();

/** Engancha escuchas de consola/red a una página. Devuelve el registro. */
function vigilar(page, etiqueta) {
    const reg = {
        etiqueta: etiqueta || 'página',
        consola: [],
        pageerrors: [],
        fallidas: [],
        erroresHttp: [],
        enVuelo: new Map(),
        externas: new Set()
    };
    page.on('console', (m) => {
        if (reg.consola.length < 80) reg.consola.push('[' + m.type() + '] ' + String(m.text()).slice(0, 240));
    });
    page.on('pageerror', (e) => {
        if (reg.pageerrors.length < 40) reg.pageerrors.push(String(e.message).split('\n')[0].slice(0, 240));
    });
    page.on('request', (r) => {
        reg.enVuelo.set(r, r.url());
        try {
            const u = new URL(r.url());
            if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') reg.externas.add(u.origin);
        } catch (e) { /* URL rara */ }
    });
    page.on('requestfinished', (r) => reg.enVuelo.delete(r));
    page.on('requestfailed', (r) => {
        reg.enVuelo.delete(r);
        const f = r.failure();
        if (reg.fallidas.length < 40) {
            reg.fallidas.push(r.url().slice(0, 150) + '  -> ' + (f ? f.errorText : 'desconocido'));
        }
    });
    page.on('response', (r) => {
        if (r.status() >= 400 && reg.erroresHttp.length < 40) {
            reg.erroresHttp.push(r.status() + ' ' + r.url().slice(0, 150));
        }
    });
    VIGILANCIAS.set(page, reg);
    return reg;
}

function limpiarNombre(texto) {
    return String(texto || 'diagnostico').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'diagnostico';
}

/**
 * Vuelca lo que el navegador está viendo: peticiones EN VUELO (la causa típica
 * de un cuelgue), fallidas, respuestas con error, errores de JS y consola.
 * Además guarda una captura.
 */
async function diagnosticoDePagina(page, motivo) {
    const reg = VIGILANCIAS.get(page) || {
        consola: [], pageerrors: [], fallidas: [], erroresHttp: [], enVuelo: new Map(), externas: new Set()
    };
    console.log('');
    console.log('--- DIAGNÓSTICO DE PÁGINA · ' + (motivo || '') + ' ---');
    try { console.log('  URL actual: ' + page.url()); } catch (e) { /* página cerrada */ }
    console.log('  Hosts externos contactados: ' + (reg.externas.size ? Array.from(reg.externas).join(', ') : '(ninguno)'));
    try {
        const listo = await page.evaluate(function () { return document.readyState; });
        console.log('  readyState: ' + listo);
    } catch (e) { console.log('  readyState: (no se pudo leer)'); }

    console.log('  Peticiones EN VUELO (' + reg.enVuelo.size + '):');
    Array.from(reg.enVuelo.values()).slice(0, 15).forEach((u) => console.log('     · ' + u.slice(0, 170)));
    console.log('  Peticiones FALLIDAS (' + reg.fallidas.length + '):');
    reg.fallidas.slice(0, 15).forEach((f) => console.log('     · ' + f));
    console.log('  Respuestas HTTP con error (' + reg.erroresHttp.length + '):');
    reg.erroresHttp.slice(0, 15).forEach((f) => console.log('     · ' + f));
    console.log('  Errores de JavaScript (' + reg.pageerrors.length + '):');
    reg.pageerrors.slice(0, 10).forEach((f) => console.log('     · ' + f));
    console.log('  Consola (' + reg.consola.length + '):');
    reg.consola.slice(-25).forEach((f) => console.log('     · ' + f));
    await captura(page, 'diagnostico_' + limpiarNombre(motivo));
    return reg;
}

/**
 * Si la página acabó en otro sitio (lo típico: rebotada al login por sesion.js),
 * lo dice, VUELCA LA PUERTA DE SESIÓN (motivo exacto de sesion.js + marcadores +
 * estado real de Firebase Auth + claves del SDK) y deja el diagnóstico de red.
 * No cuenta como comprobación: solo informa.
 */
async function diagnosticarSiRedirigio(page, esperado, etiqueta) {
    let url = '';
    try { url = page.url(); } catch (e) { return; }
    if (url.indexOf(esperado) === -1) {
        nota(etiqueta + ': la página acabó en ' + url + ' (se esperaba ' + esperado + ')');
        await capturarPuertaDeSesion(page, etiqueta + ' acabo en ' + url);
        await diagnosticoDePagina(page, etiqueta + ' acabo en ' + url);
    }
}

/** Añade un ?v=<timestamp> para que ningún caché pueda servir algo viejo. */
function conCacheBuster(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
}

/**
 * Navega SIN depender de 'domcontentloaded' y con cache-buster.
 * Devuelve {ok:false} y deja el diagnóstico si la navegación no se puede ni
 * comprometer (servidor caído). Si se compromete, espera DOMContentLoaded sin
 * bloquear: aunque la página tarde por los CDN, la prueba sigue.
 */
async function irA(page, url, etiqueta) {
    try {
        await page.goto(conCacheBuster(url), { waitUntil: OPCIONES.waitUntil, timeout: OPCIONES.timeout });
    } catch (e) {
        await diagnosticoDePagina(page, 'no se pudo navegar a ' + url + ' [' + (etiqueta || '') + ']');
        return { ok: false, error: String(e.message).split('\n')[0] };
    }
    await page.waitForLoadState('domcontentloaded', { timeout: OPCIONES.timeoutDom })
        .catch(() => { /* se sigue: las esperas por selector son las que mandan */ });
    return { ok: true };
}

/** Ejecuta un escenario sin que una excepción tumbe el resto de la suite. */
async function correr(etiqueta, fn) {
    try {
        return await fn();
    } catch (e) {
        check(etiqueta, false, 'excepción: ' + String((e && e.message) || e).split('\n')[0]);
        return null;
    }
}

/* =====================================================================
   4-bis. MEDIR LA PUERTA DE SESIÓN (no suponerla)
   Cuando una página interna acaba en index.html, sesion.js deja una capa con
   el motivo EXACTO. Aquí se vuelca todo lo que hace falta para saber cuál de
   las tres puertas falló: la marca 'sesionActiva', el marcador del equipo, o
   la sesión real de Firebase Auth.
   ===================================================================== */

/** Foto completa de la puerta de sesión en la página actual. */
async function fotoDePuertaDeSesion(page) {
    return page.evaluate(function () {
        // 1) Capa de aviso de sesion.js (dice el motivo exacto).
        let aviso = null;
        try {
            const capas = Array.from(document.querySelectorAll('div'));
            const capa = capas.filter(function (d) {
                const estilo = d.getAttribute && (d.getAttribute('style') || '');
                return /position:\s*fixed/.test(estilo) &&
                    /Sesi[oó]n no activa|Volviendo al inicio de sesi[oó]n/i.test(d.textContent || '');
            })[0];
            if (capa) aviso = (capa.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        } catch (e) { aviso = 'error leyendo la capa: ' + e.message; }

        // 2) Marcas locales (leídas con las funciones crudas si están).
        const leer = function (k) {
            try {
                if (window.__crudo && window.__crudo.getItem) return window.__crudo.getItem.call(localStorage, k);
                return localStorage.getItem(k);
            } catch (e) { return 'error: ' + e.message; }
        };

        // 3) Volcado físico (para ver prefijos y claves del SDK).
        let fisicas = {};
        try {
            if (window.__crudo && window.__crudo.length) {
                const n = window.__crudo.length.call(localStorage);
                for (let i = 0; i < n; i++) {
                    const k = window.__crudo.key.call(localStorage, i);
                    if (k === null || typeof k === 'undefined') continue;
                    fisicas[k] = window.__crudo.getItem.call(localStorage, k);
                }
            } else {
                Object.keys(localStorage).forEach(function (k) { fisicas[k] = localStorage.getItem(k); });
            }
        } catch (e) { fisicas = { error: String(e.message) }; }

        const claves = Object.keys(fisicas);
        const clavesFirebase = claves.filter(function (k) { return k.toLowerCase().indexOf('firebase') !== -1; })
            .map(function (k) { return { clave: k, bytes: String(fisicas[k] || '').length }; });
        const prefijadasDeFirebase = claves.filter(function (k) {
            return k.indexOf('cuenta:') === 0 && k.toLowerCase().indexOf('firebase') !== -1;
        });
        const sinPrefijo = claves.filter(function (k) { return k.indexOf('cuenta:') !== 0; });
        const cuarentena = claves.filter(function (k) { return k.indexOf('_legacy_:') === 0; });

        // 4) Estado real de Firebase Auth.
        let usuario = null;
        let errorAuth = null;
        try {
            if (window.firebase && typeof firebase.auth === 'function') {
                const u = firebase.auth().currentUser;
                usuario = u ? { uid: String(u.uid).slice(0, 12), email: u.email } : null;
            } else {
                errorAuth = 'firebase.auth no disponible';
            }
        } catch (e) { errorAuth = String(e.message); }

        return {
            url: location.href,
            avisoSesionJs: aviso,
            sesionActiva: leer('sesionActiva'),
            datosDeCuenta: leer('datosDeCuenta'),
            datosCuentaEstado: window.datosCuenta ? window.datosCuenta.estado() : null,
            usuarioFirebase: usuario,
            errorAuth: errorAuth,
            toasts: (window.__toasts || []).slice(-5),
            toastEnPantalla: (function () {
                const t = document.querySelector('.toast');
                return t ? String(t.textContent || '').replace(/\s+/g, ' ').trim() : null;
            })(),
            clavesFirebase: clavesFirebase,
            prefijadasDeFirebase: prefijadasDeFirebase,
            clavesSinPrefijo: sinPrefijo,
            clavesEnCuarentena: cuarentena,
            totalClavesFisicas: claves.length
        };
    }).catch(function (e) { return { error: String(e.message) }; });
}

/** Vuelca la foto de la puerta de sesión y guarda captura. */
async function capturarPuertaDeSesion(page, etiqueta) {
    const foto = await fotoDePuertaDeSesion(page);
    console.log('');
    console.log('--- PUERTA DE SESIÓN · ' + etiqueta + ' ---');
    console.log(JSON.stringify(foto, null, 2));
    await captura(page, 'puerta_sesion_' + limpiarNombre(etiqueta));
    return foto;
}

/**
 * Espera a que la página esté asentada. Nunca falla.
 * Si se pasa un selector, espera a ESE elemento (que es lo que de verdad
 * necesita el escenario); si no, espera DOMContentLoaded con tope. En los dos
 * casos añade una espera corta para dar tiempo a la app a pintar.
 */
async function asentar(page, ms, selector) {
    if (selector) {
        await page.waitForSelector(selector, { timeout: OPCIONES.timeoutDom })
            .catch(() => { /* si no aparece, el escenario lo reportará */ });
    } else {
        await page.waitForLoadState('domcontentloaded', { timeout: OPCIONES.timeoutDom })
            .catch(() => { /* si no llega, se sigue igual */ });
    }
    await esperar(ms);
}

/* =====================================================================
   5. FIREBASE AUTH / RTDB POR REST (crear, aprobar y BORRAR cuentas de prueba)
   ===================================================================== */

function marca() {
    return Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-3);
}

function claveAleatoria() {
    return 'Pw!' + Math.random().toString(36).slice(2, 10) + 'Aa1';
}

/** Normalización de correo a ruta, idéntica a la de la app. */
function rutaDeEmail(email) {
    return String(email).trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');
}

/** Crea una cuenta en Firebase Auth por REST. */
async function crearCuentaAuth(email, password) {
    const r = await fetch(AUTH_REST + 'signUp?key=' + API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok || !datos.idToken) {
        const motivo = (datos && datos.error && datos.error.message) || ('HTTP ' + r.status);
        throw new Error('no se pudo crear ' + email + ': ' + motivo);
    }
    return { email: email, password: password, idToken: datos.idToken, localId: datos.localId, refreshToken: datos.refreshToken };
}

/** Borra la cuenta de Firebase Auth (limpieza obligatoria). */
async function borrarCuentaAuth(cuenta) {
    try {
        const r = await fetch(AUTH_REST + 'delete?key=' + API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: cuenta.idToken })
        });
        return { ok: r.ok, detalle: r.ok ? 'borrada' : ('HTTP ' + r.status) };
    } catch (e) {
        return { ok: false, detalle: e.message };
    }
}

/**
 * Intenta dejar la cuenta APROBADA escribiendo usuarios/<uid> con ingreso:true.
 * Solo funciona si las reglas desplegadas lo permiten (reglas-fase1.json sí;
 * reglas-firebase.json exige ingreso === false y lo rechaza).
 */
async function aprobarPerfil(cuenta) {
    const emailPath = rutaDeEmail(cuenta.email);
    const cuerpo = {
        email: String(cuenta.email).toLowerCase(),
        emailPath: emailPath,
        ingreso: true,
        createdAt: new Date().toISOString(),
        origen: 'prueba-playwright'
    };
    const url = DB_URL + '/usuarios/' + cuenta.localId + '.json?auth=' + cuenta.idToken;
    try {
        const r = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpo)
        });
        if (r.ok) {
            ESTADO.nodosCreados.push('usuarios/' + cuenta.localId);
            return { ok: true, detalle: 'perfil creado con ingreso:true' };
        }
        const texto = await r.text().catch(() => '');
        return { ok: false, detalle: 'HTTP ' + r.status + ' ' + texto.slice(0, 120) };
    } catch (e) {
        return { ok: false, detalle: e.message };
    }
}

/** Intenta borrar usuarios/<uid> (puede estar prohibido por las reglas). */
async function borrarPerfil(cuenta) {
    const url = DB_URL + '/usuarios/' + cuenta.localId + '.json?auth=' + cuenta.idToken;
    try {
        const r = await fetch(url, { method: 'DELETE' });
        return { ok: r.ok, detalle: r.ok ? 'borrado' : ('HTTP ' + r.status) };
    } catch (e) {
        return { ok: false, detalle: e.message };
    }
}

/** Lee un nodo de la RTDB (solo lectura; no escribe nada). */
async function leerNodo(ruta, idToken) {
    const url = DB_URL + '/' + ruta + '.json?auth=' + idToken;
    const r = await fetch(url, { method: 'GET' });
    return { ok: r.ok, status: r.status, cuerpo: await r.text().catch(() => '') };
}

/**
 * Inicia sesión en Firebase Auth por REST (cuenta YA existente, p. ej. PW_EMAIL_A).
 * Solo se usa para LEER su perfil y comprobar la aprobación; no crea ni borra nada.
 */
async function iniciarSesionRest(email, password) {
    const r = await fetch(AUTH_REST + 'signInWithPassword?key=' + API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok || !datos.idToken) {
        const motivo = (datos && datos.error && datos.error.message) || ('HTTP ' + r.status);
        throw new Error('no se pudo iniciar sesión con esa cuenta: ' + motivo);
    }
    return { idToken: datos.idToken, localId: datos.localId, email: email };
}

/* =====================================================================
   6. LANZAMIENTO DEL NAVEGADOR
   ===================================================================== */

/**
 * Abre Chromium.
 *   - Con PW_CDP se adjunta a un Chrome ya abierto con --remote-debugging-port
 *     (útil en entornos donde el sandbox impide lanzar procesos hijos).
 *   - Si no, lo lanza Playwright en modo headless.
 */
async function abrirNavegador(pw) {
    if (OPCIONES.cdp) {
        nota('adjuntándose al Chrome existente en ' + OPCIONES.cdp);
        const navegador = await pw.chromium.connectOverCDP(OPCIONES.cdp);
        ESTADO.navegadorPropio = false;
        return navegador;
    }
    const navegador = await pw.chromium.launch({
        headless: !OPCIONES.headful,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    ESTADO.navegadorPropio = true;
    return navegador;
}

/** Explica con precisión por qué no se pudo abrir el navegador. */
function diagnosticarFalloDeNavegador(error) {
    const mensaje = String((error && error.message) || error);
    console.log('');
    console.log('--- DIAGNÓSTICO DEL FALLO DE NAVEGADOR ---');
    console.log(mensaje.split('\n').slice(0, 4).join('\n'));
    if (mensaje.indexOf('EPERM') !== -1) {
        console.log('');
        console.log('El entorno impide crear/conectar pipes con nombre, que es como Chromium');
        console.log('comunica sus procesos internos (Mojo). Síntomas típicos:');
        console.log('  - "browserType.launch: spawn EPERM"');
        console.log('  - "FATAL:mojo\\public\\cpp\\platform\\platform_channel.cc:108 Check failed:');
        console.log('     . : Acceso denegado. (0x5)"');
        console.log('');
        console.log('SALIDAS:');
        console.log('  1) Ejecutar esta suite FUERA del sandbox (una consola normal del equipo):');
        console.log('       node pruebas_navegador.js');
        console.log('  2) O abrir Chrome a mano con depuración y adjuntarse:');
        console.log('       "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \\');
        console.log('         --remote-debugging-port=9222 --user-data-dir=%TEMP%\\pw-perfil about:blank');
        console.log('       set PW_CDP=http://127.0.0.1:9222');
        console.log('       node pruebas_navegador.js');
    }
}

/* =====================================================================
   7. AYUDAS DENTRO DE LA PÁGINA
   ===================================================================== */

/**
 * Script de arranque (addInitScript). Corre ANTES que cualquier script de la
 * página, así que aquí se guardan las funciones CRUDAS de Storage antes de que
 * datos_cuenta.js parchee Storage.prototype; sin esto no habría forma de leer
 * las claves físicas (con prefijo) desde la propia página.
 *
 * OJO: aquí NO se siembra nada. Antes se sembraba desde este script con una
 * marca en sessionStorage; al cerrar sesión (que limpia sessionStorage) la marca
 * desaparecía y el script VOLVÍA A SEMBRAR datos sin prefijo a mitad de la
 * prueba; luego la migración de la cuenta B los reclamaba y C.8c lo señalaba
 * como fuga de la app cuando en realidad era la prueba resembrando.
 * Ahora la siembra se hace UNA sola vez, explícitamente, con `sembrar()`.
 *
 * También deja un cazador de toasts: el aviso de "su cuenta aún no ha sido
 * aprobada" es la pista que distingue un login rechazado de una sesión perdida.
 */
function guionCrudo() {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');
        window.__crudo = {
            getItem: Storage.prototype.getItem,
            setItem: Storage.prototype.setItem,
            removeItem: Storage.prototype.removeItem,
            key: Storage.prototype.key,
            length: descriptor && descriptor.get
        };
    } catch (e) { window.__crudo = null; }

    try {
        window.__toasts = [];
        document.addEventListener('DOMContentLoaded', function () {
            try {
                const observador = new MutationObserver(function (mutaciones) {
                    mutaciones.forEach(function (m) {
                        Array.prototype.forEach.call(m.addedNodes || [], function (n) {
                            if (n && n.classList && n.classList.contains('toast')) {
                                window.__toasts.push(String(n.textContent || '').replace(/\s+/g, ' ').trim());
                            }
                        });
                    });
                });
                observador.observe(document.body || document.documentElement, { childList: true, subtree: true });
            } catch (e) { /* sin cazador de toasts */ }
        });
    } catch (e) { /* nada */ }
}

/**
 * Siembra los datos de negocio SIN prefijo, UNA sola vez, con las funciones
 * crudas de Storage (así se escribe el nombre físico real, como lo tendría un
 * cliente de antes de esta fase). No usa marcas en sessionStorage: no puede
 * repetirse sola.
 */
async function sembrar(page, semilla) {
    return page.evaluate(function (datos) {
        const puestas = [];
        const poner = (window.__crudo && typeof window.__crudo.setItem === 'function')
            ? function (k, v) { window.__crudo.setItem.call(localStorage, k, v); }
            : function (k, v) { localStorage.setItem(k, v); };
        Object.keys(datos).forEach(function (k) { poner(k, datos[k]); puestas.push(k); });
        return puestas;
    }, semilla);
}

/** Devuelve el volcado FÍSICO de localStorage (claves con prefijo incluidas). */
function leerClavesFisicas() {
    const salida = {};
    try {
        if (window.__crudo && window.__crudo.length) {
            const n = window.__crudo.length.call(localStorage);
            for (let i = 0; i < n; i++) {
                const k = window.__crudo.key.call(localStorage, i);
                if (k === null || typeof k === 'undefined') continue;
                salida[k] = window.__crudo.getItem.call(localStorage, k);
            }
            return salida;
        }
    } catch (e) { /* se intenta el plan B */ }

    // Plan B: un iframe del mismo origen tiene su PROPIO Storage.prototype,
    // sin el parche de datos_cuenta.js, así que ve las claves físicas.
    try {
        const marco = document.createElement('iframe');
        marco.style.display = 'none';
        document.documentElement.appendChild(marco);
        const almacen = marco.contentWindow.localStorage;
        for (let i = 0; i < almacen.length; i++) {
            const k = almacen.key(i);
            if (k !== null) salida[k] = almacen.getItem(k);
        }
        marco.remove();
    } catch (e) { /* sin volcado físico */ }
    return salida;
}

/* =====================================================================
   8. PRECONDICIONES: cuentas de prueba
   ===================================================================== */

/**
 * Prepara las dos cuentas de prueba.
 * A debe quedar APROBADA (usuarios/<uid>.ingreso === true) para poder entrar:
 * sin eso index.html responde "Su cuenta aún no ha sido aprobada" y ninguna
 * página interna (todas exigen sesion.js) se abre.
 */
async function prepararCuentas() {
    titulo('PRECONDICIÓN · CUENTAS DE PRUEBA');
    const etiqueta = marca();
    const cuentas = { A: null, B: null };

    if (OPCIONES.emailA && OPCIONES.passA) {
        cuentas.A = { email: OPCIONES.emailA, password: OPCIONES.passA, externa: true };
        nota('cuenta A tomada de PW_EMAIL_A: ' + OPCIONES.emailA + ' (no se borrará)');
    } else {
        const email = 'prueba.playwright.a' + etiqueta + '@example.com';
        const password = claveAleatoria();
        try {
            cuentas.A = await crearCuentaAuth(email, password);
            ESTADO.cuentasCreadas.push(cuentas.A);
            nota('cuenta A creada en Firebase Auth: ' + email);
        } catch (e) {
            check('Crear la cuenta de prueba A', false, e.message);
            return cuentas;
        }
    }

    if (OPCIONES.emailB && OPCIONES.passB) {
        cuentas.B = { email: OPCIONES.emailB, password: OPCIONES.passB, externa: true };
        nota('cuenta B tomada de PW_EMAIL_B: ' + OPCIONES.emailB + ' (no se borrará)');
    } else {
        const email = 'prueba.playwright.b' + etiqueta + '@example.com';
        const password = claveAleatoria();
        try {
            cuentas.B = await crearCuentaAuth(email, password);
            ESTADO.cuentasCreadas.push(cuentas.B);
            nota('cuenta B creada en Firebase Auth: ' + email);
        } catch (e) {
            check('Crear la cuenta de prueba B', false, e.message);
            return cuentas;
        }
    }

    // Aprobación de A: la app nunca se autoaprueba (crea el perfil con
    // ingreso:false). Aquí se intenta por REST solo si se pidió.
    if (!cuentas.A.externa && OPCIONES.autoaprobar) {
        const res = await aprobarPerfil(cuentas.A);
        check('Aprobar la cuenta A por REST (usuarios/<uid>.ingreso = true)', res.ok, res.detalle);
        if (!res.ok) {
            nota('Las reglas desplegadas no permiten autoaprobar. Hay que aprobar la cuenta');
            nota('en la consola de Firebase, o pasar PW_EMAIL_A/PW_PASS_A de una cuenta ya aprobada.');
        }
    } else if (!cuentas.A.externa && !OPCIONES.autoaprobar) {
        nota('No se pidió --autoaprobar: la cuenta A se usará tal cual (probablemente sin aprobar).');
    }
    return cuentas;
}

/* =====================================================================
   9. ESCENARIOS
   ===================================================================== */

/**
 * Inicia sesión en index.html y espera el DESENLACE REAL.
 *
 * OJO (causa real del rebote al login, detectada al instrumentar): antes esta
 * función daba el login por bueno en cuanto `datosCuenta.estado().activa` era
 * true. Pero en index.html la activación y la migración ocurren ANTES de que la
 * app compruebe la aprobación del propietario:
 *
 *     datosCuenta.activarYMigrar(email)          // activa = true, migra
 *     const perfil = await ensureOwnerProfile()  // ida y vuelta a la nube
 *     if (!perfil || perfil.ingreso !== true) { await auth.signOut(); return false; }
 *
 * Es decir: con una cuenta NO aprobada, `activa` ya era true cuando la prueba
 * miraba, la prueba decía "login OK", y en la página siguiente sesion.js (que
 * exige la marca 'sesionActiva', escrita solo cuando el login termina bien)
 * devolvía todo a index.html. El síntoma parecía un fallo del aislamiento y en
 * realidad era un login RECHAZADO.
 *
 * Ahora el éxito exige una de estas dos cosas:
 *   - que la página haya navegado a una página interna, o
 *   - que exista 'sesionActiva' en localStorage (la marca que escribe la app
 *     solo cuando el login termina bien).
 * Si aparece el aviso de cuenta ajena o el toast de "no aprobada", se informa
 * con ese motivo exacto.
 */
async function iniciarSesion(page, email, password) {
    // Se entra en limpio: sin marca de sesión y sin usuario de Firebase previo.
    // NO se limpia sessionStorage (no hace falta y era la fuente de la resiembra).
    await page.goto(conCacheBuster(ORIGEN + '/index.html'), { waitUntil: OPCIONES.waitUntil, timeout: OPCIONES.timeout }).catch(async (e) => {
        await diagnosticoDePagina(page, 'login: no se pudo cargar index.html');
        throw e;
    });
    await page.evaluate(async function () {
        try {
            if (window.firebase && typeof firebase.auth === 'function') await firebase.auth().signOut();
        } catch (e) { /* si no se puede, se sigue igual */ }
        try { localStorage.removeItem('sesionActiva'); } catch (e) { /* nada */ }
        try { window.__toasts = []; } catch (e) { /* nada */ }
    });

    const formulario = await page.waitForSelector('#email', { timeout: OPCIONES.timeout }).catch(() => null);
    if (!formulario) {
        // Aquí es donde se ve si el formulario no llega por culpa de un CDN que
        // bloquea el parser (script síncrono en el <head> que nunca termina).
        await diagnosticoDePagina(page, 'login: el formulario #email no apareció');
        return { ok: false, motivo: 'no apareció el formulario de login', url: page.url() };
    }
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('#loginButton');

    const limite = Date.now() + OPCIONES.timeout;
    let ultima = null;
    while (Date.now() < limite) {
        await esperar(300);
        const url = page.url();
        if (url.indexOf('index.html') === -1) {
            return { ok: true, url: url, via: 'navegación a página interna' };
        }

        ultima = await page.evaluate(function () {
            const capa = document.getElementById('avisoCuentaAjena');
            let marca = null;
            try { marca = localStorage.getItem('sesionActiva'); } catch (e) { /* nada */ }
            let usuario = null;
            try {
                const u = window.firebase && firebase.auth && firebase.auth().currentUser;
                if (u) usuario = { uid: String(u.uid).slice(0, 12), email: u.email };
            } catch (e) { /* nada */ }
            const estado = window.datosCuenta ? window.datosCuenta.estado() : null;
            const toasts = (window.__toasts || []).slice(-4);
            const t = document.querySelector('.toast');
            return {
                ajena: !!capa,
                sesionActiva: marca,
                usuario: usuario,
                activa: !!(estado && estado.activa),
                migrada: !!(estado && estado.migrada),
                toasts: toasts,
                toast: t ? String(t.textContent || '').replace(/\s+/g, ' ').trim() : null
            };
        });

        if (ultima.ajena) return { ok: false, motivo: 'aviso de cuenta ajena (fase 1)', url: url, detalle: ultima };
        const rechazo = (ultima.toasts || []).concat(ultima.toast ? [ultima.toast] : [])
            .filter(function (t) { return /aprobad|rechaz|no autoriz|denegad/i.test(t); })[0];
        if (rechazo) return { ok: false, motivo: 'LOGIN RECHAZADO POR LA APP: ' + rechazo, url: url, detalle: ultima };
        if (ultima.sesionActiva) {
            await esperar(600);
            return { ok: true, url: page.url(), via: 'marca sesionActiva' };
        }
    }

    // No llegó ni a marca ni a redirección: se informa de TODO lo medido.
    return {
        ok: false,
        motivo: 'el login no terminó en ' + OPCIONES.timeout + ' ms' +
            (ultima && ultima.activa && !ultima.sesionActiva
                ? ' (la cuenta se activó y migró, pero la app NUNCA escribió sesionActiva:' +
                  ' login rechazado, casi seguro por falta de aprobación del propietario)'
                : ''),
        url: page.url(),
        detalle: ultima
    };
}

/** Lee el estado del módulo datos_cuenta en la página actual. */
async function estadoCuenta(page) {
    return page.evaluate(function () {
        if (!window.datosCuenta) return null;
        return window.datosCuenta.estado();
    });
}

/** Comprueba las claves de negocio justo después de la migración. */
async function comprobarMigracion(page, rutaA) {
    const fisicas = await page.evaluate(leerClavesFisicas);
    const esperadas = CLAVES_SEMILLA.map((k) => PREFIJO_CUENTA + rutaA + ':' + k);

    // 1) Las 7 claves de negocio están con prefijo.
    const faltan = esperadas.filter((k) => !(k in fisicas));
    check('A.3a Las 7 claves de negocio quedaron con prefijo cuenta:<ruta>:',
        faltan.length === 0,
        faltan.length ? 'faltan: ' + faltan.join(', ') : '');

    // 2) No queda NINGUNA clave de negocio sin prefijo. Solo pueden quedarse sin
    //    prefijo las de equipo (lista + prefijos: la sesión de Firebase Auth entre
    //    ellas) y los restos en cuarentena '_legacy_:' (que no son de nadie).
    const sinPrefijo = Object.keys(fisicas).filter((k) => k.indexOf(PREFIJO_CUENTA) !== 0);
    const intrusas = sinPrefijo.filter((k) => !esClaveSinPrefijoLegitima(k));
    check('A.3b Ninguna clave de negocio queda sin prefijo (solo equipo y cuarentena)',
        intrusas.length === 0,
        intrusas.length ? 'sin prefijo y no son de equipo/cuarentena: ' + intrusas.join(', ') : '');
    info('claves sin prefijo', sinPrefijo.join(', ') || '(ninguna)');
    const enCuarentena = sinPrefijo.filter((k) => k.indexOf(PREFIJO_CUARENTENA) === 0);
    if (enCuarentena.length) {
        info('restos en cuarentena (no son de ninguna cuenta)',
            enCuarentena.join(', ') + ' · la migración de la cuenta siguiente NO debe reclamarlos');
    }
    const clavesFirebase = sinPrefijo.filter((k) => PREFIJOS_EQUIPO.some((p) => k.indexOf(p) === 0));
    info('claves de equipo del SDK de Firebase (sin prefijo, es correcto)',
        clavesFirebase.length ? clavesFirebase.map((k) => k.slice(0, 40)).join(', ') : '(ninguna)');

    // 3) Los valores son IDÉNTICOS a los sembrados.
    const distintos = [];
    CLAVES_SEMILLA.forEach((k) => {
        const fisica = PREFIJO_CUENTA + rutaA + ':' + k;
        if (fisicas[fisica] !== SEMILLA[k]) distintos.push(k);
    });
    check('A.3c Los 7 valores son idénticos a los sembrados (antes/después)',
        distintos.length === 0,
        distintos.length ? 'distintos: ' + distintos.join(', ') : '');

    return fisicas;
}

/** Escenario A completo. */
async function escenarioA(contexto, cuentas, estado) {
    titulo('A. MIGRACIÓN DE DATOS EN NAVEGADOR REAL');

    const page = await contexto.newPage();
    page.setDefaultTimeout(OPCIONES.timeout);
    page.setDefaultNavigationTimeout(OPCIONES.timeout);
    page.on('dialog', (d) => d.accept().catch(() => { /* nada */ }));
    vigilar(page, 'A');

    // addInitScript: solo captura las funciones CRUDAS de Storage (y un cazador
    // de toasts). NO siembra: la siembra es un paso explícito, una sola vez.
    await page.addInitScript(guionCrudo);

    // A.1 · Cargar index.html y SEMBRAR una sola vez.
    const navA1 = await irA(page, ORIGEN + '/index.html', 'A.1 siembra');
    if (!navA1.ok) {
        check('A.1 Sembradas las 7 claves de negocio SIN prefijo antes de iniciar sesión', false,
            'no se pudo ni cargar index.html: ' + navA1.error);
        await page.close();
        return { page: null };
    }
    // Con 'commit' el documento ya existe; se espera a que el script de arranque
    // (que guarda las funciones crudas de Storage) haya corrido.
    await page.waitForFunction(function () { return !!window.__crudo; }, null, { timeout: 10000 })
        .catch(() => { /* si no aparece, se lee igual y se verá en las claves */ });

    const puestas = await sembrar(page, SEMILLA);
    nota('sembradas ' + puestas.length + ' claves sin prefijo: ' + puestas.join(', '));

    const sembrado = await page.evaluate(leerClavesFisicas);
    const sembradasOk = CLAVES_SEMILLA.every((k) => sembrado[k] === SEMILLA[k]);
    check('A.1 Sembradas las 7 claves de negocio SIN prefijo antes de iniciar sesión', sembradasOk,
        sembradasOk ? '' : 'claves vistas: ' + Object.keys(sembrado).join(', '));

    // A.1b · ¿Terminó index.html de cargar? Si no, se vuelca el diagnóstico:
    // es la forma de distinguir "CDN lento" de "servidor" o "app".
    const listo = await page.evaluate(function () { return document.readyState; }).catch(() => 'error');
    info('readyState de index.html tras la siembra', listo);
    if (listo !== 'complete' && listo !== 'interactive') {
        check('A.1b index.html completó su carga (los CDN responden en el navegador)', false,
            'readyState=' + listo + ' · ver diagnóstico');
        await diagnosticoDePagina(page, 'index.html no termino de cargar');
    } else {
        check('A.1b index.html completó su carga (los CDN responden en el navegador)', true, 'readyState=' + listo);
    }
    await captura(page, 'A1_datos_sembrados_antes_del_login');

    // A.2 · Iniciar sesión con la cuenta A.
    const login = await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    if (!login.ok) {
        check('A.2 Inicio de sesión con la cuenta de prueba A', false,
            login.motivo + ' (URL: ' + login.url + ')');
        info('detalle del login', JSON.stringify(login.detalle || {}));
        await capturarPuertaDeSesion(page, 'A.2 login no completado');
        await captura(page, 'A2_login_fallido');
        await page.close();
        return { page: null };
    }
    check('A.2 Inicio de sesión con la cuenta de prueba A', true,
        'URL: ' + login.url + ' · vía: ' + (login.via || '?'));

    // A.2b/A.2c · ¿Llegó el ARREGLO a la página y quedó la sesión marcada?
    // Si esto falla, se sabe de inmediato que lo que corre no es el archivo bueno.
    const revision = await page.evaluate(function () {
        const estado = window.datosCuenta ? window.datosCuenta.estado() : null;
        let fisicas = [];
        try {
            if (window.__crudo && window.__crudo.length) {
                const n = window.__crudo.length.call(localStorage);
                for (let i = 0; i < n; i++) {
                    const k = window.__crudo.key.call(localStorage, i);
                    if (k !== null && typeof k !== 'undefined') fisicas.push(k);
                }
            } else { fisicas = Object.keys(localStorage); }
        } catch (e) { /* nada */ }
        return {
            hayModulo: !!window.datosCuenta,
            prefijosDeEquipo: estado ? estado.prefijosDeEquipo : null,
            clavesEnCuarentena: estado ? estado.clavesEnCuarentena : null,
            sesionActiva: (function () { try { return localStorage.getItem('sesionActiva'); } catch (e) { return null; } })(),
            prefijadasDeFirebase: fisicas.filter(function (k) {
                return k.indexOf('cuenta:') === 0 && k.toLowerCase().indexOf('firebase') !== -1;
            }),
            clavesFirebase: fisicas.filter(function (k) { return k.toLowerCase().indexOf('firebase') !== -1; })
        };
    });
    info('A.2b · módulo y arreglo en la página', JSON.stringify(revision));
    check('A.2b La página carga el datos_cuenta.js CON el arreglo (prefijosDeEquipo incluye firebase:)',
        !!revision.prefijosDeEquipo && revision.prefijosDeEquipo.indexOf('firebase:') !== -1,
        JSON.stringify(revision.prefijosDeEquipo));
    check('A.2c No hay ninguna clave cuenta:<ruta>:firebase:* (la sesión del SDK no se prefija)',
        revision.prefijadasDeFirebase.length === 0, revision.prefijadasDeFirebase.join(', '));
    check('A.2d La app escribió la marca de sesión (sesionActiva)', !!revision.sesionActiva,
        'sesionActiva=' + String(revision.sesionActiva).slice(0, 80));
    info('A.2 · claves del SDK de Firebase en disco', revision.clavesFirebase.join(', ') || '(ninguna)');
    await captura(page, 'A2_sesion_iniciada');

    // A.3 · Estado del módulo + claves prefijadas + valores idénticos.
    const est = await estadoCuenta(page);
    if (!est) {
        check('A.3 Estado de window.datosCuenta disponible', false, 'window.datosCuenta no existe en la página');
    } else {
        check('A.3.0 estado(): activa = true', est.activa === true, JSON.stringify(est));
        check('A.3.1 estado(): migrada = true', est.migrada === true, JSON.stringify(est));
        check('A.3.2 estado(): interceptado = true', est.interceptado === true, JSON.stringify(est));
        check('A.3.3 estado(): error = null', est.error === null || est.error === undefined, String(est.error));
        info('estado()', JSON.stringify(est));
    }
    await comprobarMigracion(page, rutaDeEmail(cuentas.A.email));
    await captura(page, 'A3_claves_migradas_con_prefijo');

    // A.4 · inventario.html: lo PINTADO debe coincidir con lo que la app tiene
    // en ese momento.
    // OJO (corrección tras la corrida real): en modo clásico la nube se descarga
    // y REEMPLAZA lo local, así que NO se puede afirmar que sobrevivan los 3
    // productos sembrados: si la cuenta tiene datos reales, ganan los de la nube
    // y eso es CORRECTO. Lo que se valida aquí es el camino
    // migración -> almacén de la cuenta -> pantalla, sin depender de quién gane.
    await irA(page, ORIGEN + '/inventario.html', 'inventario');
    await asentar(page, 3000, '#inventoryTableBody');
    await diagnosticarSiRedirigio(page, 'inventario.html', 'A.4 inventario');
    const inventario = await page.evaluate(function () {
        const cuerpo = document.getElementById('inventoryTableBody');
        const filas = cuerpo ? Array.from(cuerpo.querySelectorAll('tr')) : [];
        let esperado = null;
        try { esperado = JSON.parse(localStorage.getItem('ciervo_inventory') || 'null'); } catch (e) { esperado = null; }
        const lista = Array.isArray(esperado) ? esperado : [];
        // La tabla está PAGINADA: #pageInfo dice "Página 1 de N (M productos)".
        // M es el número de productos que declara la propia app.
        const info = document.getElementById('pageInfo');
        let declarado = null;
        if (info) {
            const m = /\((\d+)\s+productos?\)/i.exec(info.textContent || '');
            if (m) declarado = Number(m[1]);
        }
        return {
            url: location.href,
            hayTabla: !!cuerpo,
            filas: filas.length,
            textos: filas.map((f) => f.textContent.replace(/\s+/g, ' ').trim()),
            pageInfo: info ? info.textContent.trim() : null,
            declarado: declarado,
            enAlmacen: lista.length,
            nombres: lista.map((p) => String((p && (p.name || p.code)) || '')).filter(Boolean)
        };
    });
    check('A.4a inventario.html abre la tabla', inventario.hayTabla, 'URL final: ' + inventario.url);
    check('A.4b Lo que la app declara en #pageInfo coincide con el almacén de la cuenta',
        inventario.declarado === null
            ? inventario.filas === inventario.enAlmacen
            : inventario.declarado === inventario.enAlmacen,
        'declara: ' + inventario.declarado + ' · en el almacén de la cuenta: ' + inventario.enAlmacen +
        ' · ' + inventario.pageInfo);
    // La tabla pinta como máximo 10 filas por página (inventario.html:2176).
    const filasEsperadas = Math.min(10, inventario.enAlmacen);
    const filasUtiles = inventario.nombres.length === 0
        ? true
        : inventario.textos.every((t) => inventario.nombres.some((n) => t.indexOf(n) !== -1));
    check('A.4c Las filas pintadas son las esperadas y todas son productos del inventario',
        inventario.filas === filasEsperadas && filasUtiles,
        'pintadas: ' + inventario.filas + ' (esperadas ' + filasEsperadas + ') · ' +
        inventario.textos.join(' | ').slice(0, 160));
    info('A.4 · pageInfo', String(inventario.pageInfo) + ' · filas pintadas: ' + inventario.filas +
        ' · productos en el almacén de la cuenta: ' + inventario.enAlmacen);
    info('A.4 · primeros nombres', inventario.nombres.slice(0, 6).join(' | ') || '(inventario vacío)');
    const sembradosVivos = PRODUCTOS_SEMBRADOS.filter((p) => inventario.textos.join(' ').indexOf(p.name) !== -1).length;
    info('A.4 · de los 3 productos sembrados siguen en pantalla',
        sembradosVivos + ' (la nube puede haber reemplazado lo local: es lo esperado)');
    const muestraEnInventario = MARCAS_MUESTRA.filter((m) => inventario.textos.join(' ').indexOf(m) !== -1);
    check('A.4d Ningún dato de muestra en inventario.html', muestraEnInventario.length === 0,
        muestraEnInventario.join(', '));
    await captura(page, 'A4_inventario_lo_que_muestra_la_app');

    return { page: page };
}

/** Escenario B: datos de muestra fuera. */
async function escenarioB(page) {
    titulo('B. DATOS DE MUESTRA FUERA');

    // B.5 · menu.html
    await irA(page, ORIGEN + '/menu.html', 'menu');
    await esperar(2500);
    const menu = await page.evaluate(function () {
        return {
            url: location.href,
            titulo: document.title,
            texto: document.body ? document.body.innerText : '',
            /* ¿La página es de verdad menu.html, o la ha secuestrado el aviso de la
               fase 1 / un rebote al login? Sin esto, B.5a/B.5b pueden pasar sobre la
               página EQUIVOCADA (el login tampoco muestra datos de muestra). */
            avisoCuentaAjena: !!document.getElementById('avisoCuentaAjena'),
            avisoSesion: (function () {
                const d = document.querySelectorAll('div');
                for (let i = 0; i < d.length; i++) {
                    const t = String(d[i].textContent || '');
                    if (t.indexOf('Sesión no activa') !== -1 && t.length < 500) return t.replace(/\s+/g, ' ').trim().slice(0, 120);
                }
                return null;
            })(),
            currentUser: (function () { try { return sessionStorage.getItem('currentUser') ? 'presente' : null; } catch (e) { return null; } })(),
            inventarioLocal: (function () {
                try { return localStorage.getItem('ciervo_inventory'); } catch (e) { return 'ERROR'; }
            })()
        };
    });
    info('B.5 · URL de menu.html', menu.url + '  ·  título: ' + menu.titulo);
    info('B.5 · aviso de fase 1', String(menu.avisoCuentaAjena) +
        ' · aviso de sesión: ' + JSON.stringify(menu.avisoSesion) +
        ' · sessionStorage.currentUser: ' + JSON.stringify(menu.currentUser));
    info('inventario visible para la cuenta A en menu.html',
        menu.inventarioLocal === null ? '(vacío)' : String(menu.inventarioLocal).slice(0, 120));
    const muestraMenu = MARCAS_MUESTRA.filter((m) => menu.texto.indexOf(m) !== -1);
    check('B.5a menu.html no muestra LAP-HP-001 ni Cliente A ni el inventario de ejemplo',
        menu.texto.indexOf('LAP-HP-001') === -1 && menu.texto.indexOf('Cliente A') === -1,
        'encontrado: ' + muestraMenu.join(', '));
    check('B.5b menu.html sin rastro de las 12 marcas de muestra', muestraMenu.length === 0,
        muestraMenu.join(', '));
    check('B.5c menu.html abre limpio (no redirige al login)', menu.url.indexOf('menu.html') !== -1, menu.url);
    // B.5c-endurecida · Que la página sea DE VERDAD menu.html y no otra cosa (el login
    // tampoco muestra datos de muestra, así que B.5a/B.5b podían pasar sobre la página
    // EQUIVOCADA: era la contradicción entre "B.5 en verde" y "menu.html rebota").
    check('B.5d La página es menu.html de verdad (título propio + elemento propio, sin avisos)',
        menu.url.indexOf('menu.html') !== -1 &&
        /Ciervo Administrativo/.test(menu.titulo) &&
        !menu.avisoCuentaAjena && !menu.avisoSesion,
        'url=' + menu.url + ' · título="' + menu.titulo + '" · aviso fase1=' + menu.avisoCuentaAjena +
        ' · aviso sesión=' + JSON.stringify(menu.avisoSesion));
    const propio = await page.evaluate(function () {
        return {
            user: !!document.getElementById('user-name'),
            rol: !!document.getElementById('user-role'),
            panel: !!document.getElementById('notificationPanel'),
            modulos: document.querySelectorAll('.module-card, .menu-item, .nav-item').length
        };
    });
    check('B.5e menu.html renderiza su propio contenido (nombre, rol y módulos)',
        propio.user && propio.rol && propio.panel,
        JSON.stringify(propio));
    info('B.5 · elementos propios de menu.html', JSON.stringify(propio));
    await captura(page, 'B5_menu_sin_datos_de_muestra');

    /* =================================================================
       B.5x · REGRESIÓN DE LA PUERTA DE SESIÓN (familia del bug del POS)
       La puerta legada exigía sessionStorage['currentUser'], que SOLO escribe
       el login de OPERADOR y es POR PESTAÑA: un propietario con sesión válida
       que abría el menú en una pestaña nueva acababa en el login.
       Se prueban los dos lados: con sesión compartida NO debe salir; sin
       ninguna sesión SÍ debe salir (la seguridad no se relaja).
       ================================================================= */
    const marcaGuardada = await page.evaluate(function () {
        try { return localStorage.getItem('sesionActiva'); } catch (e) { return null; }
    });
    check('B.5x0 Hay marca compartida de sesión antes de la regresión', !!marcaGuardada,
        'sesionActiva=' + String(marcaGuardada).slice(0, 80));

    // (1) Propietario con sesión válida y SIN operador en esta pestaña.
    await page.evaluate(function () {
        try { sessionStorage.removeItem('currentUser'); } catch (e) { /* nada */ }
        try { sessionStorage.removeItem('propietarioActual'); } catch (e) { /* nada */ }
    });
    await irA(page, ORIGEN + '/menu.html', 'menu sin operador');
    await esperar(3000);
    const sinOperador = await page.evaluate(function () {
        return {
            url: location.href,
            titulo: document.title,
            currentUser: (function () { try { return sessionStorage.getItem('currentUser'); } catch (e) { return null; } })(),
            sesionActiva: (function () { try { return localStorage.getItem('sesionActiva') ? 'presente' : null; } catch (e) { return null; } })()
        };
    });
    check('B.5x1 Con sesión de propietario y currentUser ausente, menu.html NO navega al login',
        sinOperador.url.indexOf('menu.html') !== -1,
        'url=' + sinOperador.url + ' · currentUser=' + JSON.stringify(sinOperador.currentUser) +
        ' · sesionActiva=' + JSON.stringify(sinOperador.sesionActiva));
    await captura(page, 'B5x_menu_con_sesion_sin_operador');

    // (2) Sin NINGUNA sesión: la puerta debe seguir expulsando al login.
    //     Con sesion.js cargado en menu.html, la condición que debe fallar es la marca
    //     compartida 'sesionActiva' (menu.html no carga el SDK de Firebase, así que la
    //     comprobación de Auth queda en 'sin-comprobacion' y no bloquea).
    await page.evaluate(function () {
        try { localStorage.removeItem('sesionActiva'); } catch (e) { /* nada */ }
        try { sessionStorage.removeItem('currentUser'); } catch (e) { /* nada */ }
    });
    await irA(page, ORIGEN + '/menu.html', 'menu sin sesión');
    await esperar(3500);
    const sinSesion = await page.evaluate(function () {
        let marca = null;
        let usuario = null;
        try { marca = localStorage.getItem('sesionActiva'); } catch (e) { /* nada */ }
        try {
            const u = window.firebase && firebase.auth && firebase.auth().currentUser;
            if (u) usuario = { uid: String(u.uid).slice(0, 12), email: u.email };
        } catch (e) { /* nada */ }
        // Capa de aviso de sesion.js: dice el motivo EXACTO de la expulsión.
        let aviso = null;
        try {
            const capas = Array.from(document.querySelectorAll('div'));
            const capa = capas.filter(function (d) {
                const estilo = d.getAttribute && (d.getAttribute('style') || '');
                return /position:\s*fixed/.test(estilo) && /Sesi[oó]n no activa/i.test(d.textContent || '');
            })[0];
            if (capa) aviso = (capa.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        } catch (e) { /* nada */ }
        return {
            url: location.href,
            readyState: document.readyState,
            sesionActiva: marca ? 'presente' : null,
            sesionJsCargado: !!document.querySelector('script[src*="sesion.js"]'),
            avisoSesionJs: aviso,
            usuarioFirebase: usuario,
            titulo: document.title,
            toasts: (window.__toasts || []).slice(-4)
        };
    });
    const expulsado = sinSesion.url.indexOf('index.html') !== -1;
    check('B.5x2 Sin NINGUNA sesión, menu.html SÍ va al login (la seguridad no se relaja)',
        expulsado, expulsado ? '' : 'TRAZA: ' + JSON.stringify(sinSesion));
    if (!expulsado) {
        nota('La página NO expulsó. Condiciones medidas, para saber cuál falla:');
        nota('  · sesion.js cargado en la página : ' + sinSesion.sesionJsCargado);
        nota('  · marca sesionActiva             : ' + String(sinSesion.sesionActiva));
        nota('  · aviso de sesion.js             : ' + JSON.stringify(sinSesion.avisoSesionJs));
        nota('  · usuario de Firebase            : ' + JSON.stringify(sinSesion.usuarioFirebase));
        nota('  · título / readyState            : "' + sinSesion.titulo + '" / ' + sinSesion.readyState);
        nota('  · toasts capturados              : ' + JSON.stringify(sinSesion.toasts));
        await capturarPuertaDeSesion(page, 'B.5x2 menu sin sesion no expulso');
    }

    // (3) Restaurar la marca compartida para los escenarios siguientes.
    await page.evaluate(function (marca) {
        try { if (marca) localStorage.setItem('sesionActiva', marca); } catch (e) { /* nada */ }
    }, marcaGuardada);
    nota('marca de sesión restaurada para el resto de la suite');

    // B.6 · config_recibo.html
    await irA(page, ORIGEN + '/config_recibo.html', 'config_recibo');
    await asentar(page, 2500, '#ticketPreview');
    await diagnosticarSiRedirigio(page, 'config_recibo.html', 'B.6 config_recibo');
    const recibo = await page.evaluate(function () {
        const previa = document.getElementById('ticketPreview');
        const tasa = document.querySelector('[id*="tasa" i], [id*="rate" i]');
        return {
            url: location.href,
            hayPrevia: !!previa,
            textoPrevia: previa ? previa.innerText : '',
            textoTasa: tasa ? tasa.textContent.trim() : '(sin elemento de tasa)'
        };
    });
    check('B.6a config_recibo.html abre la vista previa', recibo.hayPrevia, 'URL final: ' + recibo.url);
    check('B.6b La vista previa no muestra "TIENDA DE EJEMPLO C.A."',
        recibo.textoPrevia.indexOf('TIENDA DE EJEMPLO') === -1,
        recibo.textoPrevia.slice(0, 200));
    check('B.6c La vista previa no muestra el RIF de ejemplo J-12345678',
        recibo.textoPrevia.indexOf('J-12345678') === -1, recibo.textoPrevia.slice(0, 200));
    info('tasa mostrada', recibo.textoTasa);
    await captura(page, 'B6_recibo_sin_empresa_de_ejemplo');

    return { menu: menu, recibo: recibo };
}

/** Escenario C: aislamiento entre dos cuentas. */
async function escenarioC(contexto, cuentas, page, estado) {
    titulo('C. AISLAMIENTO ENTRE DOS CUENTAS');
    const rutaA = rutaDeEmail(cuentas.A.email);
    const rutaB = rutaDeEmail(cuentas.B.email);

    // C.7 · Cerrar sesión de A e intentar entrar con B.
    // El cierre se hace en la propia página (Firebase Auth + marcas locales) para
    // que sea determinista y no dependa de dónde esté el botón en cada pantalla.
    // IMPORTANTE: la marca del equipo (datosDeCuenta) NO se toca: es justo lo que
    // debe provocar el aviso de "otra cuenta" al entrar B.
    await irA(page, ORIGEN + '/menu.html', 'menu');
    await esperar(1200);
    const cerrado = await page.evaluate(async function () {
        try {
            if (window.firebase && typeof firebase.auth === 'function') {
                await firebase.auth().signOut();
            }
        } catch (e) { /* se sigue con la limpieza local */ }
        try { localStorage.removeItem('sesionActiva'); } catch (e) { /* nada */ }
        // Se limpia SOLO lo que la propia app borra al cerrar sesión. NO se usa
        // sessionStorage.clear(): antes barría también la marca interna de la
        // prueba y provocaba una resiembra de datos sin prefijo a mitad del
        // escenario (era la causa real del fallo de C.8c).
        try { sessionStorage.removeItem('propietarioActual'); } catch (e) { /* nada */ }
        try { sessionStorage.removeItem('currentOwner'); } catch (e) { /* nada */ }
        return 'firebase+local(narrow)';
    });
    nota('cierre de sesión de A: ' + cerrado);
    await esperar(1200);

    // C.7e · ANTES de que entre B: si aquí hay claves de negocio sin prefijo, la
    // fuga vendría de un resto, no de B. Es la comprobación que separa las causas.
    const antesDeB = await page.evaluate(leerClavesFisicas);
    const restosSinPrefijo = Object.keys(antesDeB).filter((k) =>
        k.indexOf(PREFIJO_CUENTA) !== 0 && !esClaveSinPrefijoLegitima(k));
    check('C.7e Antes de entrar B no hay NINGUNA clave de negocio sin prefijo',
        restosSinPrefijo.length === 0,
        restosSinPrefijo.length
            ? 'restos: ' + restosSinPrefijo.map((k) => k + '=' + String(antesDeB[k]).slice(0, 40)).join(' | ')
            : '');
    info('C.7e · cuarentena antes de B',
        Object.keys(antesDeB).filter((k) => k.indexOf(PREFIJO_CUARENTENA) === 0).join(', ') || '(ninguna)');

    const loginB = await iniciarSesion(page, cuentas.B.email, cuentas.B.password);
    const aviso = await page.evaluate(function () {
        const capa = document.getElementById('avisoCuentaAjena');
        return {
            existe: !!capa,
            texto: capa ? capa.innerText.slice(0, 400) : '',
            estilo: capa ? (capa.getAttribute('style') || '').slice(0, 120) : ''
        };
    });
    if (!aviso.existe) await capturarPuertaDeSesion(page, 'C.7 B no recibió el aviso de cuenta ajena');
    check('C.7a Aparece el aviso a pantalla completa de "otra cuenta" (fase 1)', aviso.existe,
        'login B: ' + JSON.stringify(loginB) + ' · texto: ' + aviso.texto.slice(0, 120));
    check('C.7b El aviso es a pantalla completa (position:fixed e inset 0)',
        aviso.existe && /position:\s*fixed/.test(aviso.estilo) && /top:\s*0/.test(aviso.estilo),
        aviso.estilo);
    check('C.7c El aviso menciona que los datos son de otra cuenta',
        /otra cuenta/i.test(aviso.texto), aviso.texto.slice(0, 200));
    await captura(page, 'C7_aviso_cuenta_ajena');

    // A. sigue intacto en disco aunque B haya intentado entrar.
    const fisicasTrasB = await page.evaluate(leerClavesFisicas);
    const claveA = PREFIJO_CUENTA + rutaA + ':ciervo_inventory';
    check('C.7d El inventario de A sigue intacto tras el intento de B',
        fisicasTrasB[claveA] === SEMILLA.ciervo_inventory,
        'valor actual: ' + String(fisicasTrasB[claveA]).slice(0, 80));

    // C.8 · Marcador a mano: B debe ver la lista VACÍA y A debe seguir intacto.
    await page.evaluate(function (args) {
        try {
            localStorage.setItem('datosDeCuenta', args.rutaB);
            localStorage.setItem('sesionActiva', JSON.stringify({ email: args.emailB, uid: 'prueba-b', desde: new Date().toISOString() }));
            sessionStorage.setItem('propietarioActual', args.emailB);
        } catch (e) { /* nada */ }
    }, { rutaB: rutaB, emailB: cuentas.B.email });

    await irA(page, ORIGEN + '/inventario.html', 'inventario');
    await asentar(page, 3000, '#inventoryTableBody');
    await diagnosticarSiRedirigio(page, 'inventario.html', 'C.8 inventario con B');
    const vistoPorB = await page.evaluate(function () {
        const cuerpo = document.getElementById('inventoryTableBody');
        return {
            url: location.href,
            filas: cuerpo ? cuerpo.querySelectorAll('tr').length : -1,
            texto: cuerpo ? cuerpo.innerText.slice(0, 200) : '(sin tabla)',
            estado: window.datosCuenta ? window.datosCuenta.estado() : null
        };
    });
    check('C.8a Con el marcador de B, inventario.html muestra la lista VACÍA',
        vistoPorB.filas === 0 || (vistoPorB.filas === -1 && vistoPorB.url.indexOf('inventario.html') === -1),
        'filas: ' + vistoPorB.filas + ' · ' + vistoPorB.texto.slice(0, 150));
    if (vistoPorB.estado) info('estado() de B', JSON.stringify(vistoPorB.estado));

    const fisicasB = await page.evaluate(leerClavesFisicas);
    check('C.8b cuenta:<A>:ciervo_inventory sigue intacto en disco (aislamiento puro)',
        fisicasB[claveA] === SEMILLA.ciervo_inventory, String(fisicasB[claveA]).slice(0, 80));

    // C.8c · Que B TENGA sus propias claves es justo el aislamiento, así que no se
    // puede exigir que no existan. Se comparan los VALORES y, si hay fuga, se
    // reporta DE DÓNDE salió el valor de B (restos sin prefijo, cuarentena mal
    // puesta o migración de B).
    const claveBinv = PREFIJO_CUENTA + rutaB + ':ciervo_inventory';
    const valorB = Object.prototype.hasOwnProperty.call(fisicasB, claveBinv) ? fisicasB[claveBinv] : null;
    const textoA = String(fisicasB[claveA] || '');
    const nombresDeA = PRODUCTOS_SEMBRADOS.map((p) => p.name);
    const fuga = valorB !== null && nombresDeA.some((n) => String(valorB).indexOf(n) !== -1);
    check('C.8c El inventario de B no contiene los datos de A (compara VALORES)',
        !fuga && (valorB === null || valorB !== textoA),
        'cuenta:<B>:ciervo_inventory = ' + String(valorB).slice(0, 120));

    // Procedencia: todo lo que permite saber por qué vía llegó (si llegó).
    const clavesDeB = Object.keys(fisicasB).filter((k) => k.indexOf(PREFIJO_CUENTA + rutaB + ':') === 0);
    const cuarentenaAhora = Object.keys(fisicasB).filter((k) => k.indexOf(PREFIJO_CUARENTENA) === 0);
    const sinPrefijoAhora = Object.keys(fisicasB).filter((k) =>
        k.indexOf(PREFIJO_CUENTA) !== 0 && !esClaveSinPrefijoLegitima(k));
    info('C.8 · claves propias de B', clavesDeB.join(', ') || '(ninguna)');
    info('C.8 · inventario de B', valorB === null ? '(no existe)' : String(valorB).slice(0, 160));
    info('C.8 · cuarentena en disco',
        cuarentenaAhora.map((k) => k + '=' + String(fisicasB[k]).slice(0, 60)).join(' | ') || '(ninguna)');
    info('C.8 · claves de negocio SIN prefijo que quedan',
        sinPrefijoAhora.map((k) => k + '=' + String(fisicasB[k]).slice(0, 60)).join(' | ') || '(ninguna)');
    if (fuga) {
        nota('PROCEDENCIA DE LA FUGA: B tiene el inventario sembrado.');
        nota('  · claves sin prefijo antes de que B entrara (C.7e): ' + (restosSinPrefijo.length ? restosSinPrefijo.join(', ') : 'ninguna'));
        nota('  · cuarentena en disco: ' + (cuarentenaAhora.join(', ') || 'ninguna'));
        nota('  · claves propias de B: ' + (clavesDeB.join(', ') || 'ninguna'));
        nota('  Si C.7e salió en verde y aun así B lo tiene, la vía es la migración de B');
        nota('  reclamando una clave sin prefijo creada DESPUÉS de C.7e.');
    }
    await captura(page, 'C8_B_ve_lista_vacia');

    // C.8d · Volver al marcador de A: A vuelve a ver SU inventario (el que la
    // app tenga en ese momento; la nube puede haber reemplazado lo sembrado).
    await page.evaluate(function (args) {
        try {
            localStorage.setItem('datosDeCuenta', args.rutaA);
            localStorage.setItem('sesionActiva', JSON.stringify({ email: args.emailA, uid: 'prueba-a', desde: new Date().toISOString() }));
            sessionStorage.setItem('propietarioActual', args.emailA);
        } catch (e) { /* nada */ }
    }, { rutaA: rutaA, emailA: cuentas.A.email });

    const loginA2 = await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    nota('reingreso de A: ' + JSON.stringify(loginA2));
    await irA(page, ORIGEN + '/inventario.html', 'inventario');
    await asentar(page, 3000, '#inventoryTableBody');
    await diagnosticarSiRedirigio(page, 'inventario.html', 'C.8d inventario con A');
    const vistoPorA = await page.evaluate(function () {
        const cuerpo = document.getElementById('inventoryTableBody');
        const filas = cuerpo ? Array.from(cuerpo.querySelectorAll('tr')) : [];
        let esperado = null;
        try { esperado = JSON.parse(localStorage.getItem('ciervo_inventory') || 'null'); } catch (e) { esperado = null; }
        const lista = Array.isArray(esperado) ? esperado : [];
        const info = document.getElementById('pageInfo');
        let declarado = null;
        if (info) {
            const m = /\((\d+)\s+productos?\)/i.exec(info.textContent || '');
            if (m) declarado = Number(m[1]);
        }
        return {
            url: location.href,
            filas: filas.length,
            textos: filas.map((f) => f.textContent.replace(/\s+/g, ' ').trim()),
            pageInfo: info ? info.textContent.trim() : null,
            declarado: declarado,
            enAlmacen: lista.length,
            nombres: lista.map((p) => String((p && (p.name || p.code)) || '')).filter(Boolean)
        };
    });
    const filasEsperadasA = Math.min(10, vistoPorA.enAlmacen);
    check('C.8d Con el marcador de A, A vuelve a ver SU inventario (app y almacén de acuerdo)',
        (vistoPorA.declarado === null ? true : vistoPorA.declarado === vistoPorA.enAlmacen) &&
        vistoPorA.filas === filasEsperadasA,
        'declara: ' + vistoPorA.declarado + ' · en el almacén: ' + vistoPorA.enAlmacen +
        ' · filas: ' + vistoPorA.filas + ' (esperadas ' + filasEsperadasA + ') · ' + vistoPorA.pageInfo);
    info('C.8d · nombres del inventario de A', vistoPorA.nombres.slice(0, 6).join(' | ') || '(vacío)');
    await captura(page, 'C8d_A_recupera_su_inventario');
}

/**
 * Escenario D: guardián de cuota.
 *
 * CORRECCIÓN tras la corrida real: el aviso de poco espacio NO usa
 * navigator.storage.estimate. La cadena real es
 *     avisarSiLleno()  (almacenamiento.js:1012)
 *       -> medirTodo()  (:1718)
 *       -> calcularMedida()  (:1690)
 *       -> limiteLocalMB()   (:1670)  -> nube, o localStorage['limiteLocalMB'],
 *                                        o 1024 MB por defecto
 * `navigator.storage.estimate` solo alimenta estimarCuota() (:327), que NO
 * participa en el aviso. Por eso se eliminó la comprobación que simulaba un
 * 96 % de estimate (no podía disparar nada) y se prueba SOLO la vía real.
 */
async function escenarioD(contexto, cuentas) {
    titulo('D. GUARDIÁN DE CUOTA');

    const page = await contexto.newPage();
    page.setDefaultTimeout(OPCIONES.timeout);
    page.setDefaultNavigationTimeout(OPCIONES.timeout);
    vigilar(page, 'D');

    // D.9a · Iniciar sesión y esperar a que el AISLAMIENTO esté ACTIVO.
    // Si se escribe el límite antes de que la cuenta esté activa, la clave cae
    // sin prefijo y la medición no es la de la cuenta.
    const login = await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    if (!login.ok) {
        check('D.9 · Inicio de sesión para probar el aviso', false, login.motivo + ' (URL: ' + login.url + ')');
        await page.close();
        return;
    }
    const activa = await page.waitForFunction(
        function () { return !!(window.datosCuenta && window.datosCuenta.estado().activa === true); },
        null, { timeout: 20000 }
    ).then(() => true).catch(() => false);
    const estadoTrasLogin = await estadoCuenta(page);
    check('D.9a El aislamiento por cuenta quedó ACTIVO antes de tocar el límite', activa,
        JSON.stringify(estadoTrasLogin));

    // D.9b · Abrir el POS y comprobar que es EL POS (si sesion.js redirige, el
    // aviso nunca podría salir y hay que verlo, no suponerlo).
    await irA(page, ORIGEN + '/mini_market_pos.html', 'POS');
    await asentar(page, 3000);
    await diagnosticarSiRedirigio(page, 'mini_market_pos.html', 'D.9 POS');
    const entorno = await page.evaluate(function () {
        return {
            url: location.href,
            medirTodo: typeof window.medirTodo === 'function',
            medirAlmacenamiento: typeof window.medirAlmacenamiento === 'function',
            avisarSiLleno: typeof window.avisarSiLleno === 'function',
            limiteLocalMB: typeof window.limiteLocalMB === 'function',
            limite: (typeof window.limiteLocalMB === 'function') ? window.limiteLocalMB() : null,
            bytes: (typeof window.medirAlmacenamiento === 'function') ? window.medirAlmacenamiento().totalBytes : null,
            activa: !!(window.datosCuenta && window.datosCuenta.estado().activa)
        };
    });
    info('D.9 · POS y funciones de almacenamiento', JSON.stringify(entorno));
    check('D.9b El POS abre con sesión y con avisarSiLleno/medirTodo disponibles',
        entorno.url.indexOf('mini_market_pos.html') !== -1 && entorno.avisarSiLleno && entorno.medirTodo,
        JSON.stringify(entorno));

    // D.9c · Guardar el límite anterior (la cuenta A es REAL: hay que devolverlo
    // tal cual) y calcular uno pequeño a partir de lo que la app MIDE de verdad,
    // para que el porcentaje supere el 95 % sea cual sea el tamaño de los datos.
    const antes = await page.evaluate(function () {
        return {
            previo: localStorage.getItem('limiteLocalMB'),
            bytes: (typeof window.medirAlmacenamiento === 'function') ? window.medirAlmacenamiento().totalBytes : 0
        };
    });
    const objetivoMB = Math.max(0.00005, ((Number(antes.bytes) || 0) / 0.97) / 1048576);
    await page.evaluate(function (mb) {
        try { localStorage.setItem('limiteLocalMB', String(mb)); } catch (e) { /* nada */ }
    }, objetivoMB);
    const escrito = await page.evaluate(function () {
        return {
            leido: localStorage.getItem('limiteLocalMB'),
            efectivo: (typeof window.limiteLocalMB === 'function') ? window.limiteLocalMB() : null,
            estado: window.datosCuenta ? window.datosCuenta.estado() : null,
            bytes: (typeof window.medirAlmacenamiento === 'function') ? window.medirAlmacenamiento().totalBytes : null
        };
    });
    info('D.9 · límite local escrito', String(objetivoMB) + ' MB · releído: ' + escrito.leido +
        ' · efectivo: ' + JSON.stringify(escrito.efectivo) + ' · bytes medidos: ' + escrito.bytes);
    check('D.9c El límite local quedó escrito y la app lo lee', escrito.leido !== null,
        'releído: ' + escrito.leido + ' · efectivo: ' + JSON.stringify(escrito.efectivo));
    if (escrito.efectivo && escrito.efectivo.origen === 'consola') {
        nota('OJO: limiteLocalMB() está devolviendo el valor de la NUBE (origen "consola");');
        nota('el valor local solo se usará si la nube no ha respondido todavía al medir.');
    }

    // D.9d · Recargar el POS (la vía real: avisarSiLleno() se llama al cargar) y
    // comprobar el aviso. Se lee pronto y se restaura el límite enseguida.
    await page.reload({ waitUntil: OPCIONES.waitUntil, timeout: OPCIONES.timeout });
    await page.waitForSelector('#avisoAlmacenamiento', { timeout: 9000 }).catch(() => { /* puede no salir */ });
    const tras = await page.evaluate(function () {
        const aviso = document.getElementById('avisoAlmacenamiento');
        const medida = (typeof window.medirTodo === 'function') ? window.medirTodo() : null;
        return {
            url: location.href,
            hayAviso: !!aviso,
            textoAviso: aviso ? aviso.innerText : '',
            medida: medida,
            efectivo: (typeof window.limiteLocalMB === 'function') ? window.limiteLocalMB() : null,
            activa: !!(window.datosCuenta && window.datosCuenta.estado().activa)
        };
    });
    info('D.9 · tras recargar el POS',
        'medida=' + JSON.stringify(tras.medida) + ' · límite=' + JSON.stringify(tras.efectivo) +
        ' · activa=' + tras.activa + ' · aviso=' + (tras.hayAviso ? 'sí' : 'no'));
    const avisoOk = tras.hayAviso && tras.textoAviso.toLowerCase().indexOf(TEXTO_AVISO_POCO_ESPACIO.toLowerCase()) !== -1;
    check('D.9d Con el límite local por encima del 95 % sale el aviso llano de poco espacio', avisoOk,
        'aviso: "' + tras.textoAviso.replace(/\s+/g, ' ').slice(0, 160) + '" · porcentaje=' +
        (tras.medida ? tras.medida.porcentaje : 'n/d'));
    check('D.9e El aviso no usa tecnicismos (habla de copia de seguridad)',
        /copia de seguridad/i.test(tras.textoAviso),
        tras.textoAviso.replace(/\s+/g, ' ').slice(0, 160));
    await captura(page, 'D9_aviso_poco_espacio_limite_local');

    // D.9f · Discriminante: si al recargar no salió, se llama a la función a mano.
    // Si así SÍ sale, el guardián funciona y lo que falla es el cableado de la
    // página; si tampoco sale, el problema está en el propio guardián.
    if (!avisoOk) {
        const manual = await page.evaluate(async function () {
            try {
                if (typeof window.avisarSiLleno !== 'function') return { ok: false, motivo: 'no existe avisarSiLleno' };
                const r = await window.avisarSiLleno();
                const aviso = document.getElementById('avisoAlmacenamiento');
                return {
                    ok: true,
                    resultado: r,
                    hayAviso: !!aviso,
                    textoAviso: aviso ? aviso.innerText : '',
                    medida: (typeof window.medirTodo === 'function') ? window.medirTodo() : null
                };
            } catch (e) { return { ok: false, motivo: String(e && e.message || e) }; }
        });
        info('D.9 · llamada manual a avisarSiLleno()', JSON.stringify(manual));
        check('D.9f Llamando a avisarSiLleno() a mano SÍ sale el aviso (el guardián funciona)',
            manual.ok && manual.hayAviso &&
            manual.textoAviso.toLowerCase().indexOf(TEXTO_AVISO_POCO_ESPACIO.toLowerCase()) !== -1,
            JSON.stringify(manual).slice(0, 220));
        if (manual.ok && manual.hayAviso) {
            nota('CONCLUSIÓN: el guardián funciona; lo que no dispara el aviso en la carga');
            nota('es el cableado de la página que lo llama. Revisar esa llamada.');
        }
        await diagnosticoDePagina(page, 'D.9 el aviso no salio al recargar el POS');
    }

    // Restaurar el límite que tenía la cuenta antes de la prueba.
    await page.evaluate(function (previo) {
        try {
            if (previo === null || typeof previo === 'undefined') localStorage.removeItem('limiteLocalMB');
            else localStorage.setItem('limiteLocalMB', previo);
        } catch (e) { /* nada */ }
    }, antes.previo);
    info('D.9 · límite restaurado a', String(antes.previo));

    await page.close();
}

/** Escenario E: restaurar un respaldo no retrocede el contador. */
async function escenarioE(contexto, cuentas) {
    titulo('E. RESTAURAR UN RESPALDO NO RETROCEDE EL CONTADOR');

    const page = await contexto.newPage();
    page.setDefaultTimeout(OPCIONES.timeout);
    page.setDefaultNavigationTimeout(OPCIONES.timeout);
    page.on('dialog', (d) => d.accept().catch(() => { /* nada */ }));
    vigilar(page, 'E');

    await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    await irA(page, ORIGEN + '/config.html', 'config');
    await asentar(page, 3000, '#almBtnAvanzado');
    await diagnosticarSiRedirigio(page, 'config.html', 'E.10 config');

    const antes = await page.evaluate(function () {
        return {
            url: location.href,
            contador: (function () { try { return localStorage.getItem('pos_last_sale_number'); } catch (e) { return null; } })()
        };
    });
    info('contador de A antes de restaurar', antes.contador);

    if (antes.url.indexOf('config.html') === -1) {
        check('E.10a config.html abre con la sesión de A', false, 'URL final: ' + antes.url);
        await captura(page, 'E10_config_no_abrio');
        await page.close();
        return;
    }
    check('E.10a config.html abre con la sesión de A', true, antes.url);

    const contadorAntes = parseInt(String(antes.contador), 10);
    const contadorRespaldo = isFinite(contadorAntes) && contadorAntes > 1 ? 1 : 0;

    // Respaldo JSON válido con un contador MENOR.
    const respaldo = {
        app: 'Ciervo Mini Market',
        version: 1,
        generado: new Date().toISOString(),
        origen: ORIGEN,
        datos: {
            ciervo_inventory: JSON.stringify([{ id: 99, code: 'RESP-001', name: 'Producto del respaldo', stock: 1, cost: 1, price: 2 }]),
            ciervo_categories: SEMILLA.ciervo_categories,
            pos_last_sale_number: String(contadorRespaldo)
        }
    };
    const archivo = path.join(os.tmpdir(), 'respaldo-prueba-navegador.json');
    fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2), 'utf8');
    nota('respaldo de prueba: ' + archivo + ' (contador ' + contadorRespaldo + ' < ' + contadorAntes + ')');

    // Abrir el panel "Avanzado" y cargar el archivo, como haría el usuario.
    await page.click('#almBtnAvanzado').catch(() => { /* puede estar ya abierto */ });
    await esperar(500);
    await page.setInputFiles('#almArchivoRespaldo', {
        name: 'respaldo-prueba-navegador.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(respaldo, null, 2), 'utf8')
    });

    await esperar(3500);
    const despues = await page.evaluate(function () {
        const aviso = document.getElementById('avisoAlmacenamiento');
        return {
            contador: (function () { try { return localStorage.getItem('pos_last_sale_number'); } catch (e) { return null; } })(),
            aviso: aviso ? aviso.innerText : '',
            estadoPanel: (function () {
                const el = document.getElementById('almEstado');
                return el ? el.innerText : '';
            })()
        };
    });
    info('contador después de restaurar', despues.contador);
    info('aviso mostrado', despues.aviso.replace(/\s+/g, ' ').slice(0, 200));

    const contadorDespues = parseInt(String(despues.contador), 10);
    check('E.10b El contador NO retrocede al restaurar un respaldo con número menor',
        isFinite(contadorDespues) && contadorDespues === contadorAntes,
        'antes: ' + contadorAntes + ' · después: ' + contadorDespues);
    const textoAviso = (despues.aviso + ' ' + despues.estadoPanel).toLowerCase();
    check('E.10c El aviso menciona que se conservó el contador más alto',
        textoAviso.indexOf(TEXTO_CONTADOR_PROTEGIDO.toLowerCase()) !== -1,
        '"' + (despues.aviso + ' | ' + despues.estadoPanel).replace(/\s+/g, ' ').slice(0, 200) + '"');
    await captura(page, 'E10_contador_no_retrocede');

    // Se deja el inventario de A como estaba antes del respaldo.
    await page.evaluate(function (valor) {
        try { localStorage.setItem('ciervo_inventory', valor); } catch (e) { /* nada */ }
    }, SEMILLA.ciervo_inventory);

    await page.close();
}

/* =====================================================================
   G. CATÁLOGO Y CALCULADORA (bloques del 21/09/2026)
   ---------------------------------------------------------------------
   Por qué existe este escenario: ni catalogo.html ni calcular_precio_ven.html
   se abrían en NINGUNA parte de la suite. Los dos cambios de esa fecha se
   desplegaban, por tanto, sin una sola comprobación en navegador real.

   El catálogo SOLO subía: hacía un .set() de todo el nodo `productos` con su
   copia local dentro, así que una copia vieja (con el stock de hace días)
   pisaba el stock real de la nube. Ahora descarga, fusiona por id y escribe
   SOLO los campos del catálogo con update().

   OJO al leer esto: `products` se declara con `let` en catalogo.html, así que
   NO está en window. Por eso lo que se comprueba contra el almacén es lo
   PINTADO (las filas), no una variable global que no existe. Y por eso la
   fusión se prueba llamando a la función con datos de juguete, que es
   determinista y no depende de si la cuenta tiene nube o no.
   ===================================================================== */
async function escenarioG(contexto, cuentas) {
    titulo('G. CATÁLOGO Y CALCULADORA');

    const page = await contexto.newPage();
    page.setDefaultTimeout(OPCIONES.timeout);
    page.setDefaultNavigationTimeout(OPCIONES.timeout);
    const reg = vigilar(page, 'G');

    const login = await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    if (!login.ok) {
        check('G.12 · Inicio de sesión para probar el catálogo', false, login.motivo + ' (URL: ' + login.url + ')');
        await page.close();
        return;
    }
    await page.waitForFunction(
        function () { return !!(window.datosCuenta && window.datosCuenta.estado().activa === true); },
        null, { timeout: 20000 }
    ).catch(function () { /* el escenario lo reportará */ });

    /* --- G.12 · catalogo.html abre, pinta y no rompe ------------------- */
    let erroresAntes = reg.pageerrors.length;
    await irA(page, ORIGEN + '/catalogo.html', 'catalogo');
    await asentar(page, 3000, '#catalogTableBody');
    await diagnosticarSiRedirigio(page, 'catalogo.html', 'G.12 catalogo');

    const cat = await page.evaluate(function () {
        let enAlmacen = null;
        try {
            const bruto = localStorage.getItem('ciervo_inventory');
            enAlmacen = bruto ? JSON.parse(bruto) : null;
        } catch (e) { enAlmacen = 'error'; }
        return {
            url: location.href,
            titulo: document.title,
            almacen: Array.isArray(enAlmacen) ? enAlmacen.length : enAlmacen,
            filas: document.querySelectorAll('#catalogTableBody tr').length,
            tarjetas: document.querySelectorAll('#gridView .product-card').length,
            fusion: typeof window.fusionarCatalogoConNube === 'function',
            descarga: typeof window.sincronizarCatalogoConNube === 'function',
            guardado: typeof window.firebaseSaveProducts === 'function',
            guardian: typeof window.guardarLocalSeguro === 'function',
            aviso: typeof window.avisarSiLleno === 'function'
        };
    });
    info('G.12 · catalogo.html', JSON.stringify(cat));
    const nuevosCat = reg.pageerrors.slice(erroresAntes);

    check('G.12a catalogo.html abre con sesión (no rebota al login)',
        cat.url.indexOf('catalogo.html') !== -1, cat.url);
    check('G.12b Es el catálogo de verdad (título propio)', /cat[aá]logo/i.test(cat.titulo), cat.titulo);
    check('G.12c El catálogo pinta lo mismo que hay en el almacén (app y almacén de acuerdo)',
        typeof cat.almacen === 'number' && cat.filas === cat.almacen && cat.tarjetas === cat.almacen,
        'almacen=' + cat.almacen + ' filas=' + cat.filas + ' tarjetas=' + cat.tarjetas);
    check('G.12d Existen las funciones de la fusión (descarga + fusión + guardado)',
        cat.fusion && cat.descarga && cat.guardado,
        'fusion=' + cat.fusion + ' descarga=' + cat.descarga + ' guardado=' + cat.guardado);
    check('G.12e El catálogo carga el guardián de almacenamiento (almacenamiento.js)',
        cat.guardian && cat.aviso, 'guardarLocalSeguro=' + cat.guardian + ' avisarSiLleno=' + cat.aviso);
    check('G.12f Sin errores de JavaScript al cargar el catálogo',
        nuevosCat.length === 0, nuevosCat.join(' | '));

    /* --- G.13 · La fusión, en el navegador y con la función REAL ------- */
    const fusion = await page.evaluate(function () {
        const nube = [{
            id: 'JUGUETE-1', name: 'De la nube', code: 'N1',
            stock: 3, price: 111, cost: 50,
            images: ['nube.png'], mainImageIndex: 0, imageUrl: 'nube.png',
            description: 'descripcion nube', visible: true, specs: { color: 'azul', peso: '1kg' }
        }];
        const local = [{
            id: 'JUGUETE-1', name: 'Del local', code: 'L1',
            stock: 999, price: 222, cost: 60,
            images: ['local0.png', 'local1.png'], mainImageIndex: 1, imageUrl: 'local0.png',
            description: 'descripcion local', visible: false, specs: { color: 'rojo' }
        }];
        try {
            const r = window.fusionarCatalogoConNube(nube, local);
            const p = (r && r[0]) || {};
            return {
                ok: true, n: r ? r.length : 0,
                stock: p.stock, price: p.price, cost: p.cost,
                images: p.images, description: p.description, visible: p.visible,
                mainImageIndex: p.mainImageIndex, specs: p.specs
            };
        } catch (e) { return { ok: false, error: String(e.message) }; }
    });
    info('G.13 · fusión dentro del navegador', JSON.stringify(fusion));
    check('G.13a La fusión no lanza en el navegador real', fusion.ok === true, JSON.stringify(fusion));
    check('G.13b El stock, el precio y el costo los manda la NUBE (no la copia local vieja)',
        fusion.stock === 3 && fusion.price === 111 && fusion.cost === 50,
        'stock=' + fusion.stock + ' price=' + fusion.price + ' cost=' + fusion.cost);
    check('G.13c Las imágenes, la descripción, la visibilidad y el índice los manda el LOCAL',
        JSON.stringify(fusion.images) === JSON.stringify(['local0.png', 'local1.png']) &&
        fusion.description === 'descripcion local' && fusion.visible === false &&
        fusion.mainImageIndex === 1,
        JSON.stringify({ images: fusion.images, d: fusion.description, v: fusion.visible, i: fusion.mainImageIndex }));
    check('G.13d Los specs se fusionan: local gana y lo que solo está en la nube se conserva',
        !!fusion.specs && fusion.specs.color === 'rojo' && fusion.specs.peso === '1kg',
        JSON.stringify(fusion.specs));

    /* --- G.13e · La descarga al abrir no lanza y no vacía la lista -----
       Se guarda y se devuelve el almacén de A: la cuenta es REAL y la suite
       no debe dejarle el inventario cambiado. */
    const antesInv = await page.evaluate(function () {
        try { return localStorage.getItem('ciervo_inventory'); } catch (e) { return null; }
    });
    const sincro = await page.evaluate(function () {
        return Promise.resolve()
            .then(function () { return window.sincronizarCatalogoConNube(); })
            .then(function (r) {
                return {
                    ok: true,
                    devuelto: r,
                    filasTrasDescarga: document.querySelectorAll('#catalogTableBody tr').length
                };
            })
            .catch(function (e) { return { ok: false, error: String(e.message) }; });
    });
    info('G.13e · sincronizarCatalogoConNube()', JSON.stringify(sincro));
    check('G.13e La descarga al abrir no lanza y devuelve un booleano',
        sincro.ok === true && typeof sincro.devuelto === 'boolean', JSON.stringify(sincro));
    await page.evaluate(function (previo) {
        try {
            if (previo === null) localStorage.removeItem('ciervo_inventory');
            else localStorage.setItem('ciervo_inventory', previo);
        } catch (e) { /* nada */ }
    }, antesInv);

    /* --- G.14 · calcular_precio_ven.html (no se abría en ninguna parte) */
    erroresAntes = reg.pageerrors.length;
    await irA(page, ORIGEN + '/calcular_precio_ven.html', 'calculadora');
    await asentar(page, 3000);
    await diagnosticarSiRedirigio(page, 'calcular_precio_ven.html', 'G.14 calculadora');

    const calc = await page.evaluate(function () {
        return {
            url: location.href,
            titulo: document.title,
            tasas: typeof window.saveRates === 'function',
            tema: typeof window.toggleDarkMode === 'function',
            guardian: typeof window.guardarLocalSeguro === 'function',
            aviso: typeof window.avisarSiLleno === 'function'
        };
    });
    info('G.14 · calcular_precio_ven.html', JSON.stringify(calc));
    const nuevosCalc = reg.pageerrors.slice(erroresAntes);
    check('G.14a calcular_precio_ven.html abre con sesión (no rebota al login)',
        calc.url.indexOf('calcular_precio_ven.html') !== -1, calc.url);
    check('G.14b Es la calculadora de verdad (título propio y sus funciones)',
        /calculadora/i.test(calc.titulo) && calc.tasas && calc.tema, JSON.stringify(calc));
    check('G.14c La calculadora carga el guardián de almacenamiento (almacenamiento.js)',
        calc.guardian && calc.aviso, 'guardarLocalSeguro=' + calc.guardian + ' avisarSiLleno=' + calc.aviso);
    check('G.14d Sin errores de JavaScript al cargar la calculadora',
        nuevosCalc.length === 0, nuevosCalc.join(' | '));

    /* --- G.15 · config_recibo.html: el guardián también tiene que estar  */
    erroresAntes = reg.pageerrors.length;
    await irA(page, ORIGEN + '/config_recibo.html', 'config_recibo guardian');
    await asentar(page, 3000);
    const rec = await page.evaluate(function () {
        return {
            url: location.href,
            guardian: typeof window.guardarLocalSeguro === 'function',
            aviso: typeof window.avisarSiLleno === 'function'
        };
    });
    info('G.15 · config_recibo.html', JSON.stringify(rec));
    const nuevosRec = reg.pageerrors.slice(erroresAntes);
    check('G.15a config_recibo.html carga el guardián de almacenamiento (almacenamiento.js)',
        rec.url.indexOf('config_recibo.html') !== -1 && rec.guardian && rec.aviso, JSON.stringify(rec));
    check('G.15b Sin errores de JavaScript al cargar config_recibo.html',
        nuevosRec.length === 0, nuevosRec.join(' | '));

    await captura(page, 'G_catalogo_calculadora_guardian');
    await page.close();
}

/**
 * Escenario F (opcional, no bloquea).
 * El motor solo se enciende si BBDD/<ruta>/suscripcion/modoSync = true. Activar eso
 * exige escribir en la nube de la cuenta de prueba y, con las reglas estrictas,
 * ademas que ingreso sea true. Se deja detrás de --motor para no tocar nada por
 * sorpresa; si no se pasa, queda SALTADO y dicho.
 */
async function escenarioF(contexto, cuentas) {
    titulo('F. MOTOR DE OPERACIONES (opcional)');
    if (!OPCIONES.motor) {
        saltar('F.11 Cobrar una venta con modoSync:true y verla en ops/venta/',
            'no se pidió --motor: es opcional y escribe en la nube de la cuenta de prueba');
        return;
    }
    const page = await contexto.newPage();
    page.setDefaultTimeout(OPCIONES.timeout);
    page.setDefaultNavigationTimeout(OPCIONES.timeout);
    page.on('dialog', (d) => d.accept().catch(() => { /* nada */ }));
    vigilar(page, 'F');

    await iniciarSesion(page, cuentas.A.email, cuentas.A.password);
    await irA(page, ORIGEN + '/mini_market_pos.html', 'POS');
    await esperar(3000);

    // Se comprueba si el motor quedó activo en la página; si no, se salta con el motivo.
    const motor = await page.evaluate(function () {
        return {
            url: location.href,
            hayMotor: typeof window.motorOperaciones !== 'undefined' || typeof window.encolarOperacion === 'function',
            modo: (function () {
                try { return localStorage.getItem('cloudSyncMode') || '(sin marca)'; } catch (e) { return '(error)'; }
            })()
        };
    });
    if (motor.url.indexOf('mini_market_pos.html') === -1) {
        saltar('F.11 Cobrar una venta con modoSync:true y verla en ops/venta/',
            'el POS redirigió al login: ' + motor.url);
        await page.close();
        return;
    }
    saltar('F.11 Cobrar una venta con modoSync:true y verla en ops/venta/',
        'pendiente: encender modoSync en BBDD/<ruta>/suscripcion (la nube de la cuenta de prueba) y cobrar');
    nota('estado del motor en la página: ' + JSON.stringify(motor));
    await captura(page, 'F11_motor_no_ejecutado');
    await page.close();
}

/* =====================================================================
   10. PREFLIGHT (todo lo que se puede comprobar SIN navegador)
   ===================================================================== */

async function preflight() {
    titulo('PREFLIGHT · comprobaciones sin navegador');

    // 1. Playwright
    const pw = resolverPlaywright();
    if (pw) {
        nota('playwright ' + pw.version + ' en ' + pw.ruta);
    }
    check('Playwright disponible', !!pw, pw ? '' : 'no se encontró el paquete playwright');

    // 2. Navegadores instalados
    const carpetaMs = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
    let navegadores = [];
    try { navegadores = fs.readdirSync(carpetaMs).filter((n) => n.indexOf('chromium') === 0); } catch (e) { /* nada */ }
    check('Navegadores de Playwright instalados', navegadores.length > 0,
        navegadores.length ? navegadores.join(', ') : 'no hay nada en ' + carpetaMs);

    // 3. Se puede LANZAR un navegador aquí
    let navegadorVivo = null;
    if (pw) {
        try {
            navegadorVivo = await abrirNavegador(pw.modulo);
            ESTADO.navegador = navegadorVivo;   // limpieza() lo cierra al final
            const page = await navegadorVivo.newPage();
            vigilar(page, 'preflight');
            await page.setContent('<h1 id="x">hola</h1>');
            const texto = await page.textContent('#x');
            check('Chromium se lanza y renderiza', texto === 'hola', 'texto: ' + texto);
        } catch (e) {
            check('Chromium se lanza y renderiza', false, String(e.message).split('\n')[0]);
            diagnosticarFalloDeNavegador(e);
            navegadorVivo = null;
        }
    }

    // 3b. ¿Puede el NAVEGADOR (no Node) alcanzar los CDN que usa la app?
    //     Si no puede, el login con Firebase es imposible y NO es culpa de la app.
    if (navegadorVivo) {
        // OJO: `navegadorVivo` es un Browser, NO un BrowserContext, así que no tiene
        // `.pages()`. Llamarlo lanzaba "navegadorVivo.pages is not a function" y el
        // preflight moría aquí, justo ANTES de las comprobaciones de las 15 páginas y
        // de los CDN: por eso el preflight solo daba 4 OK en vez de 7.
        // Las páginas se piden a un contexto (y si no hay, se crea una).
        const contextos = navegadorVivo.contexts();
        const page = (contextos.length && contextos[0].pages().length)
            ? contextos[0].pages()[0]
            : await navegadorVivo.newPage();
        vigilar(page, 'cdn');
        await irA(page, 'about:blank', 'cdn');
        const resultados = await page.evaluate(async function (urls) {
            function conLimite(promesa, ms) {
                return Promise.race([
                    promesa,
                    new Promise(function (_, rechazar) {
                        setTimeout(function () { rechazar(new Error('timeout ' + ms + ' ms')); }, ms);
                    })
                ]);
            }
            const salida = [];
            for (let i = 0; i < urls.length; i++) {
                const t0 = Date.now();
                try {
                    // no-cors: basta con saber que la descarga ARRANCA (respuesta opaca).
                    await conLimite(fetch(urls[i], { method: 'HEAD', mode: 'no-cors', cache: 'no-store' }), 12000);
                    salida.push({ url: urls[i], ok: true, ms: Date.now() - t0 });
                } catch (e) {
                    salida.push({ url: urls[i], ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 120) });
                }
            }
            return salida;
        }, CDN_CLAVE);

        const malos = resultados.filter((r) => !r.ok);
        resultados.forEach((r) => {
            nota('CDN ' + (r.ok ? 'OK  ' : 'FALLA') + ' (' + r.ms + ' ms) ' + r.url.slice(0, 90) +
                (r.ok ? '' : ' -> ' + r.error));
        });
        check('El navegador alcanza los CDN que usa la app', malos.length === 0,
            malos.length ? malos.map((m) => m.url.slice(0, 60)).join(', ') : '');

        if (malos.length) {
            console.log('');
            console.log('  ! El NAVEGADOR no alcanza:');
            malos.forEach((m) => console.log('      - ' + m.url + '  (' + m.error + ')'));
            console.log('    Consecuencias: los <script> síncronos del <head> (Firebase) NO');
            console.log('    terminan de bajar, la página no dispara DOMContentLoaded y el login');
            console.log('    con Firebase es IMPOSIBLE. No es un fallo de la aplicación.');
            console.log('    Para comprobar hasta dónde llega la app SIN CDN:');
            console.log('        node pruebas_navegador.js --sin-cdn');
            console.log('    (aborta las rutas externas; el login con Firebase NO funcionará, pero');
            console.log('     verás si el HTML, el sembrado y el aislamiento se comportan bien).');
        }
    }

    // 4. Páginas servidas
    const paginas = ['index.html', 'menu.html', 'inventario.html', 'config.html', 'config_recibo.html',
        'mini_market_pos.html', 'mini_market_pos_resumen.html', 'compras.html', 'catalogo.html',
        'cuentas.html', 'gestion_empresa.html', 'gestion_proveedores.html', 'gestion_usuario.html',
        'listado_clientes.html', 'landing.html'];
    const fallidas = [];
    for (const p of paginas) {
        try {
            const r = await fetch(ORIGEN + '/' + p);
            if (!r.ok) fallidas.push(p + '(' + r.status + ')');
        } catch (e) { fallidas.push(p + '(sin respuesta)'); }
    }
    check('Las 15 páginas se sirven por HTTP 200', fallidas.length === 0, fallidas.join(', '));

    // 5. Firebase Auth REST
    const etiqueta = marca();
    const email = 'prueba.playwright.pre' + etiqueta + '@example.com';
    const password = claveAleatoria();
    let cuenta = null;
    try {
        cuenta = await crearCuentaAuth(email, password);
        check('Firebase Auth REST: crear cuenta de prueba', true, email);
    } catch (e) {
        check('Firebase Auth REST: crear cuenta de prueba', false, e.message);
    }

    // 6. Perfil en RTDB + sonda de reglas (solo lecturas y una escritura del
    //    propio uid, que se intenta borrar después).
    if (cuenta) {
        const lectura = await leerNodo('usuarios/' + cuenta.localId, cuenta.idToken);
        check('RTDB: la cuenta puede leer su propio perfil usuarios/<uid>', lectura.ok,
            'HTTP ' + lectura.status);

        if (OPCIONES.autoaprobar) {
            const ap = await aprobarPerfil(cuenta);
            check('RTDB: se pudo aprobar la cuenta (ingreso:true) por REST', ap.ok, ap.detalle);
            if (ap.ok) {
                const lectura2 = await leerNodo('usuarios/' + cuenta.localId, cuenta.idToken);
                info('perfil tras aprobar', lectura2.cuerpo.slice(0, 200));
                const borrado = await borrarPerfil(cuenta);
                nota('borrado del perfil: ' + borrado.detalle + (borrado.ok ? '' : ' (las reglas no lo permiten)'));
            }
        } else {
            nota('sonda de reglas omitida (usa --autoaprobar para probarla)');
        }

        // Sonda SOLO LECTURA para saber qué juego de reglas está desplegado:
        // reglas-fase1.json deja leer BBDD a cualquiera; reglas-firebase.json
        // exige usuarios/<uid>.ingreso === true (que una cuenta nueva no tiene).
        const sonda = await leerNodo('BBDD/' + rutaDeEmail(email), cuenta.idToken);
        info('sonda de reglas (GET BBDD/<ruta>)', 'HTTP ' + sonda.status + ' ' + sonda.cuerpo.slice(0, 80));
        if (sonda.status === 200) {
            nota('=> parecen desplegadas las reglas PERMISIVAS (reglas-fase1.json).');
        } else {
            nota('=> parecen desplegadas las reglas ESTRICTAS (reglas-firebase.json):');
            nota('   una cuenta nueva NO puede entrar sin que un administrador la apruebe.');
        }

        const borrado = await borrarCuentaAuth(cuenta);
        check('Firebase Auth REST: borrar la cuenta de prueba usada en el preflight', borrado.ok, borrado.detalle);
    }

    // 7. ¿La cuenta PW_EMAIL_A está APROBADA? Es LA puerta que bloquea toda la corrida:
    //    index.html activa y migra antes de comprobar la aprobación, así que sin
    //    usuarios/<uid>.ingreso === true el login se rechaza DESPUÉS de haber migrado,
    //    no se escribe 'sesionActiva' y todas las páginas internas rebotan al login.
    if (OPCIONES.emailA && OPCIONES.passA) {
        try {
            const sesion = await iniciarSesionRest(OPCIONES.emailA, OPCIONES.passA);
            const perfil = await leerNodo('usuarios/' + sesion.localId, sesion.idToken);
            let ingreso = null;
            try { ingreso = JSON.parse(perfil.cuerpo).ingreso; } catch (e) { ingreso = null; }
            check('La cuenta PW_EMAIL_A está APROBADA (usuarios/<uid>.ingreso === true)',
                ingreso === true,
                'ingreso=' + JSON.stringify(ingreso) + ' · HTTP ' + perfil.status + ' · ' +
                String(perfil.cuerpo).replace(/\s+/g, ' ').slice(0, 140));
            if (ingreso !== true) {
                nota('SIN APROBAR: la corrida se parará en A.2 con el motivo exacto de la app.');
                nota('Aprobar la cuenta en la consola de Firebase (usuarios/<uid>/ingreso = true)');
                nota('o usar PW_EMAIL_A/PW_PASS_A de una cuenta ya aprobada.');
            }
        } catch (e) {
            check('La cuenta PW_EMAIL_A puede iniciar sesión en Firebase Auth', false, e.message);
        }
    } else {
        nota('PW_EMAIL_A/PW_PASS_A no definidos: no se puede comprobar la aprobación por adelantado.');
    }

    // 8. Resumen
    titulo('RESUMEN DEL PREFLIGHT');
    console.log('Comprobaciones OK: ' + CONTADOR_OK + '   FALLAS: ' + CONTADOR_FALLA);
}

/* =====================================================================
   11. LIMPIEZA
   ===================================================================== */

async function limpieza() {
    titulo('LIMPIEZA');

    // 1. Nodos creados en la RTDB (best-effort: puede que las reglas no lo permitan).
    for (const nodo of ESTADO.nodosCreados) {
        nota('nodo de prueba pendiente de borrar: ' + nodo + ' (se intentó borrar durante la prueba)');
    }

    // 2. Cuentas de prueba de Firebase Auth.
    for (const cuenta of ESTADO.cuentasCreadas) {
        const res = await borrarCuentaAuth(cuenta);
        if (res.ok) nota('cuenta de prueba borrada: ' + cuenta.email);
        else nota('NO se pudo borrar ' + cuenta.email + ': ' + res.detalle);
    }

    // 3. Navegador.
    if (ESTADO.navegador) {
        try {
            if (ESTADO.navegadorPropio) {
                await ESTADO.navegador.close();
                nota('navegador cerrado');
            } else {
                // connectOverCDP: NO se cierra el Chrome que abrió el usuario.
                nota('navegador adjunto por CDP: se deja abierto (no lo lanzó esta suite)');
            }
        } catch (e) { nota('no se pudo cerrar el navegador: ' + e.message); }
    }

    // 4. Servidor local.
    if (ESTADO.servidorPropio) {
        try {
            ESTADO.servidorPropio.kill();
            nota('servidor local apagado (lo había arrancado esta suite)');
        } catch (e) { nota('no se pudo apagar el servidor local: ' + e.message); }
    } else {
        nota('el servidor local NO lo arrancó esta suite: puede seguir escuchando en ' + ORIGEN);
    }
}

/* =====================================================================
   12. PRINCIPAL
   ===================================================================== */

(async function principal() {
    console.log('======================================================================');
    console.log(' PRUEBAS EN NAVEGADOR REAL · Ciervo Mini Market');
    console.log(' Origen: ' + ORIGEN + '  (servidor local, nunca producción)');
    console.log(' Fecha: ' + new Date().toISOString());
    console.log(' Carga de página: waitUntil=' + OPCIONES.waitUntil + '  timeout=' + OPCIONES.timeout + ' ms' +
        '  esperaDom=' + OPCIONES.timeoutDom + ' ms');
    if (OPCIONES.cdn) console.log(' MODO SIN CDN: las rutas externas se abortan (el login con Firebase NO funcionará)');
    console.log('======================================================================');
    crearCarpetaCapturas();

    let codigoSalida = 0;
    try {
        await asegurarServidor();

        if (OPCIONES.preflight) {
            await preflight();
            codigoSalida = CONTADOR_FALLA ? 1 : 0;
        } else {
            const pw = resolverPlaywright();
            if (!pw) {
                check('Playwright disponible', false, 'no se encontró el paquete playwright');
                await limpieza();
                titulo('RESUMEN');
                console.log('Comprobaciones OK: ' + CONTADOR_OK + '   FALLAS: ' + CONTADOR_FALLA +
                    '   SALTADAS: ' + CONTADOR_SALTADO);
                process.exit(2);
            }
            nota('playwright ' + pw.version + ' en ' + pw.ruta);

            const cuentas = await prepararCuentas();
            if (!cuentas.A || !cuentas.B) {
                await limpieza();
                titulo('RESUMEN');
                console.log('No se pudieron preparar las cuentas de prueba. Comprobaciones OK: ' +
                    CONTADOR_OK + '   FALLAS: ' + CONTADOR_FALLA);
                process.exit(3);
            }

            try {
                ESTADO.navegador = await abrirNavegador(pw.modulo);
            } catch (e) {
                check('Abrir Chromium', false, String(e.message).split('\n')[0]);
                diagnosticarFalloDeNavegador(e);
                await limpieza();
                titulo('RESUMEN');
                console.log('No se pudo abrir el navegador. Comprobaciones OK: ' + CONTADOR_OK +
                    '   FALLAS: ' + CONTADOR_FALLA);
                process.exit(2);
            }
            check('Abrir Chromium', true, ESTADO.navegador.version ? ESTADO.navegador.version() : '');

            // Contexto de trabajo. Si el navegador lo lanzó esta suite, se crea un
            // contexto NUEVO y limpio. Si se está ADJUNTO a un Chrome del usuario
            // (PW_CDP), se reutiliza su contexto y NO se cierran sus pestañas.
            let contexto;
            if (ESTADO.navegadorPropio) {
                contexto = await ESTADO.navegador.newContext({ viewport: { width: 1440, height: 900 } });
            } else {
                const existentes = ESTADO.navegador.contexts();
                contexto = existentes.length ? existentes[0] : await ESTADO.navegador.newContext();
            }

            // MODO SIN CDN: aborta TODA petición externa. Sirve para ver hasta
            // dónde llega la app cuando el navegador no alcanza los CDN, pero hay
            // que tener claro que SIN Firebase el login no puede funcionar.
            if (OPCIONES.cdn) {
                console.log('');
                console.log('*** MODO SIN CDN ACTIVO: se abortan todas las peticiones externas. ***');
                console.log('*** El login con Firebase NO funcionará: los escenarios que lo ***');
                console.log('*** necesitan (A.2 en adelante, B, C, D, E, F) fallarán.       ***');
                await contexto.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (ruta) => ruta.abort());
            }

            const extra = {};
            const resA = await correr('A. Migración de datos en navegador real',
                () => escenarioA(contexto, cuentas, extra));
            const page = resA && resA.page;
            if (page) {
                await correr('B. Datos de muestra fuera', () => escenarioB(page));
                await correr('C. Aislamiento entre dos cuentas', () => escenarioC(contexto, cuentas, page, extra));
                await page.close().catch(() => { /* nada */ });
                await correr('D. Guardián de cuota', () => escenarioD(contexto, cuentas));
                await correr('E. Respaldo y contador', () => escenarioE(contexto, cuentas));
                await correr('G. Catálogo y calculadora', () => escenarioG(contexto, cuentas));
                await correr('F. Motor de operaciones', () => escenarioF(contexto, cuentas));
            } else {
                saltar('B. Datos de muestra fuera', 'sin sesión de A no se pueden abrir las páginas internas');
                saltar('C. Aislamiento entre dos cuentas', 'sin sesión de A no se puede probar el aislamiento');
                saltar('D. Guardián de cuota', 'sin sesión no se puede abrir el POS (sesion.js redirige)');
                saltar('E. Respaldo y contador', 'sin sesión no se puede abrir config.html');
                saltar('G. Catálogo y calculadora', 'sin sesión no se pueden abrir el catálogo ni la calculadora');
                saltar('F. Motor de operaciones', 'sin sesión no se puede cobrar una venta');
            }
            codigoSalida = CONTADOR_FALLA ? 1 : 0;
        }
    } catch (e) {
        console.log('');
        console.log('ERROR INESPERADO: ' + (e && e.stack ? e.stack : e));
        codigoSalida = 1;
    } finally {
        await limpieza();
    }

    titulo('RESUMEN');
    console.log('Comprobaciones OK: ' + CONTADOR_OK);
    console.log('FALLAS:            ' + CONTADOR_FALLA);
    console.log('SALTADAS:          ' + CONTADOR_SALTADO);
    if (CONTADOR_FALLA) {
        console.log('');
        console.log('Comprobaciones que fallaron:');
        RESULTADOS.filter((r) => r.paso === false).forEach((r) => {
            console.log('  - ' + r.nombre + (r.extra ? '  -> ' + r.extra : ''));
        });
    }
    console.log('');
    console.log('Capturas en: ' + CARPETA_CAPTURAS);
    process.exit(codigoSalida);
})();
