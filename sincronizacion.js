/* =====================================================================
   FASE_A_SYNC_V1
   Cola de cambios pendientes de subir a la nube.

   Problema que arregla (auditoría AUDITORIA_ALMACENAMIENTO.md, C1 y C4):

   1) La marca "hay cambios pendientes" se ponía SOLO en el catch de la subida.
      Pero sin internet la promesa de .set() no resuelve ni rechaza (queda
      pendiente hasta que el servidor confirma), así que ese catch nunca se
      ejecutaba: el app creía que todo estaba subido. Si el equipo se apagaba
      antes de reconectar, al abrir de nuevo se descargaba la nube encima y la
      venta/movimiento hecho sin conexión se perdía.
      Ahora la marca se pone ANTES de intentar subir y se limpia SOLO cuando
      el servidor confirma.

   2) Había una sola marca global compartida por todos los módulos y cualquier
      página la borraba al subir lo suyo, cancelando en silencio los pendientes
      de los demás.
      Ahora hay una marca por módulo y por negocio, y mientras exista cualquier
      pendiente ninguna página pisa los datos locales con los de la nube.

   Compatibilidad: sigue respetando la marca antigua `_pendingFirebaseChanges`.
   Si queda esa marca vieja y no hay marcas por módulo, se migra marcando todos
   los módulos (conservador: subir antes que sobrescribir). La migración es
   PEREZOSA: se hace la primera vez que se consulta con una sesión ya iniciada,
   porque este archivo se carga en el <head>, antes de que exista el correo del
   negocio en la sesión.
   ===================================================================== */
