/* Aislamiento REAL de los datos locales POR CUENTA (fase 2 de "una cuenta por equipo").
 *
 * EL PROBLEMA (fase 1 -> fase 2)
 *   cuenta_local.js (fase 1) marca el equipo con el `emailPath` del negocio dueño de los
 *   datos locales y BLOQUEA a cualquier otra cuenta. Pero los datos siguen viviendo en
 *   claves compartidas (ciervo_inventory, pos_sales, ciervo_clients, ...): si ese equipo
 *   pasa a manos de otra cuenta (reinicio de fábrica, equipo vendido, soporte, pruebas),
 *   los datos de la primera quedan a la vista de la segunda hasta que alguien los borre.
 *
 * LA SOLUCIÓN (una sola intercepción, no cientos de cambios)
 *   Este archivo intercepta `Storage.prototype` UNA vez y añade el prefijo de la cuenta
 *   activa de forma TRANSPARENTE: cuando el código de la app pide `ciervo_inventory`, el
 *   almacén real usa `cuenta:<emailPath>:ciervo_inventory`. Así ninguna página tiene que
 *   cambiar sus claves: basta con cargar este módulo antes que el resto y activarlo en
 *   cuanto se conoce el correo del negocio (ver mini_market_pos.html).
 *
 *   - Solo se toca `localStorage`. `sessionStorage` y cualquier otro Storage siguen
 *     comportándose EXACTAMENTE igual: las funciones interceptadas solo actúan cuando
 *     `this === localStorage`.
 *   - Las CLAVES DE EQUIPO no se prefijan nunca (son del PC, no de la cuenta):
 *     datosDeCuenta, sesionActiva, rememberedEmail, darkMode y theme. Por eso la sesión
 *     compartida entre pestañas, el último correo del login y el tema siguen funcionando
 *     con cualquier cuenta.
 *   - Todo lo demás se prefija, incluidas las claves de Firebase Auth: como se leen y se
 *     escriben con el mismo prefijo, la persistencia de sesión de Firebase sigue
 *     funcionando, pero queda separada por cuenta.
 *
 * ACTIVACIÓN PEREZOSA
 *   Al cargar, si el equipo ya tiene `datosDeCuenta` (marca de la fase 1), el prefijo se
 *   activa solo para esa cuenta. Si no hay marca, el módulo queda en MODO TRANSPARENTE
 *   (sin prefijo: comportamiento idéntico al de hoy).
 *
 * MIGRACIÓN (una vez por cuenta)
 *   Los equipos que ya tenían datos antes de esta fase los tienen SIN prefijo. En cuanto
 *   la página conoce el correo, llama a `migrarAlaCuenta(emailPath)`: recorre las claves
 *   sin prefijo (nunca las de equipo ni las ya prefijadas), COPIA cada una a su sitio,
 *   VERIFICA que la copia quedó idéntica y solo entonces borra la original. Es
 *   idempotente y deja constancia con `cuenta:<emailPath>:datosCuentaMigrado`.
 *
 * NUNCA LANZA
 *   Todo va en try/catch. Si la intercepción no se puede instalar (por ejemplo, un
 *   `Storage.prototype` no modificable), el módulo se queda en modo transparente
 *   (comportamiento de hoy) y lo deja dicho en `estado().interceptado` y `estado().error`.
 *
 * API (window.datosCuenta)
 *   activarPara(emailPath)      -> activa el prefijo de esa cuenta (true/false)
 *   desactivar()                -> vuelve al modo transparente
 *   activarYMigrar(emailOPath)  -> activa + migra una sola vez; es lo que llama cada
 *                                  página en su arranque. Devuelve el estado o null.
 *   migrarAlaCuenta(emailPath)  -> { ok, migradas, omitidas, error }
 *   estado()                    -> { activa, emailPath, prefijo, clavesDeCuenta,
 *                                    clavesDeEquipo, migrada, interceptado, error }
 *   limpiarCuenta(emailPath)    -> { ok, borradas, error } (solo las claves de esa cuenta)
 *
 * Sin dependencias: no usa Firebase, ni DOM, ni ninguna otra librería.
 */
