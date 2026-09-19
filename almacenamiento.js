/**
 * almacenamiento.js — Guardián de almacenamiento local de Ciervo Mini Market.
 *
 * Problema que resuelve: la app guarda todos los datos de negocio en localStorage
 * (~5 MB por navegador). Al llenarse, setItem lanza QuotaExceededError y, como no
 * estaba capturado, una operación podía quedar a medias sin avisar al usuario.
 *
 * Este módulo NO toca la nube ni la sincronización: solo mide, avisa, guarda de
 * forma segura y permite respaldar/restaurar los datos locales.
 *
 * Todo el código está dentro de try/catch: ninguna función lanza hacia fuera.
 * Funciones expuestas en window:
 *   medirAlmacenamiento()            -> tamaño por clave
 *   estimarCuota()                   -> uso/cuota del navegador (promesa)
 *   pedirPersistencia()              -> almacenamiento persistente (promesa)
 *   diagnosticoAlmacenamiento()      -> informe completo
 *   guardarLocalSeguro(clave, valor) -> setItem protegido
 *   descargarRespaldo()              -> exporta JSON
 *   restaurarRespaldo(archivo)       -> importa JSON (promesa)
 *   mostrarAvisoAlmacenamiento(msg, tipo) -> aviso flotante
 *   avisarSiLleno()                  -> aviso automático SOLO al 95 % o más del límite local
 *   estadoAlmacenamientoSimple()     -> estado en lenguaje llano ('ok' | 'casi' | 'lleno')
 *   fechaUltimaCopia()               -> "nunca" / "hoy" / "ayer" / "hace N días" / "DD/MM/AAAA"
 */
