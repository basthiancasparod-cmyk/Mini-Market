/* =====================================================================
   MOTOR_OPERACIONES_V1 (Fase B, etapa E1) — motor real, ámbito POS

   Implementa la E1 del diseño aprobado en DISENO_MOTOR_OPERACIONES.md
   (secciones 1, 3, 4, 5, 6, 8, 9, 10 y 11) SOLO para mini_market_pos.html.
   Los demás módulos (compras, inventario, cuentas, catálogo) siguen con el
   comportamiento clásico hasta que les toque su etapa.

   QUÉ HACE
   --------
   * Sustituye "subir el estado" (el arreglo completo de ventas) por "subir los
     hechos": cada venta es una OPERACIÓN inmutable con clave única.
   * La operación se escribe en una COLA DURABLE (disco) ANTES de tocar la red.
   * La subida es idempotente por clave: reintentar no duplica y nunca se pisa
     una operación ya escrita con contenido distinto.
   * Una ventana caliente de 30 días en el equipo permite vender sin internet.
   * El histórico viejo (ventas/historial) queda CONGELADO: el motor solo lo lee,
     nunca lo reescribe (decisión cerrada nº 1 del encargo).
   * Verificación posterior a la liberación: las claves liberadas hace menos de
     48 h se releen en la nube al arrancar; si no están, se vuelven a subir
     (decisión cerrada nº 3).

   CLAVE DE OPERACIÓN (decisión cerrada nº 2 — desviación declarada del §1.1)
   -------------------------------------------------------------------------
   El diseño §1.1 propone `ops/<tipo>/<deviceId>_<secuencia4>` y su §11.7 deja
   abierto el riesgo de que dos equipos con el mismo `deviceId` (respaldo
   restaurado) choquen de secuencia. El encargo cierra esa decisión: la clave
   lleva un `installId` de 4 caracteres persistido en el equipo
   (`localStorage.pos_install_id`). Por tanto la clave REAL es:

       ops/<tipo>/<deviceId>_<installId>_<secuencia4>

   Ejemplo: ops/venta/7K3F9QAB_K7M2_0007
   El `installId` viaja también dentro del valor (`installId`) para que un nodo
   leído suelto sea autocontenido. El simulador `pruebas_motor_operaciones.js`
   (T10) sigue comprobando la clave de DOS partes porque modela el DISEÑO, no el
   motor; por eso su 49/49 no cambia.

   OTRAS DESVIACIONES DECLARADAS (ninguna silenciosa)
   --------------------------------------------------
   1. `iniciar({ modoSync })` acepta DOS formas del interruptor, por comodidad:
      el booleano `true` (en la consola de Firebase el dueño solo cambia
      `false` -> `true`, igual que con `cloudSync`) y la cadena `'operaciones'`
      (forma canónica, con sitio para futuros modos: `'compras'`, etc.).
      CUALQUIER otro valor —`false`, `'clasico'`, ausente, un número, un texto
      distinto o un error de lectura— es modo clásico: `iniciar` NO ejecuta nada
      más (devuelve `{ activo:false, modo:'clasico' }` sin tocar disco, sin
      generar `installId` y sin leer la red). Es la garantía dura de que un
      cliente en modo clásico no nota absolutamente nada, y de que NUNCA se
      activa por accidente (ante duda, clásico: nunca al revés). Si `modoSync`
      no se pasa, el motor lo lee de `suscripcion/modoSync` (nodo ausente o error
      de lectura -> 'clasico', sin cachear el fallo).
   1b. PERMISO DE NUBE (`cloudSync`, que es lo que se cobra): con `modoSync` en
      'operaciones' pero SIN `suscripcion/cloudSync === true` el motor arranca
      igual, pero en MODO SOLO-LOCAL: `registrarOperacion`, la ventana caliente,
      `leerVentas` y la política de 1 GB siguen funcionando en el equipo,
      mientras que `vaciarCola()` no escribe NADA en la nube (ni `ops/*`, ni
      índices, ni `ventas/historial`) y devuelve `motivo:'sin-nube'`. Las
      operaciones quedan PENDIENTES en el equipo: nunca se pierden ni se liberan
      (nada se confirma, así que la liberación por antigüedad tampoco las toca),
      y se suben solas en el primer arranque con permiso. `cloudSync` se puede
      pasar explícito (costura de PRUEBA, como `modoSync`); si no se pasa, se
      lee de la nube por el mismo camino que el interruptor: nodo ausente, valor
      distinto de `true` o lectura fallida -> NO hay nube (nunca al revés).
      `estado()` lo refleja en `nube` y `modoLocal`.
   2. La comparación de conflicto del §1.4 (misma clave, contenido distinto) se
      hace SOLO en los reintentos (entradas con `intentos > 0`), que es el único
      caso en que el resultado del intento anterior es desconocido. El primer
      intento de una clave nueva sigue siendo UN solo `set()`, sin lectura
      previa, como pide el §1.5. En un reintento, si la clave ya está en la nube
      con el mismo contenido se marca `subida` SIN reescribir (ahorra escritura).
   3. El índice de agregados `ventas_idx` (§2) se escribe después de confirmar
      la venta y es "best effort": si falla NO se marca la operación como fallo
      (el índice es caché derivado, nunca fuente de verdad). Se puede apagar con
      `iniciar({ indiceVentas: false })`.
   4. La liberación de la ventana caliente usa un índice pequeño de
      confirmaciones (`confirmadas.json`) además del estado `subida` de la cola:
      la compactación de `cola.jsonl` (§3.3) borra las líneas `subida`, y sin ese
      índice se perdería la prueba de confirmación. Es un índice DERIVADO: si
      falta, la política es no liberar (conservador).
   5. `opciones.ahora` (ms) permite congelar el reloj del motor. Es una costura
      de PRUEBA (la usa `pruebas_motor_real.js` para poder tener operaciones de
      más de 30 días sin viajar en el tiempo). El POS nunca la pasa.
   6. Estado de las marcas de `sincronizacion.js` (§10.1): el motor NO llama a
      `marcarPendienteSync`. Expone `hayPendientes()` y es la PÁGINA la que
      refleja la cola en la marca del módulo; así el motor no depende de
      `sincronizacion.js` (que el encargo prohíbe tocar).
   7. En E1 la venta es el único tipo que el POS produce. El motor acepta los 6
      tipos del §1.1 (y los aplica a la ventana caliente), para que las etapas
      siguientes solo tengan que llamar a `registrarOperacion`.

   ÁMBITO Y LÍMITES
   ----------------
   * Autocontenido: IIFE, sin dependencias externas, todo en try/catch.
   * Almacén: OPFS (`cola.jsonl` + `caliente/`) con caída automática a
     IndexedDB si OPFS no existe o no deja escribir. Si no hay ninguno de los
     dos, `iniciar` devuelve `ok:false` y la página debe seguir en clásico: no
     se finge una durabilidad que no existe.
   * No escribe en `localStorage` más que `pos_install_id` (nuevo) y el
     contador `pos_last_sale_number` que ya usaba el POS.
   * No toca `ventas/historial`: solo `once('value')` de lectura.
   ===================================================================== */