(function () {
    'use strict';

    /* En un entorno sin navegador no hay nada que interceptar. */
    if (typeof window === 'undefined') return;

    /* Ya cargado: no se instala dos veces (una segunda instalación guardaría como
       "originales" las funciones ya interceptadas y el prefijo se aplicaría dos veces). */
    try {
        if (window.datosCuenta && typeof window.datosCuenta.activarPara === 'function') return;
    } catch (e) { /* si no se puede comprobar, se sigue adelante */ }

    /* ============================ constantes ============================ */

    /* Marca del equipo (fase 1): a qué cuenta pertenecen los datos locales. */
    var CLAVE_MARCADOR = 'datosDeCuenta';

    /* Claves de EQUIPO: se guardan sin prefijo y se ven igual con cualquier cuenta.
       'datosDeCuenta' y 'sesionActiva' son de la fase 1 (dueño del equipo y sesión
       compartida entre pestañas); 'rememberedEmail' es el último correo del login;
       'darkMode' y 'theme' son la apariencia del PC, no del negocio. */
    var CLAVES_DE_EQUIPO = ['datosDeCuenta', 'sesionActiva', 'rememberedEmail', 'darkMode', 'theme'];

    /* Prefijo físico de las claves de cada cuenta: cuenta:<emailPath>:<clave>. */
    var PREFIJO_CUENTA = 'cuenta:';
    var SEPARADOR = ':';

    /* Marca (dentro de la cuenta) de que la migración ya se hizo: así la página no la
       repite en cada carga. Va prefijada, es decir, es propia de cada cuenta. */
    var CLAVE_MIGRACION = 'datosCuentaMigrado';

    /* ============================ estado del módulo ============================ */

    var interceptado = false;     // ¿se pudieron sustituir las funciones de Storage?
    var activa = false;           // ¿hay una cuenta activa (prefijo en uso)?
    var emailActivo = '';         // emailPath de la cuenta activa
    var prefijoActivo = '';       // 'cuenta:<emailPath>:'
    var ultimoError = '';         // motivo por el que no se pudo interceptar

    /* Funciones ORIGINALES de Storage.prototype. La migración y la limpieza usan SIEMPRE
       estas, nunca las interceptadas: así trabajan sobre el almacén FÍSICO real. */
    var originales = {
        getItem: null,
        setItem: null,
        removeItem: null,
        key: null,
        length: null
    };

    /* ============================ utilidades ============================ */

    function mensajeDe(e) {
        try {
            if (!e) return 'error desconocido';
            if (typeof e === 'string') return e;
            return e.message || e.name || String(e);
        } catch (e2) {
            return 'error desconocido';
        }
    }

    /* ¿Es una clave de equipo (nunca se prefija)? */
    function esClaveDeEquipo(clave) {
        try {
            var nombre = String(clave == null ? '' : clave);
            for (var i = 0; i < CLAVES_DE_EQUIPO.length; i++) {
                if (CLAVES_DE_EQUIPO[i] === nombre) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /* Normaliza lo que llegue a un emailPath: 'Juan@X.com' -> 'juan_at_x_com'. Si ya viene
       normalizado (o con el prefijo delante), se respeta tal cual. */
    function normalizarRuta(valor) {
        try {
            var base = String(valor == null ? '' : valor).trim().toLowerCase();
            if (!base) return '';

            if (base.indexOf(PREFIJO_CUENTA) === 0) {
                base = base.slice(PREFIJO_CUENTA.length);
                if (base.charAt(base.length - 1) === SEPARADOR) base = base.slice(0, -1);
            }

            if (base.indexOf('@') !== -1 || base.indexOf('.') !== -1) {
                try {
                    if (typeof window.sanitizeEmailForDb === 'function') {
                        var porApp = window.sanitizeEmailForDb(base);
                        if (porApp) return String(porApp);
                    }
                } catch (e) { /* se sigue con la normalización propia */ }
                return base.replace('@', '_at_').replace(/\./g, '_');
            }

            return base;
        } catch (e) {
            return '';
        }
    }

    /* ¿La llamada viene del localStorage de ESTA página y hay cuenta activa? Solo entonces
       se aplica el prefijo; sessionStorage y el resto de Storage quedan intactos. */
    function esAlmacenDeLaCuenta(almacen) {
        if (!activa || !prefijoActivo) return false;
        try {
            return almacen === window.localStorage;
        } catch (e) {
            return false;
        }
    }

    /* Nombre FÍSICO que le corresponde a una clave lógica. */
    function fisicaDe(clave) {
        var nombre = String(clave == null ? '' : clave);
        /* Las claves de equipo se guardan tal cual: son del equipo, no de la cuenta. */
        if (esClaveDeEquipo(nombre)) return nombre;
        /* Ya viene prefijada (por ejemplo al recorrer las claves físicas): no se duplica. */
        if (nombre.indexOf(PREFIJO_CUENTA) === 0) return nombre;
        return prefijoActivo + nombre;
    }

    /* Claves que la cuenta activa debe VER: las suyas (sin el prefijo) más las de equipo.
       Se calcula sobre el almacén físico con las funciones originales. */
    function clavesVisibles(almacen) {
        var visibles = [];
        try {
            var deEquipo = [];
            var deCuenta = [];
            var total = originales.length.call(almacen);
            for (var i = 0; i < total; i++) {
                var fisica = originales.key.call(almacen, i);
                if (fisica === null || typeof fisica === 'undefined') continue;
                var nombre = String(fisica);
                if (esClaveDeEquipo(nombre)) { deEquipo.push(nombre); continue; }
                if (prefijoActivo && nombre.indexOf(prefijoActivo) === 0) {
                    var logica = nombre.slice(prefijoActivo.length);
                    /* Una clave de equipo prefijada (estado improbable) no se expone: la
                       clave de equipo física manda, igual que en getItem. */
                    if (esClaveDeEquipo(logica)) continue;
                    deCuenta.push(logica);
                }
            }
            return deEquipo.concat(deCuenta);
        } catch (e) {
            return visibles;
        }
    }

    /* ============================ intercepción ============================ */

    function instalarIntercepcion() {
        try {
            var prototipo = null;
            try {
                if (typeof window.Storage === 'function' && window.Storage.prototype) {
                    prototipo = window.Storage.prototype;
                }
            } catch (e) { prototipo = null; }
            if (!prototipo) throw new Error('Storage.prototype no está disponible');

            var leer = prototipo.getItem;
            var escribir = prototipo.setItem;
            var borrar = prototipo.removeItem;
            var clave = prototipo.key;
            var descriptorLargo = Object.getOwnPropertyDescriptor(prototipo, 'length');
            if (typeof leer !== 'function' || typeof escribir !== 'function' ||
                typeof borrar !== 'function' || typeof clave !== 'function' ||
                !descriptorLargo || typeof descriptorLargo.get !== 'function') {
                throw new Error('Storage.prototype no tiene la forma esperada');
            }

            originales.getItem = leer;
            originales.setItem = escribir;
            originales.removeItem = borrar;
            originales.key = clave;
            originales.length = descriptorLargo.get;

            prototipo.getItem = function (nombre) {
                if (!esAlmacenDeLaCuenta(this)) return originales.getItem.call(this, nombre);
                return originales.getItem.call(this, fisicaDe(nombre));
            };

            prototipo.setItem = function (nombre, valor) {
                if (!esAlmacenDeLaCuenta(this)) return originales.setItem.call(this, nombre, valor);
                return originales.setItem.call(this, fisicaDe(nombre), valor);
            };

            prototipo.removeItem = function (nombre) {
                if (!esAlmacenDeLaCuenta(this)) return originales.removeItem.call(this, nombre);
                return originales.removeItem.call(this, fisicaDe(nombre));
            };

            prototipo.key = function (indice) {
                if (!esAlmacenDeLaCuenta(this)) return originales.key.call(this, indice);
                var visibles = clavesVisibles(this);
                var i = Number(indice);
                if (!isFinite(i) || i < 0 || i >= visibles.length) return null;
                return visibles[i];
            };

            Object.defineProperty(prototipo, 'length', {
                configurable: true,
                enumerable: !!descriptorLargo.enumerable,
                get: function () {
                    if (!esAlmacenDeLaCuenta(this)) return originales.length.call(this);
                    return clavesVisibles(this).length;
                }
            });

            interceptado = true;
        } catch (e) {
            /* Sin intercepción no hay aislamiento: modo transparente, como hoy. */
            interceptado = false;
            activa = false;
            emailActivo = '';
            prefijoActivo = '';
            ultimoError = 'No se pudo interceptar localStorage: ' + mensajeDe(e);
            try { console.warn('[datos-cuenta] ' + ultimoError); } catch (e2) { /* nada */ }
        }
    }

    /* ============================ API pública ============================ */

    /* Activa el prefijo de una cuenta. Devuelve true si quedó activa. */
    function activarPara(emailPath) {
        try {
            var ruta = normalizarRuta(emailPath);
            if (!ruta) return false;
            if (!interceptado) return false;   // sin intercepción no hay prefijo posible
            emailActivo = ruta;
            prefijoActivo = PREFIJO_CUENTA + ruta + SEPARADOR;
            activa = true;
            return true;
        } catch (e) {
            ultimoError = 'No se pudo activar la cuenta: ' + mensajeDe(e);
            activa = false;
            emailActivo = '';
            prefijoActivo = '';
            return false;
        }
    }

    /* Vuelve al modo transparente (sin prefijo, como hoy). */
    function desactivar() {
        try {
            activa = false;
            emailActivo = '';
            prefijoActivo = '';
            return true;
        } catch (e) {
            return false;
        }
    }

    /* Migra los datos que quedaron SIN prefijo a la cuenta indicada.
     *
     * Usa SIEMPRE las funciones originales (trabaja sobre el almacén físico):
     *   1. recorre las claves físicas;
     *   2. descarta las de equipo y las que ya están prefijadas (de cualquier cuenta);
     *   3. copia cada una a cuenta:<emailPath>:<clave>, verificando que la copia quedó
     *      idéntica;
     *   4. solo entonces borra la original.
     *
     * Nunca pisa lo que ya existe en la cuenta: si el destino ya tiene valor, la clave se
     * cuenta como OMITIDA y la original se deja donde está. Así una migración tardía no
     * puede machacar datos más nuevos que la cuenta ya tenía guardados.
     *
     * Es idempotente: ejecutarla dos veces no cambia nada.
     * Devuelve { ok, migradas, omitidas, error }.
     */
    function migrarAlaCuenta(emailPath) {
        var resultado = { ok: false, migradas: 0, omitidas: 0, error: null };
        try {
            if (!interceptado) {
                resultado.error = 'La intercepción de localStorage no está disponible: no se migró nada.';
                return resultado;
            }

            var ruta = normalizarRuta(emailPath);
            if (!ruta) {
                resultado.error = 'Cuenta no válida para migrar.';
                return resultado;
            }

            var almacen = window.localStorage;
            var prefijo = PREFIJO_CUENTA + ruta + SEPARADOR;

            /* Copia de las claves físicas ANTES de tocar nada: el recorrido no se hace
               mientras se borran claves. */
            var fisicas = [];
            var total = originales.length.call(almacen);
            for (var i = 0; i < total; i++) {
                var fisica = originales.key.call(almacen, i);
                if (fisica === null || typeof fisica === 'undefined') continue;
                fisicas.push(String(fisica));
            }

            for (var j = 0; j < fisicas.length; j++) {
                var clave = fisicas[j];

                /* Ya vive bajo una cuenta (esta o cualquier otra): no se toca. */
                if (clave.indexOf(PREFIJO_CUENTA) === 0) { resultado.omitidas++; continue; }
                /* Clave de equipo: nunca se prefija ni se migra. */
                if (esClaveDeEquipo(clave)) { resultado.omitidas++; continue; }

                var valor = originales.getItem.call(almacen, clave);
                if (valor === null) { resultado.omitidas++; continue; }

                var destino = prefijo + clave;
                if (originales.getItem.call(almacen, destino) !== null) {
                    /* El destino ya tiene valor: manda lo que ya estaba en la cuenta. */
                    resultado.omitidas++;
                    continue;
                }

                originales.setItem.call(almacen, destino, valor);

                /* Verificación: sin copia idéntica NO se borra la original. */
                if (originales.getItem.call(almacen, destino) !== valor) {
                    resultado.omitidas++;
                    continue;
                }

                originales.removeItem.call(almacen, clave);
                resultado.migradas++;
            }

            /* Constancia para no repetir la migración en cada carga. */
            try {
                originales.setItem.call(almacen, prefijo + CLAVE_MIGRACION, '1');
            } catch (eMarca) { /* si no se puede marcar, se reintentará la próxima vez */ }

            resultado.ok = true;
            return resultado;
        } catch (e) {
            resultado.ok = false;
            resultado.error = 'No se pudo migrar: ' + mensajeDe(e);
            return resultado;
        }
    }

    /* Borra SOLO las claves de la cuenta indicada (reinicio de fábrica). No toca las claves
       de equipo ni las de otras cuentas. Devuelve { ok, borradas, error }. */
    function limpiarCuenta(emailPath) {
        var resultado = { ok: false, borradas: 0, error: null };
        try {
            if (!interceptado) {
                resultado.error = 'La intercepción de localStorage no está disponible: no se borró nada.';
                return resultado;
            }

            var ruta = normalizarRuta(emailPath);
            if (!ruta) {
                resultado.error = 'Cuenta no válida para limpiar.';
                return resultado;
            }

            var almacen = window.localStorage;
            var prefijo = PREFIJO_CUENTA + ruta + SEPARADOR;

            var fisicas = [];
            var total = originales.length.call(almacen);
            for (var i = 0; i < total; i++) {
                var fisica = originales.key.call(almacen, i);
                if (fisica === null || typeof fisica === 'undefined') continue;
                var nombre = String(fisica);
                if (nombre.indexOf(prefijo) === 0) fisicas.push(nombre);
            }

            for (var j = 0; j < fisicas.length; j++) {
                originales.removeItem.call(almacen, fisicas[j]);
                resultado.borradas++;
            }

            resultado.ok = true;
            return resultado;
        } catch (e) {
            resultado.ok = false;
            resultado.error = 'No se pudo limpiar la cuenta: ' + mensajeDe(e);
            return resultado;
        }
    }

    /* Estado del módulo. `clavesDeCuenta` es cuántas claves tiene guardadas la cuenta
       activa; `clavesDeEquipo` es la lista de claves que NUNCA se prefijan. */
    function estado() {
        var visible = {
            activa: activa,
            emailPath: emailActivo,
            prefijo: prefijoActivo,
            clavesDeCuenta: 0,
            clavesDeEquipo: CLAVES_DE_EQUIPO.slice(),
            migrada: false,
            interceptado: interceptado,
            error: (ultimoError || null)
        };

        try {
            if (!originales.length) return visible;

            var almacen = window.localStorage;
            var total = originales.length.call(almacen);
            var equipoPresentes = 0;
            var conPrefijo = 0;
            var sombreadas = 0;

            for (var i = 0; i < total; i++) {
                var fisica = originales.key.call(almacen, i);
                if (fisica === null || typeof fisica === 'undefined') continue;
                var nombre = String(fisica);
                if (esClaveDeEquipo(nombre)) { equipoPresentes++; continue; }
                if (activa && nombre.indexOf(prefijoActivo) === 0) {
                    conPrefijo++;
                    if (esClaveDeEquipo(nombre.slice(prefijoActivo.length))) sombreadas++;
                }
            }

            visible.clavesDeCuenta = conPrefijo - sombreadas;
            visible.migrada = activa
                ? (originales.getItem.call(almacen, prefijoActivo + CLAVE_MIGRACION) !== null)
                : false;
        } catch (e) { /* se devuelve lo que se tenga */ }

        return visible;
    }

    /* Entrada lista para las páginas: activa la cuenta y, si esa cuenta todavía no ha
       migrado, migra una sola vez. Es lo ÚNICO que necesita llamar cada página en su
       arranque, en cuanto se conoce el correo del negocio.
       Nunca lanza: con un correo vacío o nulo no hace nada y devuelve null; si la
       intercepción no está disponible, tampoco hace nada. Devuelve el estado resultante
       o null si no se pudo activar. */
    function activarYMigrar(emailOPath) {
        try {
            if (!activarPara(emailOPath)) return null;
            if (estado().migrada === false) migrarAlaCuenta(emailActivo);
            return estado();
        } catch (e) {
            ultimoError = 'No se pudo activar/migrar la cuenta: ' + mensajeDe(e);
            return null;
        }
    }

    /* ==================== activación perezosa al cargar ==================== */

    /* Si el equipo ya está marcado (fase 1), se activa el prefijo de esa cuenta. Si no hay
       marca, se queda en modo transparente: comportamiento idéntico al de hoy. */
    function activarPerezoso() {
        try {
            if (!interceptado) return;
            var dueno = originales.getItem.call(window.localStorage, CLAVE_MARCADOR);
            if (!dueno) return;
            activarPara(dueno);
        } catch (e) {
            ultimoError = 'No se pudo activar la cuenta del equipo: ' + mensajeDe(e);
            activa = false;
            emailActivo = '';
            prefijoActivo = '';
        }
    }

    instalarIntercepcion();
    activarPerezoso();

    window.datosCuenta = {
        activarPara: activarPara,
        desactivar: desactivar,
        migrarAlaCuenta: migrarAlaCuenta,
        activarYMigrar: activarYMigrar,
        estado: estado,
        limpiarCuenta: limpiarCuenta
    };
})();