(function () {
    var PREFIJO = '_pendSync_';
    var MARCA_ANTIGUA = '_pendingFirebaseChanges';
    // Solo los módulos que ESCRIBEN datos. Los de solo lectura (resumen) no pueden
    // tener cambios propios que subir: marcarlos dejaría una marca que nadie limpia.
    var MODULOS_CONOCIDOS = ['inventario', 'compras', 'catalogo', 'cuentas', 'clientes', 'proveedores', 'empresa', 'pos'];
    // Una marca de OTRO módulo solo bloquea la descarga si es reciente. Si no, una
    // operación vieja que nunca se pudo subir congelaría la app para siempre (ninguna
    // página volvería a descargar). El módulo dueño de la marca sigue subiendo primero
    // cuando se abre su página: ahí no hay riesgo.
    var VENTANA_BLOQUEO_MS = 24 * 60 * 60 * 1000;
    var migracionHecha = false;

    function normalizar(email) {
        if (typeof window.sanitizeEmailForDb === 'function') {
            try { return window.sanitizeEmailForDb(email); } catch (e) { /* seguimos */ }
        }
        return String(email || '').trim().toLowerCase().replace('@', '_at_').replace(/\./g, '_');
    }

    function negocioActual() {
        try {
            var email = (typeof window.getCurrentUserEmail === 'function') ? window.getCurrentUserEmail() : null;
            if (email) return normalizar(email);
        } catch (e) { /* seguimos */ }
        return 'sin_sesion';
    }

    function claveDe(modulo) {
        return PREFIJO + modulo + '_' + negocioActual();
    }

    function leer(clave) {
        try { return localStorage.getItem(clave); } catch (e) { return null; }
    }

    function escribir(clave, valor) {
        try { localStorage.setItem(clave, valor); } catch (e) { /* cuota llena: no rompemos la operación */ }
    }

    function borrar(clave) {
        try { localStorage.removeItem(clave); } catch (e) { /* nada */ }
    }

    /* Barrido de marcas por módulo del negocio actual (sin migrar). */
    function listarPendientes() {
        var sufijo = '_' + negocioActual();
        var encontrados = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k || k.indexOf(PREFIJO) !== 0 || k.slice(-sufijo.length) !== sufijo) continue;
                var modulo = k.slice(PREFIJO.length, k.length - sufijo.length);
                if (modulo.length > 0) encontrados.push(modulo);
            }
        } catch (e) { /* nada */ }
        return encontrados;
    }

    /* Igual que listarPendientes pero con la fecha de cada marca, para poder decidir
       si un pendiente de OTRO módulo es reciente o es un resto viejo. */
    function listarMarcas() {
        return listarPendientes().map(function (modulo) {
            return { modulo: modulo, cuando: leer(claveDe(modulo)) };
        });
    }

    function esReciente(marcaISO) {
        var t = Date.parse(marcaISO);
        if (isNaN(t)) return true;                 // sin fecha legible: conservador
        return (Date.now() - t) < VENTANA_BLOQUEO_MS;
    }

    function migrarSiHaceFalta() {
        if (migracionHecha) return;
        if (negocioActual() === 'sin_sesion') return;      // aún no hay sesión: se intentará después
        migracionHecha = true;
        if (leer(MARCA_ANTIGUA) !== 'true') return;
        if (listarPendientes().length > 0) return;
        for (var i = 0; i < MODULOS_CONOCIDOS.length; i++) escribir(claveDe(MODULOS_CONOCIDOS[i]), new Date().toISOString());
    }

    /* Marca que ESTE módulo tiene cambios sin confirmar en el servidor.
       Se llama antes de intentar la subida. */
    window.marcarPendienteSync = function (modulo) {
        migrarSiHaceFalta();
        escribir(claveDe(modulo), new Date().toISOString());
        // NO se escribe la marca antigua `_pendingFirebaseChanges` (a propósito).
        // La auditoría de replicación (AUDITORIA_REPLICACION_SYNC.md, R1 y R2) demostró
        // que hacerlo es peligroso mientras convivan páginas migradas y no migradas:
        // las no migradas (por ejemplo catalogo.html) interpretarían esa marca como
        // "tengo pendientes propios" y subirían su arreglo local SIN descargar antes,
        // pisando datos más nuevos. La marca antigua solo se LEE (migración y
        // compatibilidad) y se borra; nunca se crea desde el código nuevo.
    };

    /* Limpia la marca de este módulo y la antigua. Se llama SOLO cuando el
       servidor confirmó (el estado fino vive en las marcas por módulo). */
    window.limpiarPendienteSync = function (modulo) {
        borrar(claveDe(modulo));
        borrar(MARCA_ANTIGUA);
    };

    /* Lista de módulos con cambios pendientes del negocio actual. */
    window.pendientesSync = function () {
        migrarSiHaceFalta();
        return listarPendientes();
    };

    /* ¿Hay cambios pendientes? Sin argumento: de cualquier módulo del negocio. */
    window.hayPendientesSync = function (modulo) {
        migrarSiHaceFalta();
        if (modulo) {
            if (leer(claveDe(modulo))) return true;
            // La marca antigua no distingue de qué módulo era: se respeta para todos
            return leer(MARCA_ANTIGUA) === 'true';
        }
        if (listarPendientes().length > 0) return true;
        return leer(MARCA_ANTIGUA) === 'true';
    };

    /* ¿Se pueden reemplazar los datos locales con los de la nube?
       No, si hay cambios sin confirmar que puedan ser más nuevos que la nube:
         - si el propio módulo tiene pendientes, su página sube primero y no descarga;
         - si OTRO módulo tiene un pendiente reciente (menos de 24 h), se espera;
         - si queda la marca antigua sin fecha, se es conservador.
       Un pendiente viejo de otro módulo NO bloquea para siempre: si no, una operación
       que nunca se pudo subir dejaría la app sin descargar nunca más. */
    window.puedeSobrescribirLocalSync = function (modulo) {
        migrarSiHaceFalta();
        if (leer(MARCA_ANTIGUA) === 'true') return false;
        var marcas = listarMarcas();
        if (modulo) marcas = marcas.filter(function (m) { return m.modulo !== modulo; });
        for (var i = 0; i < marcas.length; i++) {
            if (esReciente(marcas[i].cuando)) return false;
        }
        return true;
    };

    /* Olvida TODOS los pendientes del negocio actual. Se usa solo cuando los datos
       locales se borran a propósito (reinicio de fábrica en config.html): si los
       datos ya no existen, no tiene sentido reintentar subirlos. */
    window.olvidarPendientesSync = function () {
        var aBorrar = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf(PREFIJO) === 0) aBorrar.push(k);
            }
        } catch (e) { /* nada */ }
        for (var j = 0; j < aBorrar.length; j++) borrar(aBorrar[j]);
        borrar(MARCA_ANTIGUA);
    };

    /* Sube marcando antes y limpiando después. Devuelve true si el servidor confirmó.
       `subir` es una función async que hace el/los .set/.update/.push. */
    /* Sube marcando antes y limpiando después. Devuelve true si el servidor confirmó.
       `subir` es una función async que hace el/los .set/.update/.push y que debe
       lanzar excepción si no pudo subir (por ejemplo, si no hay permiso de nube). */
    window.subirConMarcaSync = async function (modulo, subir) {
        window.marcarPendienteSync(modulo);
        try {
            await subir();
            window.limpiarPendienteSync(modulo);
            return true;
        } catch (e) {
            // Sigue pendiente: se reintentará al reconectar o en la próxima carga
            return false;
        }
    };

    /* Reintento automático al recuperar la conexión.
       Antes esto vivía en un `setupConnectionMonitor` por página que, en la práctica,
       no se instalaba en ninguna (AUDITORIA_REPLICACION_SYNC.md, R9): la capa común
       cloud-access.js quedaba anulada porque cada página define su propia
       checkCloudAccess. Ahora es central: cuando el navegador avisa de que hay red (y
       además cada minuto), si quedan pendientes se llama a `uploadToFirebase()` de la
       página, que es la que sabe subir sus datos. Si la página no expone esa función,
       no se hace nada: su próxima carga sube lo pendiente antes de descargar. */
    var reintentoInstalado = false;
    function instalarReintento() {
        if (reintentoInstalado) return;
        reintentoInstalado = true;
        var intentar = async function () {
            try {
                if (listarPendientes().length === 0) return;
                if (typeof window.uploadToFirebase !== 'function') return;
                await window.uploadToFirebase();
            } catch (e) { /* sigue pendiente: se reintentará */ }
        };
        if (typeof window.addEventListener === 'function') window.addEventListener('online', intentar);
        /* Instala el monitor de conexión de la página. Existía en 8 páginas y no se
           instalaba en NINGUNA (AUDITORIA_REPLICACION_SYNC.md, R9), por eso el punto de
           estado del header se quedaba gris aunque la sincronización funcionara bien.
           Se intenta al terminar de cargar la página, cuando ya hay sesión y ya están
           definidas las funciones de la página. */
        var instalarMonitor = async function () {
            if (typeof window.setupConnectionMonitor !== 'function' || typeof window.initFirebase !== 'function') return;
            try {
                var db = await window.initFirebase();
                if (db) await window.setupConnectionMonitor(db);
            } catch (e) { /* la página no tiene nube o aún no hay sesión */ }
        };
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('DOMContentLoaded', function () { setTimeout(instalarMonitor, 1500); });
        }
        if (typeof setInterval === 'function') {
            setInterval(function () {
                if (typeof navigator === 'undefined' || navigator.onLine !== false) intentar();
            }, 60000);
        }
    }
    instalarReintento();
})();