(function () {
    'use strict';

    /* =================================================================
       0. Constantes
       ================================================================= */

    /** Versión del motor (no confundir con `version` de cada operación). */
    var VERSION_MOTOR = 1;

    /** Versión del formato del payload de una operación (§1.2). */
    var VERSION_OPERACION = 1;

    /** Días que el equipo conserva en la ventana caliente (§4). */
    var DIAS_VENTANA_CALIENTE = 30;

    var MS_DIA = 24 * 60 * 60 * 1000;

    /** Ventana de reverificación de las claves liberadas (decisión cerrada nº 3). */
    var MS_LIBERADAS = 48 * 60 * 60 * 1000;

    /** Una entrada `subiendo` más vieja que esto es de una pestaña muerta (§5). */
    var MS_SUBIENDO_HUERFANA = 2 * 60 * 1000;

    /** Una entrada `subiendo` de OTRA pestaña más nueva que esto bloquea el vaciado. */
    var MS_BLOQUEO_VIVO = 2 * 60 * 1000;

    /** Tamaño de página por defecto del histórico bajo demanda (§6). */
    var TAMANO_PAGINA = 200;

    /** Tope de páginas por consulta: una consulta no puede colgar la interfaz. */
    var MAX_PAGINAS = 50;

    /** Claves de localStorage (las de siempre + la nueva del installId). */
    var CLAVE_INSTALL_ID = 'pos_install_id';
    var CLAVE_SECUENCIA = 'pos_last_sale_number';
    var CLAVE_DEVICE_ID = 'pos_device_id';

    /** Archivos del almacén del motor. */
    var ARCHIVO_COLA = 'cola.jsonl';
    var ARCHIVO_CONFIRMADAS = 'confirmadas.json';
    var ARCHIVO_LIBERADAS = 'liberadas.json';
    var ARCHIVO_BLOQUEO = 'bloqueo.json';

    /** Tipos de operación admitidos (§1.1). */
    var TIPOS = ['venta', 'compra', 'movimiento', 'cliente', 'cuenta', 'producto'];

    /** Tipos que van al log de la ventana caliente (append-only, §4). */
    var LOG_CALIENTE = {
        venta: 'caliente/ventas.jsonl',
        compra: 'caliente/compras.jsonl',
        movimiento: 'caliente/movimientos.jsonl'
    };

    /** Tipos que van a un documento por clave natural (§4 y §7). */
    var DOC_CALIENTE = {
        producto: 'caliente/productos.json',
        cliente: 'caliente/clientes.json',
        cuenta: 'caliente/cuentas.json'
    };

    /** Tope de entradas del registro de liberadas recientes (se poda a las 48 h). */
    var MAX_LIBERADAS = 5000;

    /** Umbrales de compactación de la cola (§3.3). */
    var COLA_MIN_LINEAS = 200;

    /* =================================================================
       1. Estado del módulo (una sola sesión de motor por página)
       ================================================================= */

    var _activo = false;            // true solo con modo 'operaciones' y almacén durable
    var _modo = 'clasico';          // 'clasico' | 'operaciones'
    var _motivoInactivo = '';
    var _deviceId = '';
    var _installId = '';
    var _emailPath = '';
    var _operador = '';
    var _db = null;                 // SDK de Firebase v8 (o mock con la misma forma)
    var _almacen = null;            // adaptador de archivos (OPFS | IndexedDB | inyectado)
    var _almacenTipo = '';
    var _indiceVentas = true;
    var _nube = false;              // permiso de nube EFECTIVO (cloudSync + SDK + ruta)
    var _ahoraFijo = 0;             // costura de prueba: reloj congelado

    var _cola = {};                 // clave -> entrada (fuente en memoria, espejo del archivo)
    var _colaLineas = 0;            // líneas del archivo (para decidir la compactación)
    var _colaLineasSubida = 0;      // líneas cuyo estado es `subida`
    var _confirmadas = {};          // clave -> { fechaISO, ts } (índice derivado)
    var _liberadas = [];            // registro de liberadas recientes (48 h)
    var _caliente = {};             // tipo -> mapa clave -> operación (caché en memoria)
    var _ultimaSecuencia = 0;
    var _idPestana = '';
    var _bloqueo = null;            // { id, ts } leído al arrancar
    var _vaciando = null;           // promesa del vaciado en curso (mutex)
    var _iniciando = null;
    var _ultimoError = '';
    var _subidasSesion = 0;
    var _ultimaVerificacion = null;
    var _estadoLiberadas = { revisadas: 0, faltantes: 0, resubidas: 0, fallidas: 0 };

    /* =================================================================
       2. Utilidades básicas (todo dentro de try/catch)
       ================================================================= */

    /** Reloj del motor: `Date.now()`, o el congelado de las pruebas. */
    function reloj() {
        try { return _ahoraFijo > 0 ? _ahoraFijo : Date.now(); } catch (e) { return 0; }
    }

    function iso(ms) {
        try { return new Date(Number(ms) || 0).toISOString(); } catch (e) { return '1970-01-01T00:00:00.000Z'; }
    }

    /** ISO -> ms. Devuelve NaN si no es una fecha legible. */
    function aMs(valor) {
        try {
            if (typeof valor === 'number' && isFinite(valor)) return valor;
            if (valor instanceof Date) return valor.getTime();
            var t = Date.parse(String(valor));
            return isNaN(t) ? NaN : t;
        } catch (e) { return NaN; }
    }

    /** Copia profunda por JSON. De paso elimina `undefined` (RTDB los rechaza). */
    function clonar(v) {
        try {
            if (v === undefined) return null;
            return JSON.parse(JSON.stringify(v));
        } catch (e) { return null; }
    }

    /** Comparación profunda (para la idempotencia por clave, §1.4). */
    function iguales(a, b) {
        try {
            if (a === b) return true;
            if (typeof a !== typeof b) return false;
            if (a === null || b === null || typeof a !== 'object') return false;
            if (Array.isArray(a) !== Array.isArray(b)) return false;
            var ka = Object.keys(a), kb = Object.keys(b);
            if (ka.length !== kb.length) return false;
            for (var i = 0; i < ka.length; i++) {
                if (!iguales(a[ka[i]], b[ka[i]])) return false;
            }
            return true;
        } catch (e) { return false; }
    }

    function pad4(n) {
        try {
            var s = String(Math.abs(parseInt(n, 10) || 0));
            while (s.length < 4) s = '0' + s;
            return s;
        } catch (e) { return '0000'; }
    }

    function avisar(mensaje) {
        try { if (typeof console !== 'undefined' && console.warn) console.warn('[motor_operaciones] ' + mensaje); } catch (e) { /* nada */ }
    }

    function anotarError(e, contexto) {
        var texto;
        try {
            texto = (e && (e.code || e.message)) ? String(e.code || e.message) : String(e);
        } catch (e2) { texto = 'error desconocido'; }
        _ultimoError = (contexto ? contexto + ': ' : '') + texto;
        avisar(_ultimoError);
        return _ultimoError;
    }

    /* --- localStorage protegido (puede lanzar en modo privado) --- */

    function leerLocal(clave) {
        try { return localStorage.getItem(clave); } catch (e) { return null; }
    }

    function escribirLocal(clave, valor) {
        try { localStorage.setItem(clave, String(valor)); return true; } catch (e) { return false; }
    }

    /* =================================================================
       3. Almacén: OPFS con caída automática a IndexedDB
       =================================================================
       API interna (la misma en las dos implementaciones y en un almacén
       inyectado desde las pruebas):

         leerTexto(nombre)            -> Promise<string|null>
         escribirTexto(nombre, txt)   -> Promise<boolean>   (flush antes de resolver)
         anexarTexto(nombre, txt)     -> Promise<boolean>   (append + flush)
         borrar(nombre)               -> Promise<boolean>
         tipo                         -> 'opfs' | 'indexeddb' | 'inyectado'

       `nombre` puede llevar una carpeta ('caliente/ventas.jsonl').
       ================================================================= */

    function partesDeRuta(nombre) {
        return String(nombre || '').split('/').filter(function (p) { return p !== ''; });
    }

    /** Implementación sobre OPFS (`navigator.storage.getDirectory()`). */
    function crearAlmacenOPFS() {
        try {
            if (typeof navigator === 'undefined' || !navigator.storage) return null;
            if (typeof navigator.storage.getDirectory !== 'function') return null;
        } catch (e) { return null; }

        /** Carpeta raíz de OPFS (se pide una vez y se recuerda). */
        var raiz = null;
        async function obtenerRaiz() {
            if (raiz) return raiz;
            raiz = await navigator.storage.getDirectory();
            return raiz;
        }

        /** Carpeta intermedia, creándola si hace falta. */
        async function carpetaDe(partes, crear) {
            var dir = await obtenerRaiz();
            for (var i = 0; i < partes.length - 1; i++) {
                dir = await dir.getDirectoryHandle(partes[i], { create: !!crear });
            }
            return dir;
        }

        /** Manejador del archivo, o null si no existe y `crear` es false. */
        async function archivoDe(nombre, crear) {
            var partes = partesDeRuta(nombre);
            if (!partes.length) return null;
            var dir = await carpetaDe(partes, crear);
            try {
                return await dir.getFileHandle(partes[partes.length - 1], { create: !!crear });
            } catch (e) {
                if (crear) throw e;
                return null;
            }
        }

        return {
            tipo: 'opfs',
            async leerTexto(nombre) {
                try {
                    var fh = await archivoDe(nombre, false);
                    if (!fh) return null;
                    var f = await fh.getFile();
                    return await f.text();
                } catch (e) { return null; }
            },
            async escribirTexto(nombre, texto) {
                try {
                    var fh = await archivoDe(nombre, true);
                    var w = await fh.createWritable();
                    await w.write(String(texto));
                    await w.close();          // close() es el "flush" a disco
                    return true;
                } catch (e) {
                    anotarError(e, 'opfs.escribir(' + nombre + ')');
                    return false;
                }
            },
            async anexarTexto(nombre, texto) {
                try {
                    var fh = await archivoDe(nombre, true);
                    var tam = 0;
                    try { var f = await fh.getFile(); tam = Number(f.size) || 0; } catch (e) { tam = 0; }
                    if (tam > 0) {
                        // Camino real de OPFS: abrir conservando lo que hay y escribir al final.
                        var w = await fh.createWritable({ keepExistingData: true });
                        if (typeof w.seek === 'function') await w.seek(tam);
                        await w.write(String(texto));
                        await w.close();
                        return true;
                    }
                    // Archivo nuevo: escritura directa.
                    var w2 = await fh.createWritable();
                    await w2.write(String(texto));
                    await w2.close();
                    return true;
                } catch (e) {
                    // Sin `keepExistingData` (navegadores viejos): leer + concatenar + escribir.
                    try {
                        var previo = await this.leerTexto(nombre);
                        var fh2 = await archivoDe(nombre, true);
                        var w3 = await fh2.createWritable();
                        await w3.write((previo || '') + String(texto));
                        await w3.close();
                        return true;
                    } catch (e2) {
                        anotarError(e2, 'opfs.anexar(' + nombre + ')');
                        return false;
                    }
                }
            },
            async borrar(nombre) {
                try {
                    var partes = partesDeRuta(nombre);
                    if (!partes.length) return false;
                    var dir = await carpetaDe(partes, false);
                    await dir.removeEntry(partes[partes.length - 1]);
                    return true;
                } catch (e) { return false; }
            }
        };
    }

    /** Implementación sobre IndexedDB (un almacén clave -> texto, plano). */
    function crearAlmacenIndexedDB() {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') return null;
        } catch (e) { return null; }

        var NOMBRE_DB = 'motor_operaciones_e1';
        var ALMACEN = 'archivos';
        var db = null;
        var abriendo = null;

        function abrir() {
            if (db) return Promise.resolve(db);
            if (abriendo) return abriendo;
            abriendo = new Promise(function (resolve) {
                try {
                    var req = indexedDB.open(NOMBRE_DB, 1);
                    req.onupgradeneeded = function () {
                        try {
                            var r = req.result;
                            if (!r.objectStoreNames.contains(ALMACEN)) r.createObjectStore(ALMACEN);
                        } catch (e) { /* nada */ }
                    };
                    req.onsuccess = function () { db = req.result; resolve(db); };
                    req.onerror = function () { resolve(null); };
                    req.onblocked = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
            return abriendo;
        }

        function leerClave(clave) {
            return abrir().then(function (d) {
                return new Promise(function (resolve) {
                    if (!d) return resolve(null);
                    try {
                        var tx = d.transaction(ALMACEN, 'readonly');
                        var r = tx.objectStore(ALMACEN).get(clave);
                        r.onsuccess = function () { resolve(r.result === undefined ? null : r.result); };
                        r.onerror = function () { resolve(null); };
                    } catch (e) { resolve(null); }
                });
            });
        }

        function escribirClave(clave, texto) {
            return abrir().then(function (d) {
                return new Promise(function (resolve) {
                    if (!d) return resolve(false);
                    try {
                        var tx = d.transaction(ALMACEN, 'readwrite');
                        tx.objectStore(ALMACEN).put(String(texto), clave);
                        tx.oncomplete = function () { resolve(true); };
                        tx.onerror = function () { resolve(false); };
                        tx.onabort = function () { resolve(false); };
                    } catch (e) { resolve(false); }
                });
            });
        }

        return {
            tipo: 'indexeddb',
            async leerTexto(nombre) {
                try {
                    var v = await leerClave(String(nombre));
                    return (v === null || v === undefined) ? null : String(v);
                } catch (e) { return null; }
            },
            async escribirTexto(nombre, texto) {
                try {
                    var ok = await escribirClave(String(nombre), String(texto));
                    if (!ok) anotarError(new Error('escritura rechazada'), 'idb.escribir(' + nombre + ')');
                    return ok;
                } catch (e) { anotarError(e, 'idb.escribir(' + nombre + ')'); return false; }
            },
            async anexarTexto(nombre, texto) {
                try {
                    var previo = await this.leerTexto(nombre);
                    return await this.escribirTexto(nombre, (previo || '') + String(texto));
                } catch (e) { anotarError(e, 'idb.anexar(' + nombre + ')'); return false; }
            },
            async borrar(nombre) {
                try {
                    var d = await abrir();
                    if (!d) return false;
                    return await new Promise(function (resolve) {
                        try {
                            var tx = d.transaction(ALMACEN, 'readwrite');
                            tx.objectStore(ALMACEN).delete(String(nombre));
                            tx.oncomplete = function () { resolve(true); };
                            tx.onerror = function () { resolve(false); };
                        } catch (e) { resolve(false); }
                    });
                } catch (e) { return false; }
            }
        };
    }

    /**
     * Elige el almacén: el inyectado (pruebas), si no OPFS, si no IndexedDB.
     * Se comprueba ESCRIBIENDO de verdad: un almacén que no deja escribir es
     * tan inútil como uno que no existe, y el motor no puede fingir durabilidad.
     */
    async function elegirAlmacen(inyectado) {
        try {
            if (inyectado && typeof inyectado.leerTexto === 'function' &&
                typeof inyectado.escribirTexto === 'function' &&
                typeof inyectado.anexarTexto === 'function') {
                if (!inyectado.tipo) inyectado.tipo = 'inyectado';
                return inyectado;
            }
        } catch (e) { /* se sigue con la detección normal */ }

        try {
            var opfs = crearAlmacenOPFS();
            if (opfs) {
                var prueba = await opfs.escribirTexto('prueba_escritura.txt', 'ok');
                if (prueba) return opfs;
            }
        } catch (e) { /* OPFS no sirve: se cae a IndexedDB */ }

        try {
            var idb = crearAlmacenIndexedDB();
            if (idb) {
                var prueba2 = await idb.escribirTexto('prueba_escritura.txt', 'ok');
                if (prueba2) return idb;
            }
        } catch (e) { /* tampoco hay IndexedDB */ }

        return null;
    }

    /* --- operaciones de archivo de alto nivel (líneas y JSON) --- */

    /** Lee un archivo y devuelve sus líneas no vacías (tolerante a basura). */
    async function leerLineas(nombre) {
        try {
            var texto = await _almacen.leerTexto(nombre);
            if (!texto) return [];
            var partes = String(texto).split('\n');
            var salida = [];
            for (var i = 0; i < partes.length; i++) {
                var l = partes[i].replace(/\r/g, '').trim();
                if (l) salida.push(l);
            }
            return salida;
        } catch (e) { return []; }
    }

    /** Objetos JSON de un archivo .jsonl (las líneas rotas se descartan y se avisa). */
    async function leerObjetos(nombre) {
        var lineas = await leerLineas(nombre);
        var salida = [];
        for (var i = 0; i < lineas.length; i++) {
            try { salida.push(JSON.parse(lineas[i])); }
            catch (e) { avisar('línea ilegible en ' + nombre + ' (se ignora): ' + lineas[i].slice(0, 120)); }
        }
        return salida;
    }

    /** Añade una línea JSON al final del archivo y espera al flush. */
    async function anexarLinea(nombre, objeto) {
        try {
            var linea = JSON.stringify(objeto);
            if (linea === undefined) return false;
            return await _almacen.anexarTexto(nombre, linea + '\n');
        } catch (e) { anotarError(e, 'anexar(' + nombre + ')'); return false; }
    }

    /** Reescribe un archivo JSON completo (documentos pequeños). */
    async function escribirJson(nombre, objeto) {
        try { return await _almacen.escribirTexto(nombre, JSON.stringify(objeto)); }
        catch (e) { anotarError(e, 'escribir(' + nombre + ')'); return false; }
    }

    /** Lee un archivo JSON completo; devuelve `porDefecto` si no se puede. */
    async function leerJson(nombre, porDefecto) {
        try {
            var texto = await _almacen.leerTexto(nombre);
            if (!texto) return porDefecto;
            var v = JSON.parse(texto);
            return (v === null || v === undefined) ? porDefecto : v;
        } catch (e) { avisar('JSON ilegible en ' + nombre + ': ' + (e && e.message)); return porDefecto; }
    }

    /* =================================================================
       4. Secuencia, id y clave de operación
       ================================================================= */

    /** Siguiente número de la serie del equipo (`pos_last_sale_number`). */
    function reservarSecuencia() {
        var actual = parseInt(leerLocal(CLAVE_SECUENCIA) || '0', 10);
        if (!isFinite(actual) || actual < 0) actual = 0;
        if (actual < _ultimaSecuencia) actual = _ultimaSecuencia;
        var siguiente = actual + 1;
        escribirLocal(CLAVE_SECUENCIA, siguiente);
        _ultimaSecuencia = siguiente;
        return siguiente;
    }

    /**
     * Secuencia de una venta: es el número que el POS ya reservó en el id
     * `V-LOCAL-<deviceId>-<n>` (§10.2). Si el id no tiene esa forma, se toma la
     * siguiente de la serie (y se avanza el contador).
     */
    function secuenciaDesdeIdVenta(id, deviceId) {
        try {
            var m = /^V-LOCAL-(.+)-(\d+)$/.exec(String(id || ''));
            if (!m) return 0;
            if (String(m[1]) !== String(deviceId)) return 0;   // de otro equipo: no se toca
            var n = parseInt(m[2], 10);
            return (isFinite(n) && n > 0) ? n : 0;
        } catch (e) { return 0; }
    }

    /** `<deviceId>_<installId>_<secuencia4>`: clave de idempotencia y de la ruta. */
    function nombreNodo(op) {
        try {
            return String(op.deviceId) + '_' + String(op.installId) + '_' + pad4(op.secuencia);
        } catch (e) { return 'desconocido'; }
    }

    function claveDeOperacion(op) {
        return String(op.tipo) + '/' + nombreNodo(op);
    }

    function rutaDeOperacion(op) {
        return 'BBDD/' + _emailPath + '/ops/' + claveDeOperacion(op);
    }

    function rutaIndice(op) {
        try {
            var dia = String(op.fechaISO).slice(0, 10);
            return 'BBDD/' + _emailPath + '/ventas_idx/' + dia + '/' + nombreNodo(op);
        } catch (e) { return null; }
    }

    /* =================================================================
       5. Cola durable (§3)
       ================================================================= */

    /**
     * Pliega las líneas del archivo en entradas. La cola es append-only: la
     * ÚLTIMA línea de una clave manda, y el `payload` puede venir de cualquier
     * línea anterior de la misma clave (§3.1 y §3.3).
     */
    function plegarCola(objetos) {
        var mapa = {};
        var subidas = 0;
        for (var i = 0; i < objetos.length; i++) {
            var o = objetos[i];
            if (!o || !o.clave) continue;
            var clave = String(o.clave);
            var e = mapa[clave];
            if (!e) {
                e = { clave: clave, nodo: '', tipo: '', payload: null, estado: 'pendiente', intentos: 0, ts: '', tsEstado: '', error: '' };
                mapa[clave] = e;
            }
            if (o.tipo) e.tipo = String(o.tipo);
            if (o.payload) e.payload = o.payload;
            if (o.estado) { e.estado = String(o.estado); e.tsEstado = o.ts || e.tsEstado; }
            if (typeof o.intentos === 'number' && isFinite(o.intentos)) e.intentos = o.intentos;
            if (o.ts) e.ts = e.ts || o.ts;
            if (o.error) e.error = String(o.error);
            else if (o.estado && o.estado !== 'fallo') e.error = '';
        }
        for (var k in mapa) {
            if (!Object.prototype.hasOwnProperty.call(mapa, k)) continue;
            var ent = mapa[k];
            if (!ent.nodo && ent.payload) ent.nodo = nombreNodo(ent.payload);
            if (!ent.tipo && ent.payload) ent.tipo = String(ent.payload.tipo || '');
            if (ent.estado === 'subida') subidas++;
        }
        return { mapa: mapa, subidas: subidas, lineas: objetos.length };
    }

    function entradasCola() {
        var lista = [];
        for (var k in _cola) {
            if (Object.prototype.hasOwnProperty.call(_cola, k)) lista.push(_cola[k]);
        }
        return lista;
    }

    /** Orden de subida: por secuencia del equipo (§3.2.4 y §5). */
    function entradasEnOrden() {
        var lista = entradasCola().filter(function (e) {
            return e.estado === 'pendiente' || e.estado === 'subiendo' || e.estado === 'fallo';
        });
        lista.sort(function (a, b) {
            var sa = Number(a.payload && a.payload.secuencia) || 0;
            var sb = Number(b.payload && b.payload.secuencia) || 0;
            return sa - sb;
        });
        return lista;
    }

    function contarEstadosCola() {
        var c = { pendiente: 0, subiendo: 0, subida: 0, fallo: 0, conflicto: 0, total: 0 };
        for (var k in _cola) {
            if (!Object.prototype.hasOwnProperty.call(_cola, k)) continue;
            var e = _cola[k];
            c.total++;
            if (c[e.estado] === undefined) c[e.estado] = 0;
            c[e.estado]++;
        }
        return c;
    }

    /**
     * Cambia el estado de una entrada: se AÑADE una línea nueva (append-only) y
     * se espera al flush. La línea de estado no repite el payload (§3.3).
     */
    async function marcarEntrada(clave, estado, extras) {
        var e = _cola[clave];
        if (!e) return false;
        var linea = { clave: clave, estado: estado, intentos: e.intentos, ts: iso(reloj()) };
        if (extras && extras.error) linea.error = String(extras.error);
        var ok = await anexarLinea(ARCHIVO_COLA, linea);
        if (!ok) return false;
        var previo = e.estado;
        e.estado = estado;
        e.tsEstado = linea.ts;
        if (extras && extras.intentos !== undefined) e.intentos = extras.intentos;
        if (extras && extras.error) e.error = String(extras.error);
        else if (estado !== 'fallo') e.error = '';
        _colaLineas++;
        if (estado === 'subida') _colaLineasSubida++;
        if (previo === 'subida' && estado !== 'subida') _colaLineasSubida = Math.max(0, _colaLineasSubida - 1);
        return true;
    }

    /** Todas las claves cuyo estado actual es `subida` (prueba de confirmación). */
    function estaConfirmadaEnCola(clave) {
        var e = _cola[clave];
        return !!(e && e.estado === 'subida');
    }

    function confirmada(clave) {
        return !!(_confirmadas[clave] || estaConfirmadaEnCola(clave));
    }

    /**
     * Compactación (§3.3): reescribe el archivo dejando SOLO las líneas vivas.
     * Antes de reescribir se vuelve a leer del disco para no perder lo que haya
     * añadido otra pestaña (§11.7).
     */
    async function compactarCola(siFuerza) {
        try {
            var recientes = plegarCola(await leerObjetos(ARCHIVO_COLA));
            var vivas = [];
            for (var k in recientes.mapa) {
                if (!Object.prototype.hasOwnProperty.call(recientes.mapa, k)) continue;
                var e = recientes.mapa[k];
                if (e.estado !== 'subida') vivas.push(e);
                else if (!_confirmadas[k]) _confirmadas[k] = { fechaISO: (e.payload && e.payload.fechaISO) || e.ts, ts: iso(reloj()) };
            }
            var proporcion = recientes.lineas > 0 ? (recientes.lineas - vivas.length) / recientes.lineas : 0;
            if (!siFuerza && !(recientes.lineas > COLA_MIN_LINEAS && proporcion > 0.5)) return { compactada: false, lineas: recientes.lineas, vivas: vivas.length };

            var texto = '';
            for (var i = 0; i < vivas.length; i++) {
                texto += JSON.stringify({ clave: vivas[i].clave, tipo: vivas[i].tipo, payload: vivas[i].payload, estado: vivas[i].estado, intentos: vivas[i].intentos, ts: vivas[i].ts, error: vivas[i].error || undefined }) + '\n';
            }
            var ok = await _almacen.escribirTexto(ARCHIVO_COLA, texto);
            if (!ok) { avisar('no se pudo compactar la cola: se sigue con el archivo anterior'); return { compactada: false, lineas: recientes.lineas, vivas: vivas.length }; }
            _cola = recientes.mapa;
            // Se descartan de memoria las entradas `subida` (ya no están en el archivo).
            for (var k2 in _cola) {
                if (!Object.prototype.hasOwnProperty.call(_cola, k2)) continue;
                if (_cola[k2].estado === 'subida') delete _cola[k2];
            }
            _colaLineas = vivas.length;
            _colaLineasSubida = 0;
            await guardarConfirmadas();
            return { compactada: true, lineas: vivas.length, vivas: vivas.length };
        } catch (e) {
            anotarError(e, 'compactarCola');
            return { compactada: false, lineas: _colaLineas, vivas: entradasCola().length };
        }
    }

    async function guardarConfirmadas() {
        // Poda: no se guarda para siempre lo que ya se liberó.
        var salida = {};
        for (var k in _confirmadas) {
            if (Object.prototype.hasOwnProperty.call(_confirmadas, k)) salida[k] = _confirmadas[k];
        }
        return await escribirJson(ARCHIVO_CONFIRMADAS, salida);
    }

    /** Marca `subiendo` huérfana (la pestaña murió a mitad de subida) -> `pendiente`. */
    async function recuperarHuerfanos() {
        var ahora = reloj();
        var lista = entradasCola();
        for (var i = 0; i < lista.length; i++) {
            var e = lista[i];
            if (e.estado !== 'subiendo') continue;
            var t = aMs(e.tsEstado);
            if (!isNaN(t) && (ahora - t) < MS_SUBIENDO_HUERFANA) continue;
            await marcarEntrada(e.clave, 'pendiente', {});
            avisar('entrada ' + e.clave + ' quedó a medias: vuelve a pendiente');
        }
    }

    /* =================================================================
       6. Ventana caliente (§4)
       ================================================================= */

    /** Mapa clave -> operación de un log de la ventana caliente. */
    async function cargarCalienteLog(tipo) {
        if (_caliente[tipo]) return _caliente[tipo];
        var mapa = {};
        var objetos = await leerObjetos(LOG_CALIENTE[tipo]);
        for (var i = 0; i < objetos.length; i++) {
            var o = objetos[i];
            if (o && o.clave && o.op) mapa[String(o.clave)] = o.op;
        }
        _caliente[tipo] = mapa;
        return mapa;
    }

    /** Fusiona por campo un documento (producto/cliente/cuenta), §7.2 y §7.3. */
    function fusionarPorCampo(localDoc, payload, fechaISO) {
        var base = clonar(localDoc) || {};
        if (payload && payload.fijos) {
            for (var f in payload.fijos) {
                if (Object.prototype.hasOwnProperty.call(payload.fijos, f)) base[f] = clonar(payload.fijos[f]);
            }
        }
        var mt = clonar(base.camposMtime) || {};
        var campo = (payload && payload.campo) ? String(payload.campo) : '';
        if (campo) {
            var mtLocal = mt[campo] || base.mtime || '1970-01-01T00:00:00.000Z';
            if (String(fechaISO) >= String(mtLocal)) {
                base[campo] = clonar(payload.valor);
                mt[campo] = fechaISO;
            }
        }
        base.camposMtime = mt;
        base.mtime = (String(fechaISO) > String(base.mtime || '')) ? fechaISO : (base.mtime || fechaISO);
        return base;
    }

    /** Aplica una operación a la ventana caliente (paso 2 del ciclo, §5). */
    async function aplicarACaliente(entrada) {
        var op = entrada.payload;
        try {
            if (LOG_CALIENTE[op.tipo]) {
                var mapa = await cargarCalienteLog(op.tipo);
                if (mapa[entrada.clave]) return true;              // ya estaba: no se repite
                mapa[entrada.clave] = op;
                return await anexarLinea(LOG_CALIENTE[op.tipo], { clave: entrada.clave, op: op });
            }
            if (DOC_CALIENTE[op.tipo]) {
                var docs = await leerJson(DOC_CALIENTE[op.tipo], {}) || {};
                var claveDoc = (op.payload && (op.payload.id || op.payload.clave))
                    ? String(op.payload.id || op.payload.clave)
                    : entrada.clave;
                docs[claveDoc] = fusionarPorCampo(docs[claveDoc], op.payload, op.fechaISO);
                return await escribirJson(DOC_CALIENTE[op.tipo], docs);
            }
            return false;
        } catch (e) { anotarError(e, 'aplicarACaliente(' + op.tipo + ')'); return false; }
    }

    /** Reescribe el log de la ventana caliente sin las claves indicadas. */
    async function recortarCalienteLog(tipo, clavesFuera) {
        var mapa = await cargarCalienteLog(tipo);
        var texto = '';
        var quedan = {};
        for (var k in mapa) {
            if (!Object.prototype.hasOwnProperty.call(mapa, k)) continue;
            if (clavesFuera[k]) continue;
            quedan[k] = mapa[k];
            texto += JSON.stringify({ clave: k, op: mapa[k] }) + '\n';
        }
        var ok = await _almacen.escribirTexto(LOG_CALIENTE[tipo], texto);
        if (ok) _caliente[tipo] = quedan;
        return ok;
    }

    /* =================================================================
       7. Liberación y verificación posterior (§5 paso 8 y §11.1)
       ================================================================= */

    function cargarLiberadas() {
        try {
            var lista = Array.isArray(_liberadas) ? _liberadas : [];
            var ahora = reloj();
            var vivas = [];
            for (var i = 0; i < lista.length; i++) {
                var l = lista[i];
                if (!l || !l.clave || !l.op) continue;
                var t = aMs(l.liberadaEn);
                if (isNaN(t) || (ahora - t) > MS_LIBERADAS) continue;   // poda de las 48 h
                vivas.push(l);
            }
            // Tope duro: el registro nunca puede crecer sin control.
            if (vivas.length > MAX_LIBERADAS) vivas = vivas.slice(vivas.length - MAX_LIBERADAS);
            var podadas = lista.length - vivas.length;
            _liberadas = vivas;
            return podadas;
        } catch (e) { return 0; }
    }

    /**
     * Libera de la ventana caliente SOLO lo confirmado con más de 30 días
     * (§5 paso 8). Cada liberación se anota en el registro de liberadas
     * recientes, que es lo que permite la reverificación de las 48 h.
     */
    async function liberarCaliente() {
        var liberadas = [];
        var ahora = reloj();
        var tipos = ['venta', 'compra', 'movimiento'];
        for (var i = 0; i < tipos.length; i++) {
            var tipo = tipos[i];
            var mapa = await cargarCalienteLog(tipo);
            var fuera = {};
            for (var k in mapa) {
                if (!Object.prototype.hasOwnProperty.call(mapa, k)) continue;
                var op = mapa[k];
                var t = aMs(op.fechaISO);
                var vieja = !isNaN(t) && (ahora - t) > DIAS_VENTANA_CALIENTE * MS_DIA;
                if (vieja && confirmada(k)) {
                    liberadas.push({ clave: k, op: op, liberadaEn: iso(ahora), verificadaEn: '' });
                    fuera[k] = true;
                    delete _confirmadas[k];
                }
            }
            if (Object.keys(fuera).length) await recortarCalienteLog(tipo, fuera);
        }
        if (liberadas.length) {
            for (var j = 0; j < liberadas.length; j++) _liberadas.push(liberadas[j]);
            cargarLiberadas();
            await escribirJson(ARCHIVO_LIBERADAS, _liberadas);
            await guardarConfirmadas();
        }
        return liberadas;
    }

    /**
     * Decisión cerrada nº 3: durante las 48 h siguientes a la liberación, al
     * arrancar se releen esas claves en la nube y, si alguna no está, se vuelve
     * a subir (y se avisa si vuelve a fallar).
     */
    async function verificarLiberadasRecientes() {
        var r = { revisadas: 0, presentes: 0, faltantes: 0, resubidas: 0, fallidas: 0, podadas: 0 };
        try {
            r.podadas = cargarLiberadas();
            if (!_liberadas.length) {
                // Si la poda dejó el registro vacío, se reescribe para no repetirla.
                if (r.podadas > 0) await escribirJson(ARCHIVO_LIBERADAS, _liberadas);
                _ultimaVerificacion = r;
                return r;
            }
            if (!_nube || !_db || !_emailPath) {
                if (r.podadas > 0) await escribirJson(ARCHIVO_LIBERADAS, _liberadas);
                avisar('no se pueden verificar las liberadas recientes: sin nube');
                _ultimaVerificacion = r;
                return r;
            }
            var huboCambio = r.podadas > 0;
            // Se releen TODAS las claves liberadas en las últimas 48 h: la decisión
            // cerrada nº 3 pide revisarlas en cada arranque, no una sola vez.
            for (var i = 0; i < _liberadas.length; i++) {
                var l = _liberadas[i];
                r.revisadas++;
                var ruta = 'BBDD/' + _emailPath + '/ops/' + l.clave;
                try {
                    var snap = await _db.ref(ruta).once('value');
                    var valor = (snap && typeof snap.val === 'function') ? snap.val() : null;
                    if (valor) {
                        l.verificadaEn = iso(reloj());
                        r.presentes++;
                        huboCambio = true;
                        continue;
                    }
                    // La promesa resolvió en su día pero el dato NO está: se vuelve a subir.
                    r.faltantes++;
                    try {
                        await _db.ref(ruta).set(clonar(l.op));
                        l.verificadaEn = iso(reloj());
                        r.resubidas++;
                        huboCambio = true;
                        avisar('la operación liberada ' + l.clave + ' no estaba en la nube: se volvió a subir');
                    } catch (e2) {
                        r.fallidas++;
                        anotarError(e2, 'reverificación de ' + l.clave);
                        avisar('la operación liberada ' + l.clave + ' sigue sin poder subirse: se reintentará en el próximo arranque');
                    }
                } catch (e) {
                    r.fallidas++;
                    anotarError(e, 'reverificación de ' + l.clave);
                }
            }
            if (huboCambio) await escribirJson(ARCHIVO_LIBERADAS, _liberadas);
            _ultimaVerificacion = r;
            return r;
        } catch (e) {
            anotarError(e, 'verificarLiberadasRecientes');
            _ultimaVerificacion = r;
            return r;
        }
    }

    /* =================================================================
       8. Subida de la cola (§5 pasos 4 y 5, §1.4)
       ================================================================= */

    function puedeIntentarRed() {
        if (!_nube) return false;
        try {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        } catch (e) { /* sin navigator: se intenta */ }
        return !!(_db && _emailPath);
    }

    /**
     * Sube UNA operación. Devuelve:
     *   'subida'     -> el servidor confirmó la escritura nueva
     *   'ya-estaba'  -> la clave ya estaba en la nube con el mismo contenido
     *   'conflicto'  -> la clave ya estaba con contenido DISTINTO: no se pisa (§1.4)
     */
    async function subirOperacion(entrada) {
        var op = entrada.payload;
        var ruta = rutaDeOperacion(op);
        if (entrada.intentos > 0) {
            // Reintento: el resultado del intento anterior es desconocido, así que
            // aquí SÍ se compara antes de escribir (§1.4). El primer intento no lee.
            var snap = await _db.ref(ruta).once('value');
            var valor = (snap && typeof snap.val === 'function') ? snap.val() : null;
            if (valor) return iguales(valor, clonar(op)) ? 'ya-estaba' : 'conflicto';
        }
        await _db.ref(ruta).set(clonar(op));
        return 'subida';
    }

    /** Índice de agregados del día (§2). Caché derivado: nunca fuente de verdad. */
    async function escribirIndiceVenta(op) {
        if (!_nube || !_indiceVentas || op.tipo !== 'venta') return false;
        try {
            var ruta = rutaIndice(op);
            if (!ruta) return false;
            var p = op.payload || {};
            var total = (p.totals && isFinite(Number(p.totals.total))) ? Number(p.totals.total) : 0;
            var moneda = p.currency ? String(p.currency) : 'USD';
            var tasa = Number(p.exchangeRate) || 0;
            var totalUSD = (moneda === 'VES' && tasa > 0) ? (total / tasa) : total;
            await _db.ref(ruta).set({
                total: total,
                totalUSD: Math.round(totalUSD * 100) / 100,
                items: (p.items && p.items.length) ? p.items.length : 0,
                metodo: p.paymentMethod ? String(p.paymentMethod) : '',
                // Formas de pago de dueño: CONSUMO INTERNO no es una venta (el lector
                // lo deja fuera de los totales) y POR COBRAR es venta, pero sin cobrar.
                // Viajan como bandera propia además del método, para que el reporte no
                // dependa de una sola señal.
                consumoInterno: p.consumoInterno === true,
                porCobrar: p.porCobrar === true
            });
            return true;
        } catch (e) {
            // El índice es caché: su fallo NO puede marcar la venta como no subida,
            // así que no se apunta como `ultimoError` (no debe poner el punto rojo).
            avisar('no se pudo escribir el índice del día: ' + (e && (e.code || e.message)));
            return false;
        }
    }

    /** ¿Hay otro vaciador vivo (otra pestaña)? */
    async function hayBloqueoAjeno() {
        try {
            var b = await leerJson(ARCHIVO_BLOQUEO, null);
            if (!b || !b.id || b.id === _idPestana) return false;
            var t = aMs(b.ts);
            if (isNaN(t)) return false;
            return (reloj() - t) < MS_BLOQUEO_VIVO;
        } catch (e) { return false; }
    }

    async function escribirBloqueo() {
        _bloqueo = { id: _idPestana, ts: iso(reloj()) };
        return await escribirJson(ARCHIVO_BLOQUEO, _bloqueo);
    }

    /** Vaciado real de la cola. No se llama directo: usar `vaciarCola()`. */
    async function vaciarColaInterno() {
        var resumen = { intentadas: 0, subidas: 0, yaEstaban: 0, conflictos: 0, fallos: 0, liberadas: [], pendientes: 0, motivo: '' };
        try {
            if (!_activo) { resumen.motivo = 'motor-inactivo'; return resumen; }
            // Sin permiso de nube (cloudSync) el motor es SOLO-LOCAL: no se escribe
            // NADA en la nube (ni ops/*, ni índices, ni ventas/historial) y todo
            // queda pendiente en el equipo.
            if (!_nube || !_db || !_emailPath) { resumen.motivo = 'sin-nube'; resumen.pendientes = entradasEnOrden().length; return resumen; }
            if (typeof navigator !== 'undefined' && navigator.onLine === false) { resumen.motivo = 'sin-conexion'; resumen.pendientes = entradasEnOrden().length; return resumen; }
            if (await hayBloqueoAjeno()) { resumen.motivo = 'otra-pestana'; resumen.pendientes = entradasEnOrden().length; return resumen; }

            await escribirBloqueo();
            await recuperarHuerfanos();

            var lista = entradasEnOrden();
            for (var i = 0; i < lista.length; i++) {
                var e = lista[i];
                if (!e.payload) { avisar('entrada sin payload en la cola: ' + e.clave); continue; }
                resumen.intentadas++;
                await marcarEntrada(e.clave, 'subiendo', {});
                var resultado;
                try {
                    resultado = await subirOperacion(e);
                } catch (err) {
                    var texto = anotarError(err, 'subir ' + e.clave);
                    await marcarEntrada(e.clave, 'fallo', { intentos: e.intentos + 1, error: texto });
                    resumen.fallos++;
                    break;                       // §3.2.4: no se salta el orden
                }
                if (resultado === 'subida' || resultado === 'ya-estaba') {
                    await marcarEntrada(e.clave, 'subida', { intentos: e.intentos + 1 });
                    _confirmadas[e.clave] = { fechaISO: e.payload.fechaISO, ts: iso(reloj()) };
                    _subidasSesion++;
                    if (resultado === 'subida') {
                        resumen.subidas++;
                        await escribirIndiceVenta(e.payload);
                    } else {
                        resumen.yaEstaban++;
                    }
                } else if (resultado === 'conflicto') {
                    // La clave existe con OTRO contenido: nunca se pisa (§1.4). No
                    // bloquea el resto de la cola: la clave SÍ está en la nube.
                    await marcarEntrada(e.clave, 'conflicto', { intentos: e.intentos + 1, error: 'clave ocupada con otro contenido' });
                    resumen.conflictos++;
                    avisar('conflicto en ' + e.clave + ': la nube conserva el contenido que ya tenía');
                }
            }

            await guardarConfirmadas();
            var lib = await liberarCaliente();
            resumen.liberadas = lib.map(function (l) { return l.clave; });
            await compactarCola(false);
            resumen.pendientes = entradasEnOrden().length;
            resumen.motivo = 'ok';
            return resumen;
        } catch (e) {
            anotarError(e, 'vaciarCola');
            resumen.motivo = 'error';
            resumen.pendientes = entradasEnOrden().length;
            return resumen;
        }
    }

    /* =================================================================
       9. API pública
       ================================================================= */

    /** Reinicia el estado en memoria (una sesión nueva de motor). */
    function reiniciarEstado() {
        _activo = false;
        _modo = 'clasico';
        _motivoInactivo = '';
        _deviceId = '';
        _installId = '';
        _emailPath = '';
        _operador = '';
        _db = null;
        _almacen = null;
        _almacenTipo = '';
        _indiceVentas = true;
        _nube = false;
        _ahoraFijo = 0;
        _cola = {};
        _colaLineas = 0;
        _colaLineasSubida = 0;
        _confirmadas = {};
        _liberadas = [];
        _caliente = {};
        _ultimaSecuencia = 0;
        _bloqueo = null;
        _vaciando = null;
        _ultimoError = '';
        _subidasSesion = 0;
        _ultimaVerificacion = null;
        _estadoLiberadas = { revisadas: 0, faltantes: 0, resubidas: 0, fallidas: 0 };
    }

    /** Identificador de instalación de 4 caracteres, persistido en el equipo. */
    function generarInstallId() {
        var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin caracteres que se confunden al leerlos
        try {
            if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
                var b = new Uint8Array(4);
                crypto.getRandomValues(b);
                var s = '';
                for (var i = 0; i < 4; i++) s += abc[b[i] % abc.length];
                return s;
            }
        } catch (e) { /* se usa Math.random */ }
        var t = '';
        for (var j = 0; j < 4; j++) t += abc[Math.floor(Math.random() * abc.length)];
        return t;
    }

    function obtenerInstallId() {
        var actual = leerLocal(CLAVE_INSTALL_ID);
        if (actual && /^[A-Z0-9]{4}$/.test(String(actual))) return String(actual);
        var nuevo = generarInstallId();
        escribirLocal(CLAVE_INSTALL_ID, nuevo);
        return nuevo;
    }

    function leerOperador() {
        try {
            var bruto = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('currentUser') : null;
            if (!bruto) return '';
            try {
                var u = JSON.parse(bruto);
                if (u && (u.nombre || u.name || u.usuario || u.email)) return String(u.nombre || u.name || u.usuario || u.email);
            } catch (e) { /* no era JSON: se usa tal cual */ }
            return String(bruto).slice(0, 120);
        } catch (e) { return ''; }
    }

    /** Correo normalizado si la página no lo pasa (mismo criterio que las páginas). */
    function emailPathDeSesion() {
        try {
            var email = (typeof window !== 'undefined' && typeof window.getCurrentUserEmail === 'function')
                ? window.getCurrentUserEmail() : null;
            if (!email) return '';
            if (typeof window.sanitizeEmailForDb === 'function') return String(window.sanitizeEmailForDb(email));
            return String(email).replace('@', '_at_').replace(/\./g, '_');
        } catch (e) { return ''; }
    }

    /**
     * Permiso de nube del cliente: `suscripcion/cloudSync`. Es lo que se cobra,
     * así que ante CUALQUIER duda la respuesta es "no hay nube": nodo ausente,
     * valor distinto de `true`, error de lectura o SDK/ruta ausentes. Nunca se
     * cachea el fallo (réplica de la semántica de `checkCloudAccess()`).
     */
    async function leerCloudSyncNube(db, emailPath) {
        if (!db || !emailPath) {
            // Sin SDK ni ruta no hay a quién preguntar: se usa la puerta de la
            // página si existe (cloud-access.js expone window.checkCloudAccess).
            try {
                if (typeof window !== 'undefined' && typeof window.checkCloudAccess === 'function') {
                    return (await window.checkCloudAccess()) === true;
                }
            } catch (e) { /* fallo de lectura: sin nube */ }
            return false;
        }
        try {
            var snap = await db.ref('BBDD/' + String(emailPath) + '/suscripcion/cloudSync').once('value');
            var valor = (snap && typeof snap.val === 'function') ? snap.val() : null;
            return valor === true;
        } catch (e) {
            return false;               // lectura fallida -> NO hay nube
        }
    }

    /**
     * Arranca el motor. El interruptor acepta `true` (booleano, cómodo en la
     * consola de Firebase, igual que `cloudSync`) o la cadena `'operaciones'`
     * (forma canónica, con sitio para futuros modos). Con CUALQUIER otro valor
     * —`false`, `'clasico'`, ausente, un número, un texto distinto o un error de
     * lectura— NO se ejecuta nada más: ni disco, ni installId, ni red (garantía
     * dura del modo clásico; ante duda, clásico, nunca al revés). Con el motor
     * activo pero SIN permiso de nube (`cloudSync !== true`) arranca en MODO
     * SOLO-LOCAL: cola y ventana caliente en el equipo, cero escrituras en la
     * nube. Devuelve siempre un objeto, nunca lanza.
     */
    async function iniciar(opciones) {
        opciones = opciones || {};
        // Si ya hay un arranque en curso, se espera a ESA promesa. La guarda va
        // fuera del try/finally para que el segundo llamador no anule el candado.
        if (_iniciando) return await _iniciando;
        try {
            _iniciando = (async function () {
                reiniciarEstado();

                // ---- 1) Interruptor por cliente (§8) ----
                var modo = opciones.modoSync;
                var leidoDeNube = false;
                if ((modo === undefined || modo === null) && opciones.db && opciones.emailPath) {
                    try {
                        var snap = await opciones.db.ref('BBDD/' + String(opciones.emailPath) + '/suscripcion/modoSync').once('value');
                        modo = (snap && typeof snap.val === 'function') ? snap.val() : null;
                        leidoDeNube = true;
                    } catch (e) {
                        modo = null;                 // fallo de lectura -> 'clasico', sin cachear nada
                    }
                }
                // Dos formas válidas del interruptor: el booleano `true` (cómodo,
                // igual que `cloudSync`) y la cadena 'operaciones' (canónica, con
                // sitio para futuros modos). Todo lo demás es clásico.
                _modo = (modo === 'operaciones' || modo === true) ? 'operaciones' : 'clasico';
                if (_modo !== 'operaciones') {
                    _motivoInactivo = leidoDeNube ? 'interruptor-en-clasico' : 'interruptor-no-operaciones';
                    return { ok: true, activo: false, modo: 'clasico', motivo: _motivoInactivo };
                }

                // ---- 2) Del modo nuevo en adelante ya se puede tocar el equipo ----
                _deviceId = String(opciones.deviceId || leerLocal(CLAVE_DEVICE_ID) || '').toUpperCase();
                if (!_deviceId) { _motivoInactivo = 'sin-deviceId'; _modo = 'clasico'; return { ok: false, activo: false, modo: 'clasico', motivo: _motivoInactivo }; }

                _emailPath = String(opciones.emailPath || emailPathDeSesion() || '');
                _db = opciones.db || null;
                if (_db && !_emailPath) { _motivoInactivo = 'sin-emailPath'; _modo = 'clasico'; return { ok: false, activo: false, modo: 'clasico', motivo: _motivoInactivo }; }

                // ---- 2b) Permiso de nube del cliente (lo que se cobra) ----
                // Sin `suscripcion/cloudSync === true` el motor arranca igual pero en
                // MODO SOLO-LOCAL: cola y ventana caliente en el equipo y CERO
                // escrituras en la nube (ver `vaciarColaInterno`).
                var permisoNube = opciones.cloudSync;
                if (permisoNube === undefined || permisoNube === null) {
                    permisoNube = await leerCloudSyncNube(_db, _emailPath);
                }
                _nube = (permisoNube === true) && !!_db && !!_emailPath;

                _almacen = await elegirAlmacen(opciones.almacen);
                if (!_almacen) {
                    _motivoInactivo = 'sin-almacen-durable';
                    _modo = 'clasico';
                    return { ok: false, activo: false, modo: 'clasico', motivo: _motivoInactivo };
                }
                _almacenTipo = String(_almacen.tipo || 'desconocido');
                _installId = obtenerInstallId();
                _operador = opciones.operador !== undefined ? String(opciones.operador || '') : leerOperador();
                _indiceVentas = opciones.indiceVentas !== false;
                _ahoraFijo = (Number(opciones.ahora) > 0) ? Number(opciones.ahora) : 0;
                _idPestana = _deviceId + '-' + _installId + '-' + Date.now().toString(36);
                _ultimaSecuencia = parseInt(leerLocal(CLAVE_SECUENCIA) || '0', 10) || 0;

                // ---- 3) Cargar cola, índice de confirmadas y ventana caliente ----
                var objetos = await leerObjetos(ARCHIVO_COLA);
                var plegado = plegarCola(objetos);
                _cola = plegado.mapa;
                _colaLineas = plegado.lineas;
                _colaLineasSubida = plegado.subidas;
                _confirmadas = await leerJson(ARCHIVO_CONFIRMADAS, {}) || {};
                _liberadas = await leerJson(ARCHIVO_LIBERADAS, []) || [];
                if (!Array.isArray(_liberadas)) _liberadas = [];

                _activo = true;

                // ---- 4) Mantenimiento de arranque ----
                await recuperarHuerfanos();
                var verificacion = await verificarLiberadasRecientes();
                var secuenciaNube = null;
                if (opciones.reservarSecuencia === true) secuenciaNube = await reservarSecuenciaDesdeNube();
                // El bloqueo SOLO lo escribe el vaciador (§5): aquí solo se lee para
                // saber si otra pestaña está vaciando en este momento.
                _bloqueo = await leerJson(ARCHIVO_BLOQUEO, null);

                _estadoLiberadas = { revisadas: verificacion.revisadas, faltantes: verificacion.faltantes, resubidas: verificacion.resubidas, fallidas: verificacion.fallidas };

                return {
                    ok: true,
                    activo: true,
                    modo: 'operaciones',
                    v: VERSION_MOTOR,
                    deviceId: _deviceId,
                    installId: _installId,
                    operador: _operador,
                    emailPath: _emailPath,
                    almacen: _almacenTipo,
                    nube: _nube,
                    modoLocal: !_nube,
                    pendientes: entradasEnOrden().length,
                    verificacion: verificacion,
                    secuenciaNube: secuenciaNube
                };
            })();
            return await _iniciando;
        } catch (e) {
            anotarError(e, 'iniciar');
            _modo = 'clasico';
            _motivoInactivo = 'error-al-iniciar';
            return { ok: false, activo: false, modo: 'clasico', motivo: _motivoInactivo, error: _ultimoError };
        } finally {
            _iniciando = null;
        }
    }

    /**
     * Registra una operación. Escribe en la COLA (disco) ANTES de tocar la red y
     * devuelve `{ ok, clave }`. La subida se dispara después, sin bloquear.
     */
    async function registrarOperacion(tipo, payload) {
        try {
            if (!_activo) return { ok: false, clave: null, motivo: _motivoInactivo || 'motor-inactivo' };
            if (!payload || typeof payload !== 'object') return { ok: false, clave: null, motivo: 'payload-invalido' };
            var tipoNorm = String(tipo || '').toLowerCase().trim();
            if (TIPOS.indexOf(tipoNorm) === -1) return { ok: false, clave: null, motivo: 'tipo-desconocido' };

            var secuencia;
            var id;
            if (tipoNorm === 'venta') {
                id = payload.id ? String(payload.id) : '';
                secuencia = secuenciaDesdeIdVenta(id, _deviceId);
                if (!secuencia) secuencia = reservarSecuencia();
                if (!id) id = 'V-LOCAL-' + _deviceId + '-' + pad4(secuencia);
            } else {
                secuencia = reservarSecuencia();
                id = payload.id ? String(payload.id) : (tipoNorm.toUpperCase() + '-LOCAL-' + _deviceId + '-' + pad4(secuencia));
            }

            var nodo = _deviceId + '_' + _installId + '_' + pad4(secuencia);
            var clave = tipoNorm + '/' + nodo;
            if (_cola[clave]) return { ok: true, clave: clave, nodo: nodo, secuencia: secuencia, duplicada: true };

            var op = {
                id: id,
                tipo: tipoNorm,
                deviceId: _deviceId,
                installId: _installId,
                secuencia: secuencia,
                fechaISO: iso(reloj()),
                version: VERSION_OPERACION,
                payload: clonar(payload)
            };
            if (_operador) op.operador = _operador;

            // ---- 1) COLA primero: append + flush ANTES de la red (§3.2.1) ----
            var entrada = { clave: clave, nodo: nodo, tipo: tipoNorm, payload: op, estado: 'pendiente', intentos: 0, ts: op.fechaISO, tsEstado: op.fechaISO, error: '' };
            _cola[clave] = entrada;
            var escrito = await anexarLinea(ARCHIVO_COLA, { clave: clave, tipo: tipoNorm, payload: op, estado: 'pendiente', intentos: 0, ts: op.fechaISO });
            if (!escrito) {
                delete _cola[clave];
                return { ok: false, clave: clave, nodo: nodo, motivo: 'cola-no-escrita' };
            }
            _colaLineas++;

            // ---- 2) Aplicar a la ventana caliente: la venta ya se puede cobrar ----
            await aplicarACaliente(entrada);
            _ultimaSecuencia = Math.max(_ultimaSecuencia, secuencia);

            // ---- 3) La red va después y no se espera (paso 4 del ciclo) ----
            vaciarCola().then(function () { /* el resumen queda en estado() */ }, function () { /* nada */ });

            return { ok: true, clave: clave, nodo: nodo, secuencia: secuencia, id: id };
        } catch (e) {
            anotarError(e, 'registrarOperacion');
            return { ok: false, clave: null, motivo: 'error', error: _ultimoError };
        }
    }

    /** Vacía la cola en orden de secuencia. Un solo vaciador a la vez (§5). */
    function vaciarCola(opciones) {
        opciones = opciones || {};
        if (_vaciando) return _vaciando;
        var promesa;
        try {
            promesa = vaciarColaInterno();
        } catch (e) {
            anotarError(e, 'vaciarCola');
            promesa = Promise.resolve({ intentadas: 0, subidas: 0, yaEstaban: 0, conflictos: 0, fallos: 0, liberadas: [], motivo: 'error' });
        }
        _vaciando = promesa.then(function (r) {
            _vaciando = null;
            return r;
        }, function (e) {
            _vaciando = null;
            anotarError(e, 'vaciarCola');
            return { intentadas: 0, subidas: 0, yaEstaban: 0, conflictos: 0, fallos: 0, liberadas: [], motivo: 'error' };
        });
        return _vaciando;
    }

    /** Estado del motor para el punto de estado del header y el diagnóstico. */
    function estado() {
        var c = contarEstadosCola();
        return {
            modo: _activo ? 'operaciones' : 'clasico',
            activo: _activo,
            motivo: _motivoInactivo,
            // Pendientes = operaciones sin confirmar (lo que decide si se puede apagar el equipo).
            pendientes: c.pendiente + c.subiendo + c.fallo + c.conflicto,
            subidas: c.subida,
            liberadas: _liberadas.length,
            ultimoError: _ultimoError,
            cola: c,
            confirmadas: Object.keys(_confirmadas).length,
            calienteVentas: _caliente.venta ? Object.keys(_caliente.venta).length : 0,
            almacen: _almacenTipo,
            nube: _nube,
            modoLocal: _activo && !_nube,
            deviceId: _deviceId,
            installId: _installId,
            ultimaSecuencia: _ultimaSecuencia,
            subidasSesion: _subidasSesion,
            liberadasRecientes: {
                revisadas: _estadoLiberadas.revisadas,
                faltantes: _estadoLiberadas.faltantes,
                resubidas: _estadoLiberadas.resubidas,
                fallidas: _estadoLiberadas.fallidas
            },
            v: VERSION_MOTOR
        };
    }

    /** ¿Queda algo por confirmar? (marca derivada del §10.1) */
    function hayPendientes() {
        var c = contarEstadosCola();
        return (c.pendiente + c.subiendo + c.fallo + c.conflicto) > 0;
    }

    /** Ventas de la ventana caliente, en formato `pos_sales` (§4). */
    async function leerVentas(dias) {
        try {
            var d = (Number(dias) > 0) ? Number(dias) : DIAS_VENTANA_CALIENTE;
            var mapa = await cargarCalienteLog('venta');
            var corte = reloj() - d * MS_DIA;
            var ops = [];
            for (var k in mapa) {
                if (!Object.prototype.hasOwnProperty.call(mapa, k)) continue;
                var op = mapa[k];
                var t = aMs(op.fechaISO);
                if (isNaN(t) || t < corte) continue;
                ops.push(op);
            }
            ops.sort(compararOperaciones);
            return ops.map(function (o) { return o.payload; });
        } catch (e) { anotarError(e, 'leerVentas'); return []; }
    }

    /** Orden total del §1.2: fechaISO, luego secuencia, luego deviceId. */
    function compararOperaciones(a, b) {
        var f = String(a && a.fechaISO || '').localeCompare(String(b && b.fechaISO || ''));
        if (f !== 0) return f;
        var s = (Number(a && a.secuencia) || 0) - (Number(b && b.secuencia) || 0);
        if (s !== 0) return s;
        return String(a && a.deviceId || '').localeCompare(String(b && b.deviceId || ''));
    }

    /**
     * Histórico anterior a la ventana caliente: se lee del archivo CONGELADO
     * `ventas/historial`, paginado hacia atrás y SOLO con lecturas (decisión
     * cerrada nº 1: la app no reescribe nunca ese nodo).
     */
    async function leerHistoricoAntiguo(desde, hasta, opciones) {
        opciones = opciones || {};
        var res = { ok: true, paginas: 0, lecturas: 0, total: 0, ventas: [], error: '', rango: { desde: desde, hasta: hasta }, modo: '' };
        try {
            if (!_db || !_emailPath) { res.ok = false; res.error = 'sin-nube'; return res; }
            var tam = (Number(opciones.tamanoPagina) > 0) ? Number(opciones.tamanoPagina) : TAMANO_PAGINA;
            var desdeMs = aMs(desde);
            var hastaMs = aMs(hasta);
            if (isNaN(desdeMs)) desdeMs = -8640000000000000;
            if (isNaN(hastaMs)) hastaMs = reloj();
            var ruta = 'BBDD/' + _emailPath + '/ventas/historial';
            var vistos = {};
            var encontradas = [];

            var usarConsulta = (opciones.paginado !== false) && (typeof _db.ref(ruta).orderByChild === 'function');
            if (usarConsulta) {
                res.modo = 'paginado';
                var cursor = hastaMs;
                while (res.paginas < MAX_PAGINAS) {
                    var q = _db.ref(ruta).orderByChild('timestamp').endAt(iso(cursor)).limitToLast(tam);
                    var snap = await q.once('value');
                    res.paginas++;
                    res.lecturas++;
                    var lista = normalizarLista(snap ? snap.val() : null);
                    if (!lista.length) break;
                    var nuevos = 0;
                    var minMs = cursor;
                    for (var i = 0; i < lista.length; i++) {
                        var v = lista[i];
                        if (!v || typeof v !== 'object') continue;
                        var t = aMs(v.timestamp);
                        if (isNaN(t)) continue;
                        if (t < minMs) minMs = t;
                        if (t > hastaMs || t < desdeMs) continue;
                        var id = v.id ? String(v.id) : (String(t) + '#' + i);
                        if (vistos[id]) continue;
                        vistos[id] = true;
                        encontradas.push(v);
                        nuevos++;
                    }
                    if (lista.length < tam) break;          // se acabó el histórico
                    if (minMs <= desdeMs) break;            // ya se llegó al principio del rango
                    var siguiente = (minMs === cursor) ? (minMs - 1) : minMs;
                    if (siguiente >= cursor) siguiente = cursor - 1;
                    cursor = siguiente;
                    if (cursor < desdeMs) break;
                    if (nuevos === 0 && res.paginas > 1) break;   // no avanza: se corta
                }
            } else {
                // Sin consultas disponibles: se lee el nodo entero y se pagina en memoria.
                res.modo = 'memoria';
                var snap2 = await _db.ref(ruta).once('value');
                res.lecturas++;
                var todos = normalizarLista(snap2 ? snap2.val() : null).filter(function (v) {
                    var t = aMs(v && v.timestamp);
                    return !isNaN(t) && t >= desdeMs && t <= hastaMs;
                });
                todos.sort(function (x, y) { return aMs(x.timestamp) - aMs(y.timestamp); });
                for (var j = 0; j < todos.length; j += tam) {
                    var pagina = todos.slice(j, j + tam);
                    res.paginas++;
                    for (var k = 0; k < pagina.length; k++) encontradas.push(pagina[k]);
                }
            }

            encontradas.sort(function (x, y) { return aMs(x.timestamp) - aMs(y.timestamp); });
            res.ventas = encontradas;
            res.total = encontradas.length;
            return res;
        } catch (e) {
            res.ok = false;
            res.error = anotarError(e, 'leerHistoricoAntiguo');
            return res;
        }
    }

    /** Un nodo de RTDB puede llegar como arreglo o como objeto con claves. */
    function normalizarLista(valor) {
        try {
            if (!valor) return [];
            if (Array.isArray(valor)) return valor.filter(function (v) { return v !== null && v !== undefined; });
            if (typeof valor !== 'object') return [];
            var claves = Object.keys(valor);
            claves.sort(function (a, b) {
                var na = parseInt(a, 10), nb = parseInt(b, 10);
                if (isFinite(na) && isFinite(nb)) return na - nb;
                return a.localeCompare(b);
            });
            var salida = [];
            for (var i = 0; i < claves.length; i++) {
                if (valor[claves[i]] !== null && valor[claves[i]] !== undefined) salida.push(valor[claves[i]]);
            }
            return salida;
        } catch (e) { return []; }
    }

    /**
     * Equipo que arranca con el contador local perdido: recupera la secuencia
     * máxima que ESTE deviceId ya usó en la nube (§11.4). Con `installId` en la
     * clave la colisión es imposible dentro de la misma instalación, así que es
     * opcional (`iniciar({ reservarSecuencia: true })`).
     */
    async function reservarSecuenciaDesdeNube() {
        var maximo = 0;
        try {
            if (!_nube || !_db || !_emailPath) return null;
            for (var i = 0; i < TIPOS.length; i++) {
                var tipo = TIPOS[i];
                var snap = await _db.ref('BBDD/' + _emailPath + '/ops/' + tipo).orderByKey().limitToLast(1).once('value');
                var valor = (snap && typeof snap.val === 'function') ? snap.val() : null;
                if (!valor || typeof valor !== 'object') continue;
                for (var k in valor) {
                    if (!Object.prototype.hasOwnProperty.call(valor, k)) continue;
                    var op = valor[k];
                    if (!op || String(op.deviceId) !== _deviceId) continue;
                    var n = Number(op.secuencia) || 0;
                    if (n > maximo) maximo = n;
                }
            }
            if (maximo > _ultimaSecuencia) {
                _ultimaSecuencia = maximo;
                escribirLocal(CLAVE_SECUENCIA, maximo);
            }
            return _ultimaSecuencia;
        } catch (e) {
            avisar('no se pudo reservar la secuencia desde la nube: ' + (e && e.message));
            return null;
        }
    }

    /** Fuerza la verificación de liberadas recientes (diagnóstico/pruebas). */
    async function verificarLiberadas() {
        return await verificarLiberadasRecientes();
    }

    window.motorOperaciones = {
        // --- API mínima del encargo ---
        iniciar: iniciar,
        registrarOperacion: registrarOperacion,
        vaciarCola: vaciarCola,
        estado: estado,
        leerVentas: leerVentas,
        leerHistoricoAntiguo: leerHistoricoAntiguo,
        // --- apoyo al POS y al diagnóstico ---
        hayPendientes: hayPendientes,
        verificarLiberadas: verificarLiberadas,
        reservarSecuenciaDesdeNube: reservarSecuenciaDesdeNube,
        liberarCaliente: liberarCaliente,
        compactarCola: compactarCola,
        claveDeOperacion: claveDeOperacion,
        nombreNodo: nombreNodo,
        ventanaCalienteDias: DIAS_VENTANA_CALIENTE,
        version: VERSION_MOTOR
    };
})();
