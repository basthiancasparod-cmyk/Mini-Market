/* Indicador de conexión ÚNICO para todas las páginas.
 *
 * POR QUÉ EXISTE
 * Antes cada página pintaba su propio punto (#firebaseDot) con un SIGNIFICADO
 * distinto. Medidas en el mismo instante y con la misma cuenta (cloudSync=false),
 * salían CUATRO colores a la vez:
 *
 *   - compras.html y gestion_usuario.html: VERDE "Firebase conectado". Miraban
 *     .info/connected, que solo dice que hay socket: con cloudSync=false NO se
 *     sube nada, así que el verde era mentira.
 *   - inventario.html: ÁMBAR "Sin conexión con la nube...". Miraba el permiso.
 *   - mini_market_pos.html: GRIS con el estado del motor.
 *   - listado_clientes, cuentas, gestion_proveedores, gestion_empresa y
 *     mini_market_pos_resumen: GRIS con el texto del HTML ("Estado de conexión",
 *     "Firebase", "Conectando..."), porque su monitor de conexión nunca llegaba a
 *     ejecutarse al cargar (su initFirebase solo se llama desde manejadores).
 *   - catalogo.html, config_recibo.html y menu.html: sin indicador ninguno.
 *
 * QUÉ RESPONDE AHORA
 * Una sola pregunta, la que le importa al negocio: "¿están mis datos a salvo?".
 *
 *   ROJO   "Sin internet: los cambios se guardan en este equipo"
 *   GRIS   "Solo en este equipo (sin nube)"            la cuenta no tiene nube
 *   ÁMBAR  "N cambios sin subir a la nube"             hay nube y hay pendientes
 *   VERDE  "Todo subido a la nube"                     hay nube y nada pendiente
 *   GRIS   "Estado de la nube: sin comprobar"          todavía no se sabe
 *
 * ORDEN DE LAS PREGUNTAS (importante)
 *   1. ¿Hay red? Si no la hay, eso es lo que se dice: es un hecho comprobable y
 *      local, y evita la trampa de confundir "no pude leer la nube" con "este
 *      cliente no tiene nube" (que asustaría a un cliente que sí paga la nube).
 *   2. ¿Tiene nube la cuenta? Si NO, manda eso: a un cliente sin nube no le sirve
 *      que le hablemos de la nube, y "sin nube" es una propiedad de la CUENTA,
 *      no de la red.
 *   3. Con nube: ¿cuántos módulos tienen cambios sin confirmar?
 *
 * DE DÓNDE SACA CADA COSA
 *   - Nube: usa `checkCloudAccess()` de la propia página si existe (cada página
 *     ya la tiene y ya la cachea). Si no existe, lee `suscripcion/cloudSync` del
 *     RTDB SOLO si la app de Firebase YA está inicializada. Este módulo NUNCA
 *     inicializa Firebase a propósito: no queremos que una página que hoy no toca
 *     la nube empiece a conectarse solo por pintar un punto.
 *   - Red: `navigator.onLine` más los eventos online/offline.
 *   - Pendientes: `pendientesSync()` de sincronizacion.js.
 *
 * CÓMO SE INSTALA
 * Es la ÚNICA autoridad: al cargarse sustituye `window.setFirebaseDot`, de modo
 * que todas las llamadas que ya hacían las páginas pasan a significar "recalcula
 * y pinta". No hace falta tocar ni una sola llamada de las páginas, y ninguna
 * página puede volver a pintar un color que no sea el de este módulo.
 *
 * CONTEXTO EXTRA
 * Una página puede aportar información adicional (por ejemplo el POS, con el
 * estado del motor) con `window.conexion.detalle(fn)`: ese texto se AÑADE al
 * título canónico, nunca lo sustituye.
 */