(function () {
    'use strict';

    /** Versión del módulo (viaja en el diagnóstico y en los respaldos). */
    var VERSION_MODULO = 1;

    /** Nombre de la aplicación que firma los respaldos. */
    var APP = 'Ciervo Mini Market';

    /** A partir de este porcentaje se avisa al usuario. */
    var UMBRAL_AVISO = 80;

    /** Por encima de este porcentaje el aviso se muestra como error. */
    var UMBRAL_ERROR = 95;

    /**
     * Por debajo de este porcentaje el aviso automático NO dice nada: el cliente
     * no debe ver avisos técnicos en cada carga de la página.
     */
    var UMBRAL_AVISO_LLENO = 95;

    /** Una clave por encima de 100 KB (bytes UTF-16) se considera "clave grande". */
    var UMBRAL_CLAVE_GRANDE = 102400;

    /**
     * Claves de negocio de la app. Son las únicas que se incluyen en el respaldo.
     * Además se incluyen todas las que empiecen por el prefijo `sys_`.
     */
    var CLAVES_NEGOCIO = [
        'ciervo_inventory',
        'ciervo_categories',
        'ciervo_purchases',
        'ciervo_suppliers',
        'ciervo_inventory_history',
        'pos_sales',
        'pos_last_sale_number',
        'pos_held_carts',
        'pos_device_id',
        'pos_exchange_rate',
        'pos_rate_mode',
        'pos_rate_source',
        'pos_rate_history',
        'pos_rate_trend_window',
        'ciervo_clients',
        'ciervo_accounts',
        'companyData',
        'receiptSettings',
        'cta_reminder_days',
        'precio_default_margin',
        'precio_rounding',
        'inv_default_min_stock',
        'pos_apply_iva',
        'pos_default_currency',
        'pos_sale_prefix'
    ];

    /** Prefijo de las claves de configuración del sistema que también se respaldan. */
    var PREFIJO_SYS = 'sys_';

    /**
     * Fragmentos prohibidos: ninguna clave que contenga alguno de ellos entra al
     * respaldo (sesión, credenciales, marcas internas de sincronización, etc.).
     */
    var FRAGMENTOS_PROHIBIDOS = [
        'sesion',
        'auth',
        'token',
        'currentUser',
        'propietario',
        '_pendSync_',
        'cloudSync',
        'users',
        'firebase'
    ];

    /** Última medición de cuota conocida (la llena estimarCuota). */
    var _ultimaCuota = null;

    /* ------------------------------------------------------------------ */
    /* Utilidades internas                                                */
    /* ------------------------------------------------------------------ */

    /** Devuelve el mensaje legible de un error cualquiera. */
    function mensajeDe(e) {
        try {
            if (!e) return 'error desconocido';
            if (typeof e === 'string') return e;
            return e.message || e.name || String(e);
        } catch (e2) {
            return 'error desconocido';
        }
    }

    /** Indica si un error es de cuota llena (QuotaExceededError). */
    function esErrorDeCuota(e) {
        try {
            if (!e) return false;
            var nombre = String(e.name || '');
            var codigo = (typeof e.code !== 'undefined') ? e.code : null;
            var texto = String(e.message || '');
            if (nombre === 'QuotaExceededError' || nombre === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
            if (codigo === 22 || codigo === 1014) return true;
            if (/quota|cuota/i.test(texto)) return true;
            return false;
        } catch (e2) {
            return false;
        }
    }

    /** Lee y parsea una clave sin lanzar nunca. */
    function leerJSON(clave, porDefecto) {
        try {
            var texto = localStorage.getItem(clave);
            if (texto === null || texto === '') return porDefecto;
            var valor = JSON.parse(texto);
            if (valor === null || typeof valor === 'undefined') return porDefecto;
            return valor;
        } catch (e) {
            return porDefecto;
        }
    }

    /** Cantidad de elementos de un arreglo guardado en localStorage (0 si falla). */
    function contarArreglo(clave) {
        try {
            var valor = leerJSON(clave, null);
            if (!valor) return 0;
            if (Object.prototype.toString.call(valor) === '[object Array]') return valor.length;
            if (typeof valor === 'object') return Object.keys(valor).length;
            return 0;
        } catch (e) {
            return 0;
        }
    }

    /** Bytes que ocupa una clave (clave + valor, UTF-16 = 2 bytes por carácter). */
    function bytesDeClave(clave, valor) {
        try {
            var k = (clave === null || typeof clave === 'undefined') ? '' : String(clave);
            var v = (valor === null || typeof valor === 'undefined') ? '' : String(valor);
            return (k.length + v.length) * 2;
        } catch (e) {
            return 0;
        }
    }

    /** Suma los bytes de todas las imágenes base64 (data:image...) de un texto. */
    function bytesDeDataUrls(texto) {
        try {
            var t = String(texto || '');
            var re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
            var total = 0;
            var m = re.exec(t);
            while (m !== null) {
                total += m[0].length * 2;
                m = re.exec(t);
            }
            return total;
        } catch (e) {
            return 0;
        }
    }

    /** ¿La clave es de negocio (lista blanca o prefijo sys_)? */
    function esClaveDeNegocio(clave) {
        try {
            var k = String(clave || '');
            if (!k) return false;
            if (k.indexOf(PREFIJO_SYS) === 0) return true;
            for (var i = 0; i < CLAVES_NEGOCIO.length; i++) {
                if (CLAVES_NEGOCIO[i] === k) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /** ¿La clave está prohibida (sesión, credenciales, sincronización)? */
    function esClaveProhibida(clave) {
        try {
            var k = String(clave || '');
            var kl = k.toLowerCase();
            for (var i = 0; i < FRAGMENTOS_PROHIBIDOS.length; i++) {
                var frag = String(FRAGMENTOS_PROHIBIDOS[i]).toLowerCase();
                if (kl.indexOf(frag) !== -1) return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /** Claves de negocio que existen ahora mismo en localStorage. */
    function clavesDeNegocioPresentes() {
        var lista = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var clave = localStorage.key(i);
                if (clave === null || typeof clave === 'undefined') continue;
                if (!esClaveDeNegocio(clave)) continue;
                if (esClaveProhibida(clave)) continue;
                if (localStorage.getItem(clave) === null) continue;
                lista.push(clave);
            }
            lista.sort();
        } catch (e) {
            /* si algo falla, devolvemos lo que se haya podido leer */
        }
        return lista;
    }

    /** Bytes en texto legible (B / KB / MB). */
    function formatearBytes(bytes) {
        try {
            var b = Number(bytes) || 0;
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
            return (b / 1048576).toFixed(2) + ' MB';
        } catch (e) {
            return '0 B';
        }
    }

    /** Fecha local en formato AAAA-MM-DD (para el nombre del archivo). */
    function fechaParaArchivo() {
        try {
            var d = new Date();
            var mes = String(d.getMonth() + 1);
            var dia = String(d.getDate());
            if (mes.length < 2) mes = '0' + mes;
            if (dia.length < 2) dia = '0' + dia;
            return d.getFullYear() + '-' + mes + '-' + dia;
        } catch (e) {
            return 'sin-fecha';
        }
    }

    /** Objeto navigator.storage, o null si no existe. */
    function obtenerStorageApi() {
        try {
            if (typeof navigator === 'undefined' || !navigator) return null;
            var st = navigator.storage;
            if (!st) return null;
            return st;
        } catch (e) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 1. Medición                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Mide el espacio ocupado por cada clave de localStorage.
     * Los bytes se calculan como (clave.length + valor.length) * 2 (UTF-16).
     * @returns {{totalBytes: number, porClave: Array<{clave: string, bytes: number}>, claves: number}}
     */
    function medirAlmacenamiento() {
        var resultado = { totalBytes: 0, porClave: [], claves: 0 };
        try {
            var total = 0;
            var lista = [];
            if (typeof localStorage === 'undefined' || !localStorage) return resultado;
            for (var i = 0; i < localStorage.length; i++) {
                var clave = localStorage.key(i);
                if (clave === null || typeof clave === 'undefined') continue;
                var valor = localStorage.getItem(clave);
                var bytes = bytesDeClave(clave, valor);
                total += bytes;
                lista.push({ clave: String(clave), bytes: bytes });
            }
            // Orden descendente por tamaño (mayor primero).
            lista.sort(function (a, b) { return b.bytes - a.bytes; });
            resultado.totalBytes = total;
            resultado.porClave = lista;
            resultado.claves = lista.length;
        } catch (e) {
            /* devolvemos lo medido hasta el momento */
        }
        return resultado;
    }

    /* ------------------------------------------------------------------ */
    /* 2. Cuota del navegador                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Consulta navigator.storage.estimate().
     * @returns {Promise<{uso: number, cuota: number, porcentaje: number, soportado: boolean}>}
     */
    function estimarCuota() {
        return new Promise(function (resolve) {
            var vacio = { uso: 0, cuota: 0, porcentaje: 0, soportado: false };
            try {
                var st = obtenerStorageApi();
                if (!st || typeof st.estimate !== 'function') {
                    resolve(vacio);
                    return;
                }
                st.estimate().then(function (est) {
                    try {
                        var uso = Number(est && est.usage) || 0;
                        var cuota = Number(est && est.quota) || 0;
                        var porcentaje = cuota > 0 ? Math.round((uso / cuota) * 1000) / 10 : 0;
                        _ultimaCuota = { uso: uso, cuota: cuota, porcentaje: porcentaje, soportado: true };
                        resolve(_ultimaCuota);
                    } catch (e) {
                        resolve(vacio);
                    }
                }).catch(function () {
                    resolve(vacio);
                });
            } catch (e) {
                resolve(vacio);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 3. Persistencia                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Consulta y, si hace falta, solicita almacenamiento persistente.
     * @returns {Promise<{persistido: boolean, soportado: boolean}>}
     */
    function pedirPersistencia() {
        return new Promise(function (resolve) {
            try {
                var st = obtenerStorageApi();
                if (!st || typeof st.persist !== 'function') {
                    resolve({ persistido: false, soportado: false });
                    return;
                }
                var consulta = (typeof st.persisted === 'function')
                    ? st.persisted()
                    : Promise.resolve(false);
                consulta.then(function (yaPersistido) {
                    if (yaPersistido) {
                        resolve({ persistido: true, soportado: true });
                        return;
                    }
                    st.persist().then(function (ok) {
                        resolve({ persistido: !!ok, soportado: true });
                    }).catch(function () {
                        resolve({ persistido: false, soportado: true });
                    });
                }).catch(function () {
                    resolve({ persistido: false, soportado: true });
                });
            } catch (e) {
                resolve({ persistido: false, soportado: false });
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 4. Diagnóstico                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Cuenta los productos con imágenes base64 y los bytes que ocupan, además
     * del logo de companyData. Las fotos normales son URL, no base64.
     */
    function analizarImagenesIncrustadas() {
        var res = { productosConBase64: 0, bytesBase64: 0, logoTieneBase64: false, logoBytes: 0 };
        try {
            var inventario = leerJSON('ciervo_inventory', []);
            if (Object.prototype.toString.call(inventario) === '[object Array]') {
                for (var i = 0; i < inventario.length; i++) {
                    try {
                        var texto = JSON.stringify(inventario[i]) || '';
                        if (texto.indexOf('data:image') === -1) continue;
                        res.productosConBase64++;
                        res.bytesBase64 += bytesDeDataUrls(texto);
                    } catch (e) {
                        /* un producto corrupto no debe romper la medición */
                    }
                }
            }
            var empresa = '';
            try { empresa = localStorage.getItem('companyData') || ''; } catch (e) { empresa = ''; }
            if (empresa.indexOf('data:image') !== -1) {
                res.logoTieneBase64 = true;
                res.logoBytes = bytesDeDataUrls(empresa);
            }
        } catch (e) {
            /* devolvemos lo calculado */
        }
        return res;
    }

    /**
     * Informe completo del almacenamiento local.
     * Nota: `cuota`, `uso` y `porcentaje` provienen de la última llamada a
     * estimarCuota() (el panel la ejecuta antes); si aún no hay medición, uso
     * es el total local y el porcentaje queda en 0.
     * `claves` es la lista completa de claves medidas (mayor a menor) y
     * `clavesGrandes` es cuántas superan 100 KB.
     * @returns {object}
     */
    function diagnosticoAlmacenamiento() {
        var salida = {
            version: VERSION_MODULO,
            fecha: '',
            totalBytes: 0,
            cuota: 0,
            uso: 0,
            porcentaje: 0,
            claves: [],
            datos: {
                productos: 0,
                categorias: 0,
                ventas: 0,
                ventasBytes: 0,
                compras: 0,
                clientes: 0,
                cuentas: 0,
                proveedores: 0
            },
            imagenesIncrustadas: {
                productosConBase64: 0,
                bytesBase64: 0,
                logoTieneBase64: false,
                logoBytes: 0
            },
            clavesGrandes: 0
        };
        try {
            salida.fecha = new Date().toISOString();

            var medida = medirAlmacenamiento();
            salida.totalBytes = medida.totalBytes;
            salida.claves = medida.porClave;

            var grandes = 0;
            for (var i = 0; i < medida.porClave.length; i++) {
                if (medida.porClave[i].bytes > UMBRAL_CLAVE_GRANDE) grandes++;
            }
            salida.clavesGrandes = grandes;

            if (_ultimaCuota) {
                salida.cuota = _ultimaCuota.cuota;
                salida.uso = _ultimaCuota.uso;
                salida.porcentaje = _ultimaCuota.porcentaje;
            } else {
                // Aún no se ha consultado la cuota real: pedimos una medición para
                // la próxima vez y mostramos el total local como uso aproximado.
                salida.cuota = 0;
                salida.uso = medida.totalBytes;
                salida.porcentaje = 0;
                estimarCuota();
            }

            salida.datos.productos = contarArreglo('ciervo_inventory');
            salida.datos.categorias = contarArreglo('ciervo_categories');
            salida.datos.ventas = contarArreglo('pos_sales');
            salida.datos.compras = contarArreglo('ciervo_purchases');
            salida.datos.clientes = contarArreglo('ciervo_clients');
            salida.datos.cuentas = contarArreglo('ciervo_accounts');
            salida.datos.proveedores = contarArreglo('ciervo_suppliers');

            try {
                var ventasTexto = localStorage.getItem('pos_sales');
                salida.datos.ventasBytes = bytesDeClave('pos_sales', ventasTexto);
            } catch (e) {
                salida.datos.ventasBytes = 0;
            }

            salida.imagenesIncrustadas = analizarImagenesIncrustadas();
        } catch (e) {
            /* devolvemos el informe parcial */
        }
        return salida;
    }

    /* ------------------------------------------------------------------ */
    /* 5. Guardado seguro                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Escribe en localStorage sin lanzar nunca. Si la cuota está llena (código
     * 'CUOTA'), avisa al usuario y devuelve el fallo en vez de romper la operación.
     * @param {string} clave
     * @param {string} valor
     * @returns {{ok: boolean, error: (string|null), codigo: (string|null)}}
     */
    function guardarLocalSeguro(clave, valor) {
        try {
            var texto = (typeof valor === 'string') ? valor : String(valor);
            localStorage.setItem(clave, texto);
            return { ok: true, error: null, codigo: null };
        } catch (e) {
            var cuota = esErrorDeCuota(e);
            var codigo = cuota ? 'CUOTA' : 'ERROR';
            var mensaje = cuota
                ? 'Almacenamiento del navegador lleno: no se pudo guardar "' + String(clave) +
                  '". Descarga un respaldo y libera espacio, o activa la sincronización en la nube.'
                : 'No se pudo guardar "' + String(clave) + '" en este navegador: ' + mensajeDe(e);
            try {
                mostrarAvisoAlmacenamiento(mensaje, cuota ? 'error' : 'aviso');
            } catch (e2) {
                /* el aviso es informativo: si falla, no debe romper el guardado */
            }
            return { ok: false, error: mensajeDe(e), codigo: codigo };
        }
    }

    /* ------------------------------------------------------------------ */
    /* 6. Respaldo                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Descarga un JSON con todas las claves de negocio que existan.
     * Avisa del tamaño estimado antes de descargar.
     * @returns {{ok: boolean, bytes: number, claves: number, listaClaves: Array<string>, error: (string|null)}}
     */
    function descargarRespaldo() {
        try {
            var claves = clavesDeNegocioPresentes();
            var datos = {};
            for (var i = 0; i < claves.length; i++) {
                try {
                    var valor = localStorage.getItem(claves[i]);
                    if (valor !== null) datos[claves[i]] = valor;
                } catch (e) {
                    /* si una clave no se puede leer, se omite del respaldo */
                }
            }
            var listaFinal = Object.keys(datos);

            var paquete = {
                app: APP,
                version: 1,
                generado: new Date().toISOString(),
                origen: (typeof location !== 'undefined' && location && location.origin) ? location.origin : '',
                datos: datos
            };

            var texto = JSON.stringify(paquete, null, 2);
            var bytes = texto.length * 2;

            // Aviso del tamaño estimado antes de descargar.
            var seguir = true;
            try {
                if (typeof confirm === 'function') {
                    seguir = confirm(
                        'Respaldo de Ciervo Mini Market\n\n' +
                        'Claves incluidas: ' + listaFinal.length + '\n' +
                        'Tamaño estimado: ' + formatearBytes(bytes) + '\n\n' +
                        '¿Descargar el archivo?'
                    );
                }
            } catch (e) {
                seguir = true;
            }
            if (!seguir) {
                return { ok: false, bytes: bytes, claves: listaFinal.length, listaClaves: listaFinal, error: 'descarga cancelada por el usuario' };
            }

            var nombre = 'respaldo-ciervo-' + fechaParaArchivo() + '.json';
            var blob = new Blob([texto], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var enlace = document.createElement('a');
            enlace.href = url;
            enlace.download = nombre;
            document.body.appendChild(enlace);
            enlace.click();
            setTimeout(function () {
                try {
                    if (enlace.parentNode) enlace.parentNode.removeChild(enlace);
                    URL.revokeObjectURL(url);
                } catch (e) {
                    /* limpieza best-effort */
                }
            }, 0);

            try {
                mostrarAvisoAlmacenamiento(
                    'Respaldo descargado (' + nombre + '): ' + listaFinal.length + ' claves · ' +
                    formatearBytes(bytes) + '. Guárdalo en un lugar seguro.',
                    'aviso'
                );
            } catch (e) { /* informativo */ }

            // La descarga salió bien: queda constancia para la política de límite
            // local (así ya se pueden borrar los registros más antiguos del historial).
            marcarRespaldoHecho();

            return { ok: true, bytes: bytes, claves: listaFinal.length, listaClaves: listaFinal, error: null };
        } catch (e) {
            try {
                mostrarAvisoAlmacenamiento('No se pudo generar el respaldo: ' + mensajeDe(e), 'error');
            } catch (e2) { /* informativo */ }
            return { ok: false, bytes: 0, claves: 0, listaClaves: [], error: mensajeDe(e) };
        }
    }

    /* ------------------------------------------------------------------ */
    /* 7. Restauración                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Restaura un respaldo JSON. Valida el archivo, pide confirmación con el
     * resumen y solo entonces escribe. Si algo falla, no deja cambios a medias.
     * @param {File} archivo
     * @returns {Promise<{ok: boolean, restauradas: number, error: (string|null)}>}
     */
    function restaurarRespaldo(archivo) {
        return new Promise(function (resolve) {
            try {
                if (!archivo) {
                    resolve({ ok: false, restauradas: 0, error: 'No se seleccionó ningún archivo.' });
                    return;
                }
                if (typeof FileReader === 'undefined') {
                    resolve({ ok: false, restauradas: 0, error: 'Este navegador no permite leer archivos locales.' });
                    return;
                }

                var lector = new FileReader();
                lector.onload = function () {
                    try {
                        var texto = String(lector.result || '');
                        var paquete;
                        try {
                            paquete = JSON.parse(texto);
                        } catch (e) {
                            resolve({ ok: false, restauradas: 0, error: 'El archivo no es un JSON válido.' });
                            return;
                        }
                        if (!paquete || typeof paquete !== 'object' ||
                            typeof paquete.version === 'undefined' ||
                            !paquete.datos || typeof paquete.datos !== 'object') {
                            resolve({ ok: false, restauradas: 0, error: 'El archivo no parece un respaldo de Ciervo Mini Market (faltan "version" o "datos").' });
                            return;
                        }

                        var claves = Object.keys(paquete.datos);
                        if (!claves.length) {
                            resolve({ ok: false, restauradas: 0, error: 'El respaldo no contiene datos.' });
                            return;
                        }

                        // Validación previa: si algún valor no es texto, NO se escribe nada.
                        for (var i = 0; i < claves.length; i++) {
                            if (typeof paquete.datos[claves[i]] !== 'string') {
                                resolve({ ok: false, restauradas: 0, error: 'El respaldo contiene un valor no válido en la clave "' + claves[i] + '".' });
                                return;
                            }
                            if (esClaveProhibida(claves[i])) {
                                resolve({ ok: false, restauradas: 0, error: 'El respaldo contiene la clave protegida "' + claves[i] + '"; no se restauró nada.' });
                                return;
                            }
                        }

                        var fecha = String(paquete.generado || 'sin fecha');
                        var origen = String(paquete.origen || 'desconocido');
                        var resumen =
                            'Restaurar respaldo de Ciervo Mini Market\n\n' +
                            'Claves a restaurar: ' + claves.length + '\n' +
                            'Generado: ' + fecha + '\n' +
                            'Origen: ' + origen + '\n\n' +
                            'ADVERTENCIA: se reemplazarán los datos actuales de este navegador ' +
                            '(inventario, ventas, clientes, configuración…).\n' +
                            'Se recomienda descargar un respaldo antes de continuar.\n\n' +
                            '¿Desea continuar?';

                        var continuar = true;
                        try {
                            if (typeof confirm === 'function') continuar = confirm(resumen);
                        } catch (e) {
                            continuar = true;
                        }
                        if (!continuar) {
                            resolve({ ok: false, restauradas: 0, error: 'Restauración cancelada por el usuario.' });
                            return;
                        }

                        // Escritura con reversa: si una clave falla, se devuelven los valores previos.
                        var previos = {};
                        var escritas = [];
                        try {
                            for (var j = 0; j < claves.length; j++) {
                                previos[claves[j]] = localStorage.getItem(claves[j]);
                                localStorage.setItem(claves[j], paquete.datos[claves[j]]);
                                escritas.push(claves[j]);
                            }
                        } catch (e) {
                            for (var k = 0; k < escritas.length; k++) {
                                try {
                                    if (previos[escritas[k]] === null) localStorage.removeItem(escritas[k]);
                                    else localStorage.setItem(escritas[k], previos[escritas[k]]);
                                } catch (e2) {
                                    /* si tampoco se puede revertir, seguimos */
                                }
                            }
                            resolve({ ok: false, restauradas: 0, error: 'No se pudo escribir el respaldo: ' + mensajeDe(e) + '. Se devolvieron los datos anteriores.' });
                            return;
                        }

                        try {
                            mostrarAvisoAlmacenamiento('Respaldo restaurado: ' + escritas.length + ' claves. Recarga la página para ver los datos.', 'aviso');
                        } catch (e) { /* informativo */ }

                        resolve({ ok: true, restauradas: escritas.length, error: null });
                    } catch (e) {
                        resolve({ ok: false, restauradas: 0, error: 'Error al procesar el respaldo: ' + mensajeDe(e) });
                    }
                };
                lector.onerror = function () {
                    resolve({ ok: false, restauradas: 0, error: 'No se pudo leer el archivo seleccionado.' });
                };
                lector.readAsText(archivo);
            } catch (e) {
                resolve({ ok: false, restauradas: 0, error: 'Error inesperado: ' + mensajeDe(e) });
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 8. Aviso flotante                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Muestra (o reutiliza) el aviso fijo de abajo a la derecha.
     * Estilos en línea para no depender del CSS de cada página.
     * @param {string} mensaje
     * @param {string} [tipo] 'aviso' (naranja) o 'error' (rojo)
     * @param {Array<{texto: string, accion: function}>} [botones] botones opcionales.
     *        Si no se pasan, el aviso funciona igual que antes (compatible).
     */
    function mostrarAvisoAlmacenamiento(mensaje, tipo, botones) {
        try {
            if (typeof document === 'undefined' || !document || !document.body) return;
            var esError = (tipo === 'error');
            var color = esError ? '#dc2626' : '#ea580c';

            var cont = document.getElementById('avisoAlmacenamiento');
            if (!cont) {
                cont = document.createElement('div');
                cont.id = 'avisoAlmacenamiento';
                document.body.appendChild(cont);
            }

            // Contenedor fijo, abajo a la derecha, por encima de todo.
            var s = cont.style;
            s.position = 'fixed';
            s.right = '16px';
            s.bottom = '16px';
            s.maxWidth = '360px';
            s.padding = '14px 40px 14px 16px';
            s.borderRadius = '12px';
            s.color = '#ffffff';
            s.fontSize = '0.85rem';
            s.fontFamily = 'inherit';
            s.lineHeight = '1.35';
            s.fontWeight = '500';
            s.zIndex = '2147483000';
            s.boxShadow = '0 10px 30px rgba(0,0,0,0.35)';
            s.background = color;
            s.display = 'block';

            // Se reconstruye el contenido para no acumular botones al reutilizar el div.
            cont.innerHTML = '';
            var texto = document.createElement('div');
            texto.textContent = String(mensaje === null || typeof mensaje === 'undefined' ? '' : mensaje);
            cont.appendChild(texto);

            // Botones opcionales (3.er parámetro). Con dos parámetros el aviso es
            // exactamente el de antes: texto + botón de cerrar.
            try {
                if (Object.prototype.toString.call(botones) === '[object Array]' && botones.length) {
                    var fila = document.createElement('div');
                    fila.style.marginTop = '10px';
                    fila.style.display = 'flex';
                    fila.style.gap = '8px';
                    fila.style.flexWrap = 'wrap';
                    for (var b = 0; b < botones.length; b++) {
                        (function (definicion) {
                            if (!definicion || typeof definicion.texto === 'undefined') return;
                            var accionBoton = document.createElement('button');
                            accionBoton.type = 'button';
                            accionBoton.textContent = String(definicion.texto);
                            var as = accionBoton.style;
                            as.background = '#ffffff';
                            as.color = color;
                            as.border = 'none';
                            as.borderRadius = '8px';
                            as.padding = '6px 12px';
                            as.fontSize = '0.8rem';
                            as.fontWeight = '700';
                            as.cursor = 'pointer';
                            accionBoton.onclick = function () {
                                try {
                                    if (typeof definicion.accion === 'function') definicion.accion();
                                } catch (e) { /* un botón del aviso nunca debe romper la app */ }
                            };
                            fila.appendChild(accionBoton);
                        })(botones[b]);
                    }
                    cont.appendChild(fila);
                }
            } catch (e) { /* si un botón no se puede pintar, el aviso sigue siendo válido */ }

            var boton = document.createElement('button');
            boton.type = 'button';
            boton.setAttribute('aria-label', 'Cerrar aviso');
            boton.textContent = '\u00d7';
            var bs = boton.style;
            bs.position = 'absolute';
            bs.top = '6px';
            bs.right = '8px';
            bs.background = 'transparent';
            bs.border = 'none';
            bs.color = '#ffffff';
            bs.fontSize = '18px';
            bs.lineHeight = '1';
            bs.cursor = 'pointer';
            bs.padding = '4px';
            boton.onclick = function () {
                try {
                    if (cont.parentNode) cont.parentNode.removeChild(cont);
                } catch (e) {
                    try { cont.style.display = 'none'; } catch (e2) { /* nada más que hacer */ }
                }
            };
            cont.appendChild(boton);
        } catch (e) {
            /* un aviso nunca debe romper la app */
        }
    }

    /* ------------------------------------------------------------------ */
    /* 9. Aviso automático al quedarse sin espacio                        */
    /* ------------------------------------------------------------------ */

    /**
     * Aviso automático de espacio, en lenguaje llano y sin alarmar:
     *   - Por debajo del 95 % del límite local NO dice nada (antes avisaba al
     *     80 %, y el cliente veía avisos técnicos en cada carga).
     *   - Al 95 % o más muestra UN mensaje y UN SOLO botón de acción
     *     ("Descargar copia de seguridad"), sin números ni tecnicismos.
     * Usa medirTodo() (síncrona y con la caché del historial) para ser barata:
     * la medición exacta la hace aplicarPoliticaAlmacenamiento() a los 3 s.
     * @returns {Promise<{porcentaje: number, avisado: boolean}>}
     */
    function avisarSiLleno() {
        return new Promise(function (resolve) {
            try {
                var medida = medirTodo();
                var porcentaje = Number(medida.porcentaje) || 0;
                if (porcentaje < UMBRAL_AVISO_LLENO) {
                    resolve({ porcentaje: porcentaje, avisado: false });
                    return;
                }
                mostrarAvisoAlmacenamiento(
                    'Al almacenamiento de este equipo le queda muy poco espacio. Descarga una copia de seguridad para no perder tus datos.',
                    'aviso',
                    [{
                        texto: 'Descargar copia de seguridad',
                        accion: function () {
                            try { descargarRespaldo(); } catch (e) { /* la descarga nunca debe romper la página */ }
                        }
                    }]
                );
                resolve({ porcentaje: porcentaje, avisado: true });
            } catch (e) {
                resolve({ porcentaje: 0, avisado: false });
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 10. Historial en IndexedDB (archivo histórico)                     */
    /* ------------------------------------------------------------------ */

    /**
     * Capa mínima sobre IndexedDB. La base `ciervo_historial` guarda las ventas
     * y compras antiguas que se quitan de localStorage: así el navegador libera
     * espacio sin perder el dato (el registro sigue existiendo, pero en el
     * historial). IndexedDB es asíncrono, así que todas estas funciones
     * devuelven promesas que NUNCA se rechazan.
     */

    /** Nombre y versión de la base del archivo histórico. */
    var IDB_NOMBRE = 'ciervo_historial';
    var IDB_VERSION = 1;

    /** Almacenes del historial: nombre -> clave primaria (keyPath). */
    var IDB_ALMACENES = { ventas: 'id', compras: 'id', meta: 'clave' };

    /** Último tamaño conocido del historial en bytes (IndexedDB es asíncrono). */
    var _historialBytes = 0;

    /** Promesa de apertura reutilizada: se abre la base una sola vez. */
    var _idbApertura = null;

    /** Evita lanzar dos mediciones del historial a la vez. */
    var _midiendoHistorial = false;

    /** Momento de la última medición del historial (para no medir en cada llamada). */
    var _historialUltimaMedicion = 0;

    /** Tiempo mínimo entre mediciones automáticas del historial (5 s). */
    var HISTORIAL_MEDICION_MS = 5000;

    /** Devuelve indexedDB si el navegador lo ofrece, o null. */
    function apiIndexedDB() {
        try {
            if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
            if (typeof window !== 'undefined' && window && window.indexedDB) return window.indexedDB;
        } catch (e) { /* sin IndexedDB */ }
        return null;
    }

    /** ¿Este navegador puede guardar el historial en IndexedDB? */
    function historialDisponible() {
        try { return !!apiIndexedDB(); } catch (e) { return false; }
    }

    /** keyPath del almacén pedido, o null si ese almacén no es del historial. */
    function clavePrimariaDe(nombre) {
        try {
            var k = IDB_ALMACENES[String(nombre || '')];
            return (typeof k === 'string') ? k : null;
        } catch (e) { return null; }
    }

    /** ¿La base ya tiene ese almacén? (objectStoreNames.contains puede faltar). */
    function existeAlmacen(db, nombre) {
        try {
            var nombres = db && db.objectStoreNames;
            if (!nombres) return false;
            if (typeof nombres.contains === 'function') return !!nombres.contains(nombre);
            for (var i = 0; i < nombres.length; i++) {
                if (nombres[i] === nombre) return true;
            }
            return false;
        } catch (e) { return false; }
    }

    /**
     * Abre (o reutiliza) la base del historial.
     * @returns {Promise<IDBDatabase|null>} null si el navegador no puede.
     */
    function abrirHistorial() {
        try {
            if (_idbApertura) return _idbApertura;
            _idbApertura = new Promise(function (resolve) {
                try {
                    var api = apiIndexedDB();
                    if (!api || typeof api.open !== 'function') { resolve(null); return; }
                    var solicitud = api.open(IDB_NOMBRE, IDB_VERSION);
                    if (!solicitud) { _idbApertura = null; resolve(null); return; }

                    // Se crean los almacenes que falten en la primera apertura.
                    solicitud.onupgradeneeded = function (evento) {
                        try {
                            var db = (evento && evento.target) ? evento.target.result : null;
                            if (!db || typeof db.createObjectStore !== 'function') return;
                            var nombres = Object.keys(IDB_ALMACENES);
                            for (var i = 0; i < nombres.length; i++) {
                                var nombre = nombres[i];
                                if (existeAlmacen(db, nombre)) continue;
                                try { db.createObjectStore(nombre, { keyPath: IDB_ALMACENES[nombre] }); } catch (e) { /* ya existía */ }
                            }
                        } catch (e) { /* si un almacén no se crea, la operación lo reportará */ }
                    };
                    solicitud.onsuccess = function (evento) {
                        try {
                            var db = (evento && evento.target) ? evento.target.result : null;
                            resolve(db || null);
                        } catch (e) { resolve(null); }
                    };
                    solicitud.onerror = function () { _idbApertura = null; resolve(null); };
                    solicitud.onblocked = function () { _idbApertura = null; resolve(null); };
                } catch (e) { _idbApertura = null; resolve(null); }
            });
            return _idbApertura;
        } catch (e) {
            return new Promise(function (resolve) { resolve(null); });
        }
    }

    /**
     * Ejecuta `operacion(almacen, salida)` dentro de una transacción.
     * `salida` es el objeto que se resuelve: la operación puede dejarlo ahí
     * (por ejemplo `salida.datos`). Nunca rechaza.
     * @returns {Promise<{ok: boolean, error: (string|null)}>}
     */
    function operarEnAlmacen(nombre, modo, operacion) {
        return new Promise(function (resolve) {
            var salida = { ok: false, error: null };
            try {
                if (!clavePrimariaDe(nombre)) {
                    salida.error = 'Almacén de historial desconocido: ' + String(nombre);
                    resolve(salida);
                    return;
                }
                if (!historialDisponible()) {
                    salida.error = 'Este navegador no ofrece IndexedDB.';
                    resolve(salida);
                    return;
                }
                abrirHistorial().then(function (db) {
                    if (!db) { salida.error = 'No se pudo abrir el historial local.'; resolve(salida); return; }

                    var terminado = false;
                    function terminar() {
                        if (terminado) return;
                        terminado = true;
                        resolve(salida);
                    }

                    try {
                        var tx = db.transaction(nombre, modo);
                        var almacen = tx.objectStore(nombre);

                        // Los manejadores se registran ANTES de lanzar las peticiones:
                        // así una implementación que complete la transacción al instante
                        // tampoco se pierde (y en un navegador real el orden es el mismo).
                        tx.oncomplete = function () { terminar(); };
                        tx.onerror = function () {
                            salida.ok = false;
                            salida.error = salida.error || 'Error en la transacción del historial.';
                            terminar();
                        };
                        tx.onabort = function () {
                            salida.ok = false;
                            salida.error = salida.error || 'Transacción del historial abortada.';
                            terminar();
                        };

                        try {
                            salida.ok = true;   // provisional: se confirma al completar la transacción
                            operacion(almacen, salida);
                        } catch (e) {
                            salida.ok = false;
                            salida.error = mensajeDe(e);
                            try { if (typeof tx.abort === 'function') tx.abort(); } catch (e2) { /* nada más */ }
                            terminar();
                        }
                    } catch (e) {
                        salida.ok = false;
                        salida.error = mensajeDe(e);
                        terminar();
                    }
                }).catch(function (e) {
                    salida.ok = false;
                    salida.error = mensajeDe(e);
                    resolve(salida);
                });
            } catch (e) {
                salida.ok = false;
                salida.error = mensajeDe(e);
                resolve(salida);
            }
        });
    }

    /** Todos los registros de un almacén, o null si no se pudieron leer. */
    function leerTodosDelAlmacen(nombre) {
        return new Promise(function (resolve) {
            try {
                operarEnAlmacen(nombre, 'readonly', function (almacen, salida) {
                    if (!almacen || typeof almacen.getAll !== 'function') {
                        salida.ok = false;
                        salida.error = 'El historial no permite leer registros.';
                        return;
                    }
                    var peticion = almacen.getAll();
                    if (peticion && typeof peticion === 'object') {
                        peticion.onsuccess = function () {
                            var datos = peticion.result;
                            salida.datos = (Object.prototype.toString.call(datos) === '[object Array]') ? datos : [];
                        };
                    }
                }).then(function (salida) {
                    if (salida && salida.ok && Object.prototype.toString.call(salida.datos) === '[object Array]') resolve(salida.datos);
                    else resolve(null);
                }).catch(function () { resolve(null); });
            } catch (e) { resolve(null); }
        });
    }

    /** Bytes (UTF-16, igual que medirAlmacenamiento) que ocupa un registro. */
    function bytesDeRegistro(registro) {
        try {
            var texto = JSON.stringify(registro);
            if (typeof texto !== 'string') return 0;
            return texto.length * 2;
        } catch (e) { return 0; }
    }

    /** Suma bytes a la caché del tamaño del historial (nunca baja de cero). */
    function ajustarCacheHistorial(delta) {
        try { _historialBytes = Math.max(0, _historialBytes + (Number(delta) || 0)); } catch (e) { /* nada */ }
    }

    /** Valor de la clave primaria de un registro, o null si no la tiene. */
    function claveDeRegistro(nombre, registro) {
        try {
            var campo = clavePrimariaDe(nombre);
            if (!campo || !registro || typeof registro !== 'object') return null;
            var valor = registro[campo];
            if (valor === null || typeof valor === 'undefined' || valor === '') return null;
            return valor;
        } catch (e) { return null; }
    }

    /** Deja solo los registros guardables (con clave primaria) de lo recibido. */
    function registrosValidos(nombre, registros) {
        var lista = [];
        try {
            var entrada = registros;
            if (Object.prototype.toString.call(entrada) !== '[object Array]') entrada = [entrada];
            for (var i = 0; i < entrada.length; i++) {
                var reg = entrada[i];
                if (!reg || typeof reg !== 'object') continue;
                if (claveDeRegistro(nombre, reg) === null) continue;
                lista.push(reg);
            }
        } catch (e) { /* devolvemos lo válido */ }
        return lista;
    }

    /** Lista limpia de claves primarias a borrar. */
    function normalizarIds(ids) {
        var lista = [];
        try {
            var entrada = ids;
            if (Object.prototype.toString.call(entrada) !== '[object Array]') entrada = [entrada];
            for (var i = 0; i < entrada.length; i++) {
                var id = entrada[i];
                if (id === null || typeof id === 'undefined' || id === '') continue;
                lista.push(id);
            }
        } catch (e) { /* devolvemos lo válido */ }
        return lista;
    }

    /**
     * Guarda registros en el historial (put: si ya existe la clave, se reemplaza).
     * @param {string} nombre 'ventas' | 'compras' | 'meta'
     * @param {Array|object} registros
     * @returns {Promise<{ok: boolean, guardados: number, solicitados: number, error: (string|null)}>}
     */
    function guardarEnHistorial(nombre, registros) {
        return new Promise(function (resolve) {
            var salida = { ok: false, guardados: 0, solicitados: 0, error: null };
            try {
                var total = Object.prototype.toString.call(registros) === '[object Array]' ? registros.length : 1;
                salida.solicitados = total;
                var lista = registrosValidos(nombre, registros);
                if (!lista.length) {
                    salida.error = 'No hay registros válidos que guardar en "' + String(nombre) + '".';
                    resolve(salida);
                    return;
                }
                var bytes = 0;
                for (var i = 0; i < lista.length; i++) bytes += bytesDeRegistro(lista[i]);

                operarEnAlmacen(nombre, 'readwrite', function (almacen, res) {
                    if (!almacen || typeof almacen.put !== 'function') {
                        res.ok = false;
                        res.error = 'El historial no permite guardar registros.';
                        return;
                    }
                    for (var j = 0; j < lista.length; j++) almacen.put(lista[j]);
                }).then(function (res) {
                    if (res && res.ok) {
                        salida.ok = true;
                        salida.guardados = lista.length;
                        if (lista.length === total) ajustarCacheHistorial(bytes);
                        else refrescarTamanoHistorial(true);
                    } else {
                        salida.error = (res && res.error) || 'No se pudo escribir en el historial.';
                    }
                    resolve(salida);
                }).catch(function (e) {
                    salida.error = mensajeDe(e);
                    resolve(salida);
                });
            } catch (e) {
                salida.error = mensajeDe(e);
                resolve(salida);
            }
        });
    }

    /**
     * Cuántos registros hay archivados en un almacén.
     * @returns {Promise<number>} 0 si no se pudo contar.
     */
    function contarHistorial(nombre) {
        return new Promise(function (resolve) {
            try {
                operarEnAlmacen(nombre, 'readonly', function (almacen, salida) {
                    if (!almacen || typeof almacen.count !== 'function') {
                        salida.ok = false;
                        salida.error = 'El historial no permite contar registros.';
                        return;
                    }
                    var peticion = almacen.count();
                    if (peticion && typeof peticion === 'object') {
                        peticion.onsuccess = function () { salida.total = Number(peticion.result) || 0; };
                    }
                }).then(function (salida) {
                    resolve(salida && salida.ok ? (Number(salida.total) || 0) : 0);
                }).catch(function () { resolve(0); });
            } catch (e) { resolve(0); }
        });
    }

    /** Fecha (ms) de un valor de fecha cualquiera, o null si no es interpretable. */
    function valorFecha(valor) {
        try {
            if (valor === null || typeof valor === 'undefined' || valor === '') return null;
            if (typeof valor === 'number') return (isFinite(valor) && valor > 0) ? valor : null;
            if (typeof valor === 'object') {
                // Timestamp de Firestore u objetos { seconds } / { _seconds }
                var seg = (typeof valor.seconds === 'number') ? valor.seconds
                    : ((typeof valor._seconds === 'number') ? valor._seconds : null);
                return (seg === null) ? null : seg * 1000;
            }
            var texto = String(valor).trim();
            if (!texto) return null;
            if (/^\d{10,13}$/.test(texto)) {           // epoch en segundos o milisegundos
                var n = Number(texto);
                return (texto.length <= 10) ? n * 1000 : n;
            }
            var ms = Date.parse(texto);
            if (!isNaN(ms)) return ms;
            var m = texto.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);   // dd/mm/aaaa
            if (m) {
                var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
                if (!isNaN(d.getTime())) return d.getTime();
            }
            return null;
        } catch (e) { return null; }
    }

    /**
     * Fecha de un registro del historial. Se prueban varias claves porque las
     * ventas usan `timestamp`, las compras `fecha` y algunos respaldos `t`/`ts`.
     * @returns {number|null} milisegundos, o null si no tiene fecha.
     */
    function fechaDeRegistro(registro) {
        try {
            if (!registro || typeof registro !== 'object') return null;
            var campos = ['timestamp', 'fecha', 'fechaHora', 'fechaISO', 'fechaVenta', 't', 'ts', 'creado', 'creadoEn'];
            for (var i = 0; i < campos.length; i++) {
                var valor = registro[campos[i]];
                if (valor === null || typeof valor === 'undefined' || valor === '') continue;
                var ms = valorFecha(valor);
                if (ms !== null) return ms;
            }
            return null;
        } catch (e) { return null; }
    }

    /** Fecha para ordenar: los registros sin fecha van al final (los últimos). */
    function fechaParaOrden(registro) {
        var ms = fechaDeRegistro(registro);
        return (ms === null) ? Number.MAX_SAFE_INTEGER : ms;
    }

    /**
     * Lee el historial de un almacén, del más antiguo al más nuevo.
     * @param {string} nombre 'ventas' | 'compras' | 'meta'
     * @param {number} [limite] cuántos registros devolver (0 o vacío = todos)
     * @returns {Promise<Array>} [] si no se pudo leer.
     */
    function leerHistorial(nombre, limite) {
        return new Promise(function (resolve) {
            try {
                leerTodosDelAlmacen(nombre).then(function (registros) {
                    if (!registros) { resolve([]); return; }
                    var ordenados;
                    try {
                        ordenados = registros.slice().sort(function (a, b) { return fechaParaOrden(a) - fechaParaOrden(b); });
                    } catch (e) { ordenados = registros.slice(); }
                    var n = Number(limite);
                    if (isFinite(n) && n > 0) ordenados = ordenados.slice(0, n);
                    resolve(ordenados);
                }).catch(function () { resolve([]); });
            } catch (e) { resolve([]); }
        });
    }

    /**
     * Borra del historial los registros indicados por su clave primaria.
     * @returns {Promise<{ok: boolean, borrados: number, error: (string|null)}>}
     */
    function borrarDelHistorial(nombre, ids) {
        return new Promise(function (resolve) {
            var salida = { ok: false, borrados: 0, error: null };
            try {
                var lista = normalizarIds(ids);
                if (!lista.length) { salida.ok = true; resolve(salida); return; }
                operarEnAlmacen(nombre, 'readwrite', function (almacen, res) {
                    if (!almacen || typeof almacen.delete !== 'function') {
                        res.ok = false;
                        res.error = 'El historial no permite borrar registros.';
                        return;
                    }
                    for (var i = 0; i < lista.length; i++) almacen.delete(lista[i]);
                }).then(function (res) {
                    if (res && res.ok) {
                        salida.ok = true;
                        salida.borrados = lista.length;
                    } else {
                        salida.error = (res && res.error) || 'No se pudo borrar del historial.';
                    }
                    resolve(salida);
                }).catch(function (e) {
                    salida.error = mensajeDe(e);
                    resolve(salida);
                });
            } catch (e) {
                salida.error = mensajeDe(e);
                resolve(salida);
            }
        });
    }

    /**
     * Suma de JSON.stringify de TODOS los registros del historial, en bytes
     * UTF-16 (×2), igual que medirAlmacenamiento(): así la comparación con el
     * límite local es homogénea. Deja el resultado en la caché interna.
     * @returns {Promise<number>} bytes (o el último valor conocido si falla).
     */
    function tamanoHistorial() {
        return new Promise(function (resolve) {
            try {
                if (!historialDisponible()) { resolve(_historialBytes); return; }
                var nombres = Object.keys(IDB_ALMACENES);
                var total = 0;
                var pendientes = nombres.length;
                var fallo = false;

                function terminarUno() {
                    pendientes--;
                    if (pendientes > 0) return;
                    if (!fallo) _historialBytes = total;
                    resolve(fallo ? _historialBytes : total);
                }

                for (var i = 0; i < nombres.length; i++) {
                    (function (nombre) {
                        leerTodosDelAlmacen(nombre).then(function (registros) {
                            if (registros === null) {
                                fallo = true;
                            } else {
                                for (var j = 0; j < registros.length; j++) total += bytesDeRegistro(registros[j]);
                            }
                            terminarUno();
                        }).catch(function () {
                            fallo = true;
                            terminarUno();
                        });
                    })(nombres[i]);
                }
            } catch (e) { resolve(_historialBytes); }
        });
    }

    /** Lanza una medición del historial en segundo plano (con freno de 5 s). */
    function refrescarTamanoHistorial(forzar) {
        try {
            if (!historialDisponible()) return;
            if (_midiendoHistorial) return;
            var ahora = Date.now();
            if (!forzar && _historialUltimaMedicion && (ahora - _historialUltimaMedicion) < HISTORIAL_MEDICION_MS) return;
            _midiendoHistorial = true;
            _historialUltimaMedicion = ahora;
            tamanoHistorial().then(function () {
                _midiendoHistorial = false;
            }).catch(function () {
                _midiendoHistorial = false;
            });
        } catch (e) { _midiendoHistorial = false; }
    }

    /* ------------------------------------------------------------------ */
    /* 11. Límite local configurable                                      */
    /* ------------------------------------------------------------------ */

    /** Límite por defecto si no hay nada configurado: 1 GB. */
    var LIMITE_POR_DEFECTO_MB = 1024;

    /** Clave local del límite (configurable desde la consola de Firebase). */
    var CLAVE_LIMITE_LOCAL = 'limiteLocalMB';

    /** Clave donde se marca que ya se descargó un respaldo. */
    var CLAVE_RESPALDO_HECHO = 'respaldoHecho';

    /** Último límite leído de la nube (la lectura es asíncrona en Firebase real). */
    var _limiteNubeMB = 0;

    /** Momento del último intento de leer el límite en la nube. */
    var _limiteNubeIntento = 0;

    /** No se reintenta la lectura del límite en la nube antes de este tiempo (60 s). */
    var LIMITE_NUBE_REINTENTO_MS = 60000;

    /** Correo del negocio actual (el que usan las páginas para la ruta BBDD/…). */
    function emailActual() {
        try {
            if (typeof window !== 'undefined' && window && typeof window.getCurrentUserEmail === 'function') {
                var propio = window.getCurrentUserEmail();
                if (propio) return String(propio);
            }
        } catch (e) { /* seguimos con los respaldos */ }
        try {
            if (typeof sessionStorage !== 'undefined' && sessionStorage) {
                var sesion = sessionStorage.getItem('propietarioActual');
                if (sesion) return String(sesion);
                var dueno = JSON.parse(sessionStorage.getItem('currentOwner') || 'null');
                if (dueno && dueno.email) return String(dueno.email);
                var actual = JSON.parse(sessionStorage.getItem('currentUser') || 'null');
                if (actual && actual.email) return String(actual.email);
            }
        } catch (e) { /* seguimos */ }
        try {
            var local = JSON.parse(localStorage.getItem('currentUser') || 'null');
            if (local && local.email) return String(local.email);
        } catch (e) { /* seguimos */ }
        try {
            if (typeof firebase !== 'undefined' && firebase && typeof firebase.auth === 'function') {
                var usuario = firebase.auth().currentUser;
                if (usuario && usuario.email) return String(usuario.email);
            }
        } catch (e) { /* seguimos */ }
        return null;
    }

    /** Ruta del email normalizada, igual que el resto de la app. */
    function emailAPath(email) {
        try {
            if (typeof window !== 'undefined' && window && typeof window.sanitizeEmailForDb === 'function') {
                var ruta = window.sanitizeEmailForDb(email);
                if (ruta) return String(ruta);
            }
        } catch (e) { /* usamos la normalización local */ }
        return String(email || '').trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');
    }

    /** ¿Firebase ya está inicializado en esta página? */
    function firebaseListo() {
        try {
            return (typeof firebase !== 'undefined' && firebase && firebase.apps && firebase.apps.length > 0);
        } catch (e) { return false; }
    }

    /**
     * Intenta leer `BBDD/<emailPath>/suscripcion/limiteLocalMB`.
     * La lectura de Firebase es asíncrona: si el valor llega después, queda en
     * caché para la próxima medición (y si llega de inmediato —almacén en
     * memoria o implementación síncrona— se devuelve ya).
     * @returns {{mb: number, origen: string}|null}
     */
    function consultarLimiteEnNube() {
        try {
            if (!firebaseListo()) return null;
            if (_limiteNubeMB > 0) return { mb: _limiteNubeMB, origen: 'consola' };

            var ahora = Date.now();
            if (_limiteNubeIntento && (ahora - _limiteNubeIntento) < LIMITE_NUBE_REINTENTO_MS) return null;
            _limiteNubeIntento = ahora;

            var email = emailActual();
            if (!email) return null;

            var db = firebase.database();
            if (!db || typeof db.ref !== 'function') return null;
            var referencia = db.ref('BBDD/' + emailAPath(email) + '/suscripcion/' + CLAVE_LIMITE_LOCAL);
            if (!referencia || typeof referencia.once !== 'function') return null;

            var capturado = null;
            referencia.once('value', function (instantanea) {
                try {
                    var valor = (instantanea && typeof instantanea.val === 'function') ? instantanea.val() : null;
                    if (valor && typeof valor === 'object' && typeof valor.mb !== 'undefined') valor = valor.mb;
                    var mb = Number(valor);
                    if (isFinite(mb) && mb > 0) {
                        _limiteNubeMB = mb;
                        if (capturado === null) capturado = mb;
                    }
                } catch (e) { /* valor ilegible: seguimos con el resto de fuentes */ }
            }, function () { /* sin conexión o sin permiso: no es un error para la app */ });

            if (capturado !== null) return { mb: capturado, origen: 'consola' };
            return null;
        } catch (e) { return null; }
    }

    /**
     * Límite local en MB, por orden de prioridad:
     *   1) nube:  BBDD/<emailPath>/suscripcion/limiteLocalMB  (si Firebase ya está inicializado)
     *   2) localStorage['limiteLocalMB']
     *   3) 1024 MB (1 GB)
     * @returns {{mb: number, origen: string}} origen: 'consola' | 'local' | 'por-defecto'
     */
    function limiteLocalMB() {
        try {
            var nube = consultarLimiteEnNube();
            if (nube) return nube;
        } catch (e) { /* seguimos con localStorage */ }
        try {
            var crudo = localStorage.getItem(CLAVE_LIMITE_LOCAL);
            if (crudo !== null && String(crudo).trim() !== '') {
                var mb = Number(String(crudo).replace(',', '.'));
                if (isFinite(mb) && mb > 0) return { mb: mb, origen: 'local' };
            }
        } catch (e) { /* seguimos con el valor por defecto */ }
        return { mb: LIMITE_POR_DEFECTO_MB, origen: 'por-defecto' };
    }

    /* ------------------------------------------------------------------ */
    /* 12. Medición total (localStorage + historial)                       */
    /* ------------------------------------------------------------------ */

    /** Arma el objeto de medida a partir de los bytes ya calculados. */
    function calcularMedida(localBytes, historialBytes) {
        var limite = { mb: LIMITE_POR_DEFECTO_MB, origen: 'por-defecto' };
        try { limite = limiteLocalMB(); } catch (e) { /* valor por defecto */ }
        var limiteMB = Number(limite.mb);
        if (!isFinite(limiteMB) || limiteMB <= 0) limiteMB = LIMITE_POR_DEFECTO_MB;
        var limiteBytes = Math.round(limiteMB * 1048576);
        var totalBytes = (Number(localBytes) || 0) + (Number(historialBytes) || 0);
        var exacto = limiteBytes > 0 ? (totalBytes / limiteBytes) * 100 : 0;
        return {
            localBytes: Number(localBytes) || 0,
            historialBytes: Number(historialBytes) || 0,
            totalBytes: totalBytes,
            limiteBytes: limiteBytes,
            limiteMB: limiteMB,
            // `porcentaje` es el valor que se muestra; las decisiones usan el exacto
            // para no borrar nada por un redondeo (99,96 % no es 100 %).
            porcentaje: Math.round(exacto * 10) / 10,
            porcentajeExacto: exacto,
            origenLimite: limite.origen
        };
    }

    /**
     * Medida sincrónica: usa el último tamaño de historial conocido y lanza la
     * medición real en segundo plano. Para decisiones que borran datos usa
     * medirTodoAsync(), que sí espera a IndexedDB.
     * @returns {{localBytes: number, historialBytes: number, totalBytes: number, limiteBytes: number, porcentaje: number, origenLimite: string}}
     */
    function medirTodo() {
        var localBytes = 0;
        try { localBytes = medirAlmacenamiento().totalBytes; } catch (e) { localBytes = 0; }
        var medida = calcularMedida(localBytes, _historialBytes);
        refrescarTamanoHistorial();
        return medida;
    }

    /**
     * Medida completa: espera a que IndexedDB informe el tamaño del historial.
     * @returns {Promise<object>} el mismo objeto que medirTodo().
     */
    function medirTodoAsync() {
        return new Promise(function (resolve) {
            var localBytes = 0;
            try { localBytes = medirAlmacenamiento().totalBytes; } catch (e) { localBytes = 0; }
            tamanoHistorial().then(function (bytes) {
                resolve(calcularMedida(localBytes, bytes));
            }).catch(function () {
                resolve(calcularMedida(localBytes, _historialBytes));
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* 13. Archivado de ventas antiguas y política de límite              */
    /* ------------------------------------------------------------------ */

    /** Meses de ventas que se conservan en localStorage antes de archivar. */
    var ARCHIVAR_MESES = 6;

    /** Registros por lote al borrar el historial más antiguo. */
    var LOTE_BORRADO = 100;

    /** Porcentaje a partir del cual se borran los registros más antiguos. */
    var UMBRAL_LLENO = 100;

    /** Se borra hasta bajar de este porcentaje. */
    var UMBRAL_RECORTE = 90;

    /** Tope de lotes por llamada: red de seguridad contra bucles infinitos. */
    var MAX_LOTES = 2000;

    /** Evita dos archivados a la vez (uno pisaría las ventas del otro). */
    var _archivando = false;

    /** Fecha de corte: hoy menos ARCHIVAR_MESES meses, en milisegundos. */
    function fechaCorteArchivado() {
        try {
            var d = new Date();
            d.setMonth(d.getMonth() - ARCHIVAR_MESES);
            return d.getTime();
        } catch (e) { return 0; }
    }

    /**
     * Mueve a IndexedDB las ventas de más de 6 meses y las quita de `pos_sales`.
     * Garantía: la venta se guarda en el historial (y se comprueba que está)
     * ANTES de quitarla de localStorage. Si algo falla, no se quita nada.
     * @returns {Promise<{archivadas: number, quedan: number, error: (string|null)}>}
     */
    function archivarVentasAntiguas() {
        return new Promise(function (resolve) {
            var salida = { archivadas: 0, quedan: 0, error: null };
            try {
                if (_archivando) {
                    salida.quedan = contarArreglo('pos_sales');
                    resolve(salida);
                    return;
                }
                var ventas = leerJSON('pos_sales', []);
                if (Object.prototype.toString.call(ventas) !== '[object Array]') {
                    salida.error = 'Las ventas guardadas no tienen el formato esperado.';
                    resolve(salida);
                    return;
                }
                salida.quedan = ventas.length;
                if (!ventas.length) { resolve(salida); return; }
                if (!historialDisponible()) {
                    salida.error = 'Este navegador no ofrece IndexedDB: no se puede archivar sin riesgo de perder ventas.';
                    resolve(salida);
                    return;
                }

                var corte = fechaCorteArchivado();
                var antiguas = [];
                for (var i = 0; i < ventas.length; i++) {
                    var venta = ventas[i];
                    // Sin identificador no se puede archivar (y quitarla sería arriesgado).
                    if (!venta || typeof venta !== 'object' || claveDeRegistro('ventas', venta) === null) continue;
                    var ms = fechaDeRegistro(venta);
                    // Sin fecha se considera reciente: no se archiva.
                    if (ms === null || ms >= corte) continue;
                    antiguas.push(venta);
                }
                if (!antiguas.length) { resolve(salida); return; }

                _archivando = true;

                // 1) Primero el historial.
                guardarEnHistorial('ventas', antiguas).then(function (guardado) {
                    if (!guardado || !guardado.ok || guardado.guardados < antiguas.length) {
                        _archivando = false;
                        salida.error = 'No se pudieron archivar las ventas antiguas; no se quitó ninguna de localStorage. ' +
                            ((guardado && guardado.error) ? '(' + guardado.error + ')' : '');
                        salida.quedan = contarArreglo('pos_sales');
                        resolve(salida);
                        return;
                    }
                    // 2) Comprobación: las ventas archivadas deben poder leerse.
                    return leerHistorial('ventas', 0).then(function (archivadas) {
                        var presentes = {};
                        if (Object.prototype.toString.call(archivadas) === '[object Array]') {
                            for (var j = 0; j < archivadas.length; j++) {
                                var clave = claveDeRegistro('ventas', archivadas[j]);
                                if (clave !== null) presentes[String(clave)] = true;
                            }
                        } else {
                            _archivando = false;
                            salida.error = 'No se pudo verificar el historial; no se quitó ninguna venta de localStorage.';
                            salida.quedan = contarArreglo('pos_sales');
                            resolve(salida);
                            return;
                        }
                        var idsArchivados = {};
                        var faltan = 0;
                        for (var k = 0; k < antiguas.length; k++) {
                            var id = String(claveDeRegistro('ventas', antiguas[k]));
                            idsArchivados[id] = true;
                            if (!presentes[id]) faltan++;
                        }
                        if (faltan > 0) {
                            _archivando = false;
                            salida.error = 'El historial no confirmó ' + faltan + ' venta(s); no se quitó ninguna de localStorage.';
                            salida.quedan = contarArreglo('pos_sales');
                            resolve(salida);
                            return;
                        }

                        // 3) Solo entonces se quitan del arreglo local. Se vuelve a leer
                        //    pos_sales para no perder una venta registrada mientras se
                        //    archivaba: se quitan SOLO las que ya están en el historial.
                        var actuales = leerJSON('pos_sales', []);
                        if (Object.prototype.toString.call(actuales) !== '[object Array]') actuales = [];
                        var restantes = [];
                        for (var m = 0; m < actuales.length; m++) {
                            var actual = actuales[m];
                            var claveActual = claveDeRegistro('ventas', actual);
                            if (claveActual !== null && idsArchivados[String(claveActual)]) continue;
                            restantes.push(actual);
                        }
                        var escritura = guardarLocalSeguro('pos_sales', JSON.stringify(restantes));
                        _archivando = false;
                        salida.quedan = restantes.length;
                        if (escritura && escritura.ok) {
                            salida.archivadas = antiguas.length;
                        } else {
                            salida.error = 'Las ventas quedaron archivadas y siguen en localStorage (no se pudieron quitar): ' +
                                ((escritura && escritura.error) ? escritura.error : 'error desconocido');
                            salida.quedan = contarArreglo('pos_sales');
                        }
                        resolve(salida);
                    });
                }).then(function () {
                    _archivando = false;
                }).catch(function (e) {
                    _archivando = false;
                    salida.error = mensajeDe(e);
                    salida.quedan = contarArreglo('pos_sales');
                    resolve(salida);
                });
            } catch (e) {
                _archivando = false;
                salida.error = mensajeDe(e);
                resolve(salida);
            }
        });
    }

    /**
     * Borra en lotes de 100 los registros MÁS ANTIGUOS del historial (primero
     * `ventas`, luego `compras`) hasta bajar del 90 % del límite o hasta que no
     * queden registros.
     * @param {object} medida
     * @param {{borrados: number, liberadoBytes: number, lotes: number}} estado
     * @param {function(object)} alTerminar recibe la última medida
     */
    function borrarMasAntiguos(medida, estado, alTerminar) {
        try {
            if (medida.porcentajeExacto < UMBRAL_RECORTE || estado.lotes >= MAX_LOTES) { alTerminar(medida); return; }
            estado.lotes++;

            var nombres = ['ventas', 'compras'];

            function siguienteAlmacen(indice) {
                if (indice >= nombres.length) { alTerminar(medida); return; }   // no quedan registros
                var nombre = nombres[indice];
                leerHistorial(nombre, LOTE_BORRADO).then(function (lote) {
                    if (!lote || !lote.length) { siguienteAlmacen(indice + 1); return; }
                    var ids = [];
                    var bytes = 0;
                    for (var i = 0; i < lote.length; i++) {
                        var clave = claveDeRegistro(nombre, lote[i]);
                        if (clave === null) continue;
                        ids.push(clave);
                        bytes += bytesDeRegistro(lote[i]);
                    }
                    if (!ids.length) { alTerminar(medida); return; }
                    borrarDelHistorial(nombre, ids).then(function (res) {
                        if (!res || !res.ok || !res.borrados) { alTerminar(medida); return; }
                        estado.borrados += res.borrados;
                        estado.liberadoBytes += bytes;
                        // Los bytes borrados ya no cuentan: se descuentan de la caché
                        // en vez de releer TODO el historial en cada lote (que sería
                        // carísimo justo cuando el historial es enorme).
                        ajustarCacheHistorial(-bytes);
                        medida = calcularMedida(medirAlmacenamiento().totalBytes, _historialBytes);
                        try { borrarMasAntiguos(medida, estado, alTerminar); }
                        catch (e) { alTerminar(medida); }
                    }).catch(function () { alTerminar(medida); });
                }).catch(function () { alTerminar(medida); });
            }

            siguienteAlmacen(0);
        } catch (e) { alTerminar(medida); }
    }

    /**
     * Aplica la política de límite local. Nunca lanza: siempre resuelve un objeto.
     *
     * Reglas:
     *   - < 80 %: no hace nada.
     *   - >= 80 % y < 100 %: aviso (activar la nube o descargar respaldo).
     *   - >= 100 %: exige un respaldo la PRIMERA vez; después borra el historial
     *     más antiguo en lotes de 100 hasta bajar del 90 %.
     *
     * @returns {Promise<{accion: string, porcentaje: number, liberadoBytes: number, aviso: (string|null)}>}
     *   accion: 'nada' | 'aviso' | 'requiere-respaldo' | 'recortado' | 'lleno' | 'error'
     */
    function aplicarPoliticaAlmacenamiento() {
        return new Promise(function (resolve) {
            var base = {
                accion: 'error',
                porcentaje: 0,
                liberadoBytes: 0,
                aviso: null,
                tipoAviso: null,
                borrados: 0,
                localBytes: 0,
                historialBytes: 0,
                limiteBytes: 0,
                origenLimite: 'por-defecto'
            };
            try {
                medirTodoAsync().then(function (medida) {
                    var salida = {
                        accion: 'nada',
                        porcentaje: medida.porcentaje,
                        porcentajeInicial: medida.porcentaje,
                        liberadoBytes: 0,
                        aviso: null,
                        tipoAviso: null,
                        borrados: 0,
                        localBytes: medida.localBytes,
                        historialBytes: medida.historialBytes,
                        limiteBytes: medida.limiteBytes,
                        origenLimite: medida.origenLimite
                    };

                    function publicar(texto, tipo, botones) {
                        salida.aviso = texto;
                        salida.tipoAviso = tipo;
                        try { mostrarAvisoAlmacenamiento(texto, tipo, botones); } catch (e) { /* informativo */ }
                    }

                    // --- Por debajo del 80 %: nada que hacer ---
                    if (medida.porcentajeExacto < UMBRAL_AVISO) {
                        resolve(salida);
                        return;
                    }

                    // --- Entre 80 % y 100 %: solo aviso ---
                    if (medida.porcentajeExacto < UMBRAL_LLENO) {
                        salida.accion = 'aviso';
                        publicar(
                            'Almacenamiento local al ' + medida.porcentaje + ' % de tu límite (' + Math.round(medida.limiteMB) +
                            ' MB). Activa la nube o descarga un respaldo.',
                            'aviso'
                        );
                        resolve(salida);
                        return;
                    }

                    // --- 100 % o más: hace falta un respaldo antes de borrar ---
                    if (necesitaRespaldo()) {
                        salida.accion = 'requiere-respaldo';
                        publicar(
                            'Tu almacenamiento local está lleno: descarga un respaldo y luego se borrarán los registros más antiguos',
                            'error',
                            [{
                                texto: 'Descargar respaldo',
                                accion: function () {
                                    try {
                                        var respaldo = descargarRespaldo();   // ya marca 'respaldoHecho' si sale bien
                                        if (respaldo && respaldo.ok) {
                                            marcarRespaldoHecho();
                                            // Con el respaldo hecho, la política ya puede liberar espacio.
                                            setTimeout(function () {
                                                try { aplicarPoliticaAlmacenamiento(); } catch (e) { /* nada */ }
                                            }, 500);
                                        }
                                    } catch (e) { /* la descarga nunca debe romper la página */ }
                                }
                            }]
                        );
                        resolve(salida);
                        return;
                    }

                    // --- Ya hay respaldo: borrar lo más antiguo por lotes ---
                    var estado = { borrados: 0, liberadoBytes: 0, lotes: 0 };
                    borrarMasAntiguos(medida, estado, function (medidaFinal) {
                        function cerrar(exacta) {
                            try {
                                salida.porcentaje = exacta.porcentaje;
                                salida.localBytes = exacta.localBytes;
                                salida.historialBytes = exacta.historialBytes;
                                salida.limiteBytes = exacta.limiteBytes;
                                salida.borrados = estado.borrados;
                                salida.liberadoBytes = estado.liberadoBytes;

                                if (estado.borrados > 0) {
                                    salida.accion = 'recortado';
                                    var mb = (estado.liberadoBytes / 1048576).toFixed(2);
                                    publicar(
                                        'Se liberaron ' + mb + ' MB borrando los registros más antiguos (' + estado.borrados +
                                        '). Activa la nube para conservar todo tu historial.',
                                        'error'
                                    );
                                } else if (exacta.porcentajeExacto >= UMBRAL_LLENO) {
                                    salida.accion = 'lleno';
                                    publicar(
                                        'El almacenamiento local sigue al ' + exacta.porcentaje + ' % y no quedan registros antiguos que borrar. ' +
                                        'Descarga un respaldo y libera espacio, o activa la sincronización en la nube.',
                                        'error'
                                    );
                                } else if (exacta.porcentajeExacto >= UMBRAL_AVISO) {
                                    salida.accion = 'aviso';
                                    publicar(
                                        'Almacenamiento local al ' + exacta.porcentaje + ' % de tu límite (' + Math.round(exacta.limiteMB) +
                                        ' MB). Activa la nube o descarga un respaldo.',
                                        'aviso'
                                    );
                                }
                                resolve(salida);
                            } catch (e) {
                                base.accion = 'error';
                                base.aviso = mensajeDe(e);
                                resolve(base);
                            }
                        }

                        // Si no se borró nada, la medida que ya tenemos es la buena: no
                        // hace falta releer todo el historial otra vez.
                        if (estado.borrados === 0) { cerrar(medidaFinal); return; }
                        // Una sola medición exacta al terminar (no una por lote).
                        medirTodoAsync().then(cerrar).catch(function (e) {
                            base.accion = 'error';
                            base.aviso = mensajeDe(e);
                            resolve(base);
                        });
                    });
                }).catch(function (e) {
                    base.aviso = mensajeDe(e);
                    resolve(base);
                });
            } catch (e) {
                base.aviso = mensajeDe(e);
                resolve(base);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 14. Recorte del histórico de tasas                                 */
    /* ------------------------------------------------------------------ */

    /** Días que se conservan siempre en el histórico de tasas (suelo). */
    var TASAS_DIAS_MINIMO = 60;

    /** Días de la ventana de tendencia SELECCIONADA (pos_rate_trend_window). */
    function diasVentanaSeleccionada() {
        var POR_DEFECTO = 30;
        try {
            var crudo = localStorage.getItem('pos_rate_trend_window');
            if (crudo === null || String(crudo).trim() === '') return POR_DEFECTO;
            var texto = String(crudo).trim().toLowerCase();
            var numero = Number(texto);
            if (isFinite(numero) && numero > 0) return numero;
            // Formatos usados por el POS: '3d' (3 días) y '3w' (3 semanas).
            var m = texto.match(/^(\d+(?:[.,]\d+)?)\s*(d|dias|días|w|s|sem|semanas|m|mes|meses)$/);
            if (m) {
                var valor = Number(String(m[1]).replace(',', '.'));
                if (!isFinite(valor) || valor <= 0) return POR_DEFECTO;
                var unidad = m[2];
                if (unidad === 'w' || unidad === 's' || unidad === 'sem' || unidad === 'semanas') return valor * 7;
                if (unidad === 'm' || unidad === 'mes' || unidad === 'meses') return valor * 30;
                return valor;
            }
            return POR_DEFECTO;
        } catch (e) { return POR_DEFECTO; }
    }

    /**
     * Ventana más larga que ofrece la tendencia de tasas. El POS publica los días
     * de cada ventana del selector en `window.RATE_TREND_WINDOWS_DIAS`
     * (por ejemplo { '3d': 3, '3w': 21 }).
     * @returns {number} 0 si el POS no publicó nada.
     */
    function diasVentanaMasLarga() {
        var maximo = 0;
        try {
            var mapa = (typeof window !== 'undefined' && window) ? window.RATE_TREND_WINDOWS_DIAS : null;
            if (!mapa || typeof mapa !== 'object') return 0;
            var claves = Object.keys(mapa);
            for (var i = 0; i < claves.length; i++) {
                var dias = Number(mapa[claves[i]]);
                if (isFinite(dias) && dias > maximo) maximo = dias;
            }
        } catch (e) { /* nos quedamos con el suelo */ }
        return maximo;
    }

    /**
     * Días que se conservan en `pos_rate_history`. Nunca menos de 60, y siempre
     * al menos la ventana más larga disponible: la seleccionada, la más larga que
     * publique el POS, o el suelo de 60 días (60 es el máximo de los tres).
     * Así recortar con '3d' seleccionado no deja sin datos a las vistas mayores.
     * @returns {number}
     */
    function diasVentanaTendencias() {
        var dias = TASAS_DIAS_MINIMO;
        try {
            var seleccionada = diasVentanaSeleccionada();
            if (isFinite(seleccionada) && seleccionada > dias) dias = seleccionada;
        } catch (e) { /* seguimos con el suelo */ }
        try {
            var masLarga = diasVentanaMasLarga();
            if (isFinite(masLarga) && masLarga > dias) dias = masLarga;
        } catch (e) { /* seguimos con lo calculado */ }
        return dias;
    }

    /**
     * Deja en `pos_rate_history` solo las muestras dentro de la ventana que usa
     * la tendencia (ver diasVentanaTendencias(): 60 días como mínimo) y devuelve
     * cuántos puntos quitó. No cambia el formato del objeto: cada clave sigue
     * siendo lo que era (arreglo de muestras u otro valor intacto).
     * @returns {number}
     */
    function recortarHistorialTasas() {
        var quitados = 0;
        try {
            var historial = leerJSON('pos_rate_history', null);
            if (!historial || typeof historial !== 'object' ||
                Object.prototype.toString.call(historial) === '[object Array]') return 0;

            var corte = Date.now() - (diasVentanaTendencias() * 24 * 60 * 60 * 1000);
            var salida = {};
            var huboCambios = false;
            var claves = Object.keys(historial);

            for (var i = 0; i < claves.length; i++) {
                var serie = historial[claves[i]];
                if (Object.prototype.toString.call(serie) !== '[object Array]') {
                    salida[claves[i]] = serie;   // no se toca lo que no sea una serie
                    continue;
                }
                var conservados = [];
                for (var j = 0; j < serie.length; j++) {
                    var muestra = serie[j];
                    var t = (muestra && typeof muestra === 'object') ? valorFecha(muestra.t) : null;
                    if (t !== null && t >= corte) conservados.push(muestra);
                    else quitados++;
                }
                salida[claves[i]] = conservados;
                if (conservados.length !== serie.length) huboCambios = true;
            }

            if (!huboCambios) return 0;
            var escritura = guardarLocalSeguro('pos_rate_history', JSON.stringify(salida));
            if (!escritura || !escritura.ok) return 0;   // no se escribió: no se quitó nada de verdad
            return quitados;
        } catch (e) { return 0; }
    }

    /* ------------------------------------------------------------------ */
    /* 15. Marca de respaldo hecho                                        */
    /* ------------------------------------------------------------------ */

    /** Anota que ya se descargó un respaldo (con la fecha). */
    function marcarRespaldoHecho() {
        try {
            localStorage.setItem(CLAVE_RESPALDO_HECHO, new Date().toISOString());
            return true;
        } catch (e) {
            return false;
        }
    }

    /** ¿Falta descargar un respaldo en este equipo? */
    function necesitaRespaldo() {
        try {
            var valor = localStorage.getItem(CLAVE_RESPALDO_HECHO);
            return (valor === null || String(valor).trim() === '');
        } catch (e) {
            // Si no se puede leer localStorage, se pide respaldo (más seguro).
            return true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 16. Estado en lenguaje llano (para el cliente)                      */
    /* ------------------------------------------------------------------ */

    /** Porcentaje a partir del cual el estado se muestra como "Casi lleno". */
    var UMBRAL_SIMPLE_CASI = 80;

    /** Porcentaje a partir del cual el estado se muestra como "Lleno". */
    var UMBRAL_SIMPLE_LLENO = 100;

    /** Dos dígitos con cero delante (para DD/MM/AAAA). */
    function dosDigitos(n) {
        try {
            var v = String(Math.abs(Number(n) || 0));
            return v.length < 2 ? '0' + v : v;
        } catch (e) { return '00'; }
    }

    /**
     * Tamaño en palabras llanas: "12 MB", "1 GB", "menos de 1 MB".
     * @param {number} mb
     * @returns {string}
     */
    function formatearTamanoSimple(mb) {
        try {
            var n = Number(mb) || 0;
            if (n >= 1024) {
                var gb = Math.round((n / 1024) * 10) / 10;
                return ((gb % 1 === 0) ? String(Math.round(gb)) : gb.toFixed(1)) + ' GB';
            }
            if (n >= 1) return String(Math.round(n)) + ' MB';
            if (n > 0) return 'menos de 1 MB';
            return '0 MB';
        } catch (e) { return '0 MB'; }
    }

    /**
     * Fecha de la última copia de seguridad, en lenguaje llano:
     * "nunca" | "hoy" | "ayer" | "hace N días" (hasta 30) | "DD/MM/AAAA".
     * Los días se cuentan por día natural (no por horas), para que una copia de
     * anoche a las 23:50 no diga "hace 1 día" a las 00:10.
     * @returns {string}
     */
    function fechaUltimaCopia() {
        try {
            var marca = null;
            try { marca = localStorage.getItem(CLAVE_RESPALDO_HECHO); } catch (e) { marca = null; }
            if (marca === null || String(marca).trim() === '') return 'nunca';
            var ms = valorFecha(marca);
            if (ms === null) return 'nunca';

            var hoy = new Date();
            hoy.setHours(0, 0, 0, 0);
            var dia = new Date(ms);
            dia.setHours(0, 0, 0, 0);
            var dias = Math.round((hoy.getTime() - dia.getTime()) / 86400000);

            if (dias <= 0) return 'hoy';
            if (dias === 1) return 'ayer';
            if (dias <= 30) return 'hace ' + dias + ' días';

            var f = new Date(ms);
            return dosDigitos(f.getDate()) + '/' + dosDigitos(f.getMonth() + 1) + '/' + f.getFullYear();
        } catch (e) { return 'nunca'; }
    }

    /**
     * Estado del almacenamiento en lenguaje llano, para el panel visible.
     * @returns {{estado: string, texto: string, porcentaje: number, usadoMB: number, limiteMB: number, ultimaCopia: string}}
     *   estado: 'ok' (< 80 %) | 'casi' (80-99 %) | 'lleno' (>= 100 %)
     *   texto:  "12 MB de 1 GB usados · Todo en orden" / "· Casi lleno" / "· Lleno"
     */
    function estadoAlmacenamientoSimple() {
        var salida = {
            estado: 'ok',
            texto: '0 MB usados · Todo en orden',
            porcentaje: 0,
            usadoMB: 0,
            limiteMB: LIMITE_POR_DEFECTO_MB,
            ultimaCopia: 'nunca'
        };
        try {
            var medida = medirTodo();
            var usadoMB = medida.totalBytes / 1048576;
            var limiteMB = Number(medida.limiteMB) || LIMITE_POR_DEFECTO_MB;
            var porcentaje = Number(medida.porcentaje) || 0;

            var estado = 'ok';
            if (porcentaje >= UMBRAL_SIMPLE_LLENO) estado = 'lleno';
            else if (porcentaje >= UMBRAL_SIMPLE_CASI) estado = 'casi';
            var etiqueta = (estado === 'lleno') ? 'Lleno' : ((estado === 'casi') ? 'Casi lleno' : 'Todo en orden');

            salida.estado = estado;
            salida.porcentaje = porcentaje;
            salida.porcentajeExacto = medida.porcentajeExacto;
            salida.usadoMB = Math.round(usadoMB * 100) / 100;
            salida.limiteMB = limiteMB;
            salida.texto = formatearTamanoSimple(usadoMB) + ' de ' + formatearTamanoSimple(limiteMB) + ' usados · ' + etiqueta;
            salida.ultimaCopia = fechaUltimaCopia();
        } catch (e) {
            /* el panel muestra el estado por defecto en vez de romperse */
        }
        return salida;
    }

    /* ------------------------------------------------------------------ */
    /* Exposición pública                                                 */
    /* ------------------------------------------------------------------ */

    window.medirAlmacenamiento = medirAlmacenamiento;
    window.estimarCuota = estimarCuota;
    window.pedirPersistencia = pedirPersistencia;
    window.diagnosticoAlmacenamiento = diagnosticoAlmacenamiento;
    window.guardarLocalSeguro = guardarLocalSeguro;
    window.descargarRespaldo = descargarRespaldo;
    window.restaurarRespaldo = restaurarRespaldo;
    window.mostrarAvisoAlmacenamiento = mostrarAvisoAlmacenamiento;
    window.avisarSiLleno = avisarSiLleno;

    // Historial en IndexedDB (archivo histórico).
    window.ARCHIVAR_MESES = ARCHIVAR_MESES;
    window.abrirHistorial = abrirHistorial;
    window.guardarEnHistorial = guardarEnHistorial;
    window.contarHistorial = contarHistorial;
    window.leerHistorial = leerHistorial;
    window.borrarDelHistorial = borrarDelHistorial;
    window.tamanoHistorial = tamanoHistorial;
    window.historialDisponible = historialDisponible;

    // Límite local configurable y política de espacio.
    window.limiteLocalMB = limiteLocalMB;
    window.medirTodo = medirTodo;
    window.medirTodoAsync = medirTodoAsync;
    window.archivarVentasAntiguas = archivarVentasAntiguas;
    window.aplicarPoliticaAlmacenamiento = aplicarPoliticaAlmacenamiento;
    window.recortarHistorialTasas = recortarHistorialTasas;
    window.marcarRespaldoHecho = marcarRespaldoHecho;
    window.necesitaRespaldo = necesitaRespaldo;

    // Estado en lenguaje llano (panel visible del cliente).
    window.estadoAlmacenamientoSimple = estadoAlmacenamientoSimple;
    window.fechaUltimaCopia = fechaUltimaCopia;
})();