(function () {
    'use strict';

    var CLAVE_PUNTO = 'firebaseDot';
    var INTERVALO_MS = 5000;
    var CADUCIDAD_NUBE_MS = 30000;

    var COLORES = {
        'sin-red': '#ef4444',
        'sin-nube': '#94a3b8',
        'pendientes': '#f59e0b',
        'al-dia': '#22c55e',
        'sin-comprobar': '#6b7280'
    };

    var _nube = null;          // true | false | null (sin comprobar)
    var _cuandoNube = 0;
    var _ultimaFirma = null;
    var _preguntandoNube = null;

    function leerMarcaDeSesion() {
        try {
            var bruto = localStorage.getItem('sesionActiva');
            return bruto ? JSON.parse(bruto) : null;
        } catch (e) { return null; }
    }

    /** Misma normalización que datos_cuenta.js / las páginas. */
    function rutaDeEmail(email) {
        return String(email || '').trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');
    }

    function hayRed() {
        try { return !(typeof navigator !== 'undefined' && navigator.onLine === false); }
        catch (e) { return true; }
    }

    function cuantosPendientes() {
        try {
            if (typeof window.pendientesSync !== 'function') return 0;
            var lista = window.pendientesSync();
            return Array.isArray(lista) ? lista.length : 0;
        } catch (e) { return 0; }
    }

    function textoDetalle() {
        try {
            if (typeof window.conexionDetalle === 'function') {
                var t = String(window.conexionDetalle() || '');
                return t ? ' · ' + t : '';
            }
        } catch (e) { /* un detalle roto nunca debe romper el punto */ }
        return '';
    }

    /**
     * ¿Tiene nube esta cuenta? true | false | null (no se pudo saber).
     *
     * OJO — TRAMPA COMPROBADA (por eso existe la espera a sesionLista):
     * no se puede preguntar por la nube antes de que la sesión esté lista. Varias
     * páginas (cuentas, listado_clientes, compras, mini_market_pos_resumen y
     * gestion_empresa) tienen getCurrentUserEmail() leyendo SOLO sessionStorage, y
     * quien escribe ahí es sesion.js, que se carga DESPUÉS que este módulo. Si se
     * pregunta antes, esas páginas caen en
     *     if (!email) { _cloudAccessChecked = true; _cloudAccess = false; return false; }
     * y se quedan con un "false" PEGAJOSO que les impide subir durante TODA la
     * sesión. Con la espera, para cuando se pregunta ya existe
     * sessionStorage.propietarioActual y la respuesta es la de verdad.
     *
     * Si todavía no existe `window.sesionLista` (sesion.js aún no se ha cargado),
     * NO se pregunta nada: se reintenta en el siguiente ciclo.
     */
    async function nubeDeLaCuenta() {
        if (typeof window.sesionLista === 'undefined') return null;
        try {
            var estado = await window.sesionLista;
            if (estado === 'sin-sesion') return null;
        } catch (e) { return null; }

        try {
            if (typeof window.checkCloudAccess === 'function') {
                var r = await window.checkCloudAccess();
                if (typeof r === 'boolean') return r;
            }
        } catch (e) { /* se intenta por la vía directa */ }

        try {
            if (!window.firebase || !firebase.apps || firebase.apps.length === 0) return null;
            var marca = leerMarcaDeSesion();
            var email = marca && marca.email;
            if (!email) return null;
            var snap = await firebase.database()
                .ref('BBDD/' + rutaDeEmail(email) + '/suscripcion/cloudSync').once('value');
            return snap.val() === true;
        } catch (e) { return null; }
    }

    /** El estado canónico, sin pintar. Es lo que se comprueba en las pruebas. */
    function calcular() {
        var detalle = textoDetalle();
        if (!hayRed()) {
            return { clave: 'sin-red', color: COLORES['sin-red'],
                titulo: 'Sin internet: los cambios se guardan en este equipo' + detalle };
        }
        if (_nube === false) {
            return { clave: 'sin-nube', color: COLORES['sin-nube'],
                titulo: 'Solo en este equipo (sin nube): los datos se guardan aquí' + detalle };
        }
        if (_nube === true) {
            var n = cuantosPendientes();
            if (n > 0) {
                return { clave: 'pendientes', color: COLORES.pendientes,
                    titulo: n + (n === 1 ? ' cambio sin subir a la nube' : ' cambios sin subir a la nube') + detalle };
            }
            return { clave: 'al-dia', color: COLORES['al-dia'],
                titulo: 'Todo subido a la nube' + detalle };
        }
        return { clave: 'sin-comprobar', color: COLORES['sin-comprobar'],
            titulo: 'Estado de la nube: sin comprobar' + detalle };
    }

    function pintar(estado) {
        var el = document.getElementById(CLAVE_PUNTO);
        if (!el) return estado;                       // la página no tiene punto
        var firma = estado.color + '|' + estado.titulo;
        if (firma === _ultimaFirma) return estado;    // nada cambió: no se toca el DOM
        _ultimaFirma = firma;
        try { el.style.background = estado.color; el.title = estado.titulo; }
        catch (e) { /* pintar nunca debe romper la página */ }
        return estado;
    }

    /**
     * Recalcula y pinta. Devuelve el estado aplicado.
     * `forzar: true` vuelve a preguntar la nube sin esperar a que caduque.
     *
     * La pregunta por la nube va SERIALIZADA (`_preguntandoNube`): en el arranque se
     * llama a actualizar() varias veces seguidas (al cargar, en DOMContentLoaded y
     * desde la primera llamada heredada a setFirebaseDot) y sin esto se preguntaba
     * dos y tres veces lo mismo. Comprobado en las pruebas (T41).
     */
    async function actualizar(opciones) {
        var op = opciones || {};
        var caducado = (Date.now() - _cuandoNube) > CADUCIDAD_NUBE_MS;
        if (op.forzar || _nube === null || caducado) {
            if (!_preguntandoNube) {
                _preguntandoNube = nubeDeLaCuenta().then(function (r) {
                    _preguntandoNube = null;
                    if (r !== null) { _nube = r; _cuandoNube = Date.now(); }   // un fallo no borra lo sabido
                    else { _cuandoNube = Date.now() - CADUCIDAD_NUBE_MS + 3000; } // reintento en 3 s
                }).catch(function () {
                    _preguntandoNube = null;
                    _cuandoNube = Date.now() - CADUCIDAD_NUBE_MS + 3000;
                });
            }
            await _preguntandoNube;
        }
        return pintar(calcular());
    }

    // ÚNICA autoridad del punto: cualquier llamada heredada significa "recalcula".
    window.setFirebaseDot = function () { actualizar(); };

    window.conexion = {
        actualizar: actualizar,
        estado: calcular,
        colores: COLORES,
        /** La página aporta contexto extra que se AÑADE al título canónico. */
        detalle: function (fn) {
            window.conexionDetalle = (typeof fn === 'function') ? fn : null;
            return actualizar();
        }
    };

    // Se pinta YA algo canónico (nada de dejar el texto del HTML a la vista).
    actualizar();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { actualizar(); });
    }
    window.addEventListener('online', function () { actualizar({ forzar: true }); });
    window.addEventListener('offline', function () { actualizar(); });
    setInterval(function () { actualizar(); }, INTERVALO_MS);
})();
