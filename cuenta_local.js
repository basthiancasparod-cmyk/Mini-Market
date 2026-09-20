/* Guardián de "UNA CUENTA POR EQUIPO" (aislamiento local entre negocios) - fase 1.
 *
 * EL PROBLEMA
 *   localStorage, IndexedDB y OPFS se guardan POR DOMINIO, no por cuenta. En el PC de un
 *   cliente viven las claves de negocio (ciervo_inventory, pos_sales, ciervo_clients, ...).
 *   Si en ese mismo PC cierra sesión una cuenta y entra OTRA, la segunda vería los datos de
 *   la primera (fuga de información entre negocios) y podría subirlos a su propia nube.
 *   El modelo del negocio es UNA CUENTA POR EQUIPO.
 *
 * LO QUE HACE ESTE ARCHIVO (paso acotado)
 *   1. Marca el equipo con el `emailPath` del negocio DUEÑO de los datos locales, en
 *      localStorage['datosDeCuenta'] (misma normalización que la app: minúsculas,
 *      '@' -> '_at_' y TODOS los puntos -> '_').
 *   2. Si no había marca, la RECLAMA la cuenta que entra: así los clientes que ya tenían
 *      datos en su PC los conservan (es el caso normal).
 *   3. Si la marca es de OTRA cuenta, la página queda inutilizable: se muestra un aviso a
 *      pantalla completa con estilos en línea (no depende del CSS de la página) y se frena
 *      el arranque de la página. NADA DESTRUCTIVO: no se borra ni se modifica ningún dato
 *      de negocio.
 *
 * LO QUE NO HACE (queda para la fase de aislamiento completo)
 *   - No separa las claves de negocio por cuenta (ciervo_inventory de A frente al de B).
 *   - No separa por negocio los archivos del motor de operaciones (IndexedDB/OPFS).
 *
 * Se carga en el <head> (junto a sincronizacion.js) en las páginas de datos, y también en
 * index.html y config.html. No depende de Firebase ni de ninguna otra librería.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    var CLAVE_MARCADOR = 'datosDeCuenta';
    var CLAVE_SESION = 'sesionActiva';
    var RUTA_LOGIN = 'index.html';
    var ID_AVISO = 'avisoCuentaAjena';
    var bloqueoRegistrado = false;

    /* ============================ utilidades ============================ */

    // Misma normalización que usa la app para la ruta del negocio: minúsculas, '@' -> '_at_'
    // y TODOS los puntos -> '_'. Si la página ya expone su función, se reutiliza.
    function rutaDeCuenta(email) {
        var base = String(email == null ? '' : email).trim().toLowerCase();
        if (!base) return '';

        try {
            if (typeof window.sanitizeEmailForDb === 'function') {
                var porSanitize = window.sanitizeEmailForDb(base);
                if (porSanitize) return String(porSanitize);
            }
        } catch (e) { /* se sigue con la normalización propia */ }

        try {
            if (typeof window.emailToPath === 'function') {
                var porEmailToPath = window.emailToPath(base);
                if (porEmailToPath) return String(porEmailToPath);
            }
        } catch (e) { /* se sigue con la normalización propia */ }

        return base.replace('@', '_at_').replace(/\./g, '_');
    }

    // Nombre legible para el aviso: 'juan_at_negocio_com' -> 'juan@negocio.com'.
    // Si la marca no tiene la forma esperada, se muestra tal cual.
    function nombreDeCuenta(ruta) {
        var valor = String(ruta == null ? '' : ruta);
        if (!valor) return 'cuenta desconocida';
        var corte = valor.indexOf('_at_');
        if (corte > 0) {
            return valor.slice(0, corte) + '@' + valor.slice(corte + 4).replace(/_/g, '.');
        }
        return valor;
    }

    function leerMarcador() {
        try {
            var valor = localStorage.getItem(CLAVE_MARCADOR);
            return valor ? String(valor) : null;
        } catch (e) {
            return null;
        }
    }

    function escribirMarcador(ruta) {
        try {
            localStorage.setItem(CLAVE_MARCADOR, ruta);
            return true;
        } catch (e) {
            console.warn('[cuenta-local] No se pudo marcar el equipo:', e.message);
            return false;
        }
    }

    // Correo de la sesión en curso. La marca compartida 'sesionActiva' manda; el
    // sessionStorage queda como respaldo por si la pestaña no la tiene copiada.
    // Sin sesión devuelve '': entonces NO se hace nada (de eso se encarga sesion.js).
    function emailDeSesion() {
        try {
            var bruto = localStorage.getItem(CLAVE_SESION);
            if (bruto) {
                var datos = JSON.parse(bruto);
                if (datos && datos.email) return String(datos.email);
            }
        } catch (e) { /* se prueba el respaldo */ }

        try {
            var propietario = sessionStorage.getItem('propietarioActual');
            if (propietario) return String(propietario);
        } catch (e) { /* se prueba el respaldo */ }

        try {
            var dueno = sessionStorage.getItem('currentOwner');
            if (dueno) {
                var perfil = JSON.parse(dueno);
                if (perfil && perfil.email) return String(perfil.email);
            }
        } catch (e) { /* nada */ }

        return '';
    }

    /* ============================ API pública ============================ */

    // Asigna los datos locales del equipo a la cuenta que entra, o comprueba que ya son suyos.
    // Devuelve { estado, dueño, email, motivo } con estado:
    //   'reclamado'  -> no había marca: se asigna a esta cuenta.
    //   'coincide'   -> la marca es de esta misma cuenta.
    //   'ajena'      -> la marca es de OTRA cuenta: hay que bloquear.
    //   'sin-sesion' -> no hay correo: no se toca nada.
    function reclamarOComprobar(email) {
        var ruta = rutaDeCuenta(email);
        var dueno = leerMarcador();

        if (!ruta) {
            return {
                estado: 'sin-sesion',
                dueño: dueno,
                email: '',
                motivo: 'No hay correo de sesión: el marcador del equipo no se toca.'
            };
        }

        if (!dueno) {
            var escrito = escribirMarcador(ruta);
            return {
                estado: 'reclamado',
                dueño: ruta,
                email: ruta,
                motivo: escrito
                    ? 'El equipo no tenía datos asignados: ahora pertenecen a esta cuenta.'
                    : 'No se pudo escribir el marcador del equipo (almacenamiento no disponible).'
            };
        }

        if (dueno === ruta) {
            return {
                estado: 'coincide',
                dueño: dueno,
                email: ruta,
                motivo: 'Los datos locales de este equipo ya pertenecen a esta cuenta.'
            };
        }

        return {
            estado: 'ajena',
            dueño: dueno,
            email: ruta,
            motivo: 'Los datos locales de este equipo pertenecen a otra cuenta (' + dueno + ').'
        };
    }

    // Deja el equipo sin dueño. Lo usa el reinicio de fábrica, después de borrar los datos
    // locales: así la próxima cuenta que entre puede reclamarlos.
    function liberarEquipo() {
        try {
            localStorage.removeItem(CLAVE_MARCADOR);
            return true;
        } catch (e) {
            console.warn('[cuenta-local] No se pudo liberar el equipo:', e.message);
            return false;
        }
    }

    // Cierra la sesión actual y vuelve al login. Solo toca la sesión: los datos de negocio
    // se quedan donde están (el usuario puede descargarlos antes con el botón del aviso).
    function volverAlLogin() {
        try {
            if (typeof window.cerrarSesionApp === 'function') {
                window.cerrarSesionApp(RUTA_LOGIN);
                return;
            }
        } catch (e) {
            console.warn('[cuenta-local] cerrarSesionApp falló:', e.message);
        }

        try { localStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
        try { sessionStorage.clear(); } catch (e) { /* nada */ }
        try {
            window.location.replace(RUTA_LOGIN);
        } catch (e) {
            try { window.location.href = RUTA_LOGIN; } catch (e2) { /* nada */ }
        }
    }

    function avisoYaPuesto() {
        try { return document.getElementById(ID_AVISO); } catch (e) { return null; }
    }

    // El aviso se crea en el <head>, cuando <body> todavía no existe: se cuelga de <html>
    // y en cuanto hay <body> se mueve allí (position:fixed funciona igual en los dos casos).
    function ubicarAviso(capa) {
        if (!capa) return;
        try {
            var destino = document.body || document.documentElement;
            if (destino && capa.parentNode !== destino) destino.appendChild(capa);
        } catch (e) { /* nada */ }
    }

    function crearAviso(info) {
        var capa = document.createElement('div');
        capa.id = ID_AVISO;
        capa.setAttribute('role', 'alertdialog');
        capa.setAttribute('aria-modal', 'true');
        capa.setAttribute('style',
            'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;' +
            'background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center;' +
            'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;' +
            'line-height:1.5;overflow:auto;box-sizing:border-box');

        var texto = document.createElement('p');
        texto.setAttribute('style', 'margin:0;max-width:640px');
        // El texto va por textContent: la marca del equipo nunca puede inyectar HTML.
        texto.textContent = 'Este equipo tiene datos guardados de otra cuenta (' +
            nombreDeCuenta(info && info.dueño) + '). ' +
            'Para no mezclar negocios, esta cuenta no puede usarlos. ' +
            'Descarga una copia de seguridad y consulta con el administrador.';
        capa.appendChild(texto);

        var acciones = document.createElement('div');
        acciones.setAttribute('style',
            'display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;max-width:640px');

        // El botón de descarga solo aparece si la página sabe exportar el respaldo
        // (almacenamiento.js). Si no, se oculta: no se ofrece algo que no funcionaría.
        if (typeof window.descargarRespaldo === 'function') {
            var descargar = document.createElement('button');
            descargar.type = 'button';
            descargar.textContent = 'Descargar copia de seguridad';
            descargar.setAttribute('data-cuenta-accion', 'descargar');
            descargar.setAttribute('style',
                'cursor:pointer;border:0;border-radius:8px;padding:12px 20px;background:#2563eb;' +
                'color:#ffffff;font-size:16px;font-family:inherit;width:100%;max-width:340px');
            descargar.onclick = function () {
                try { window.descargarRespaldo(); }
                catch (e) { console.warn('[cuenta-local] No se pudo descargar el respaldo:', e.message); }
            };
            acciones.appendChild(descargar);
        }

        var volver = document.createElement('button');
        volver.type = 'button';
        volver.textContent = 'Volver al inicio de sesión';
        volver.setAttribute('data-cuenta-accion', 'volver');
        volver.setAttribute('style',
            'cursor:pointer;border:1px solid #334155;border-radius:8px;padding:8px 16px;' +
            'background:transparent;color:#94a3b8;font-size:13px;font-family:inherit');
        volver.onclick = function () { volverAlLogin(); };
        acciones.appendChild(volver);

        capa.appendChild(acciones);
        return capa;
    }

    // Aviso a pantalla completa que deja la página inutilizable. Además frena el arranque:
    // ningún otro manejador de DOMContentLoaded (sesion.js incluido) debe ejecutarse.
    function avisarYBloquearSesionAjena(info) {
        var datos = info || {};
        var capa = avisoYaPuesto();

        if (!capa) {
            try {
                capa = crearAviso(datos);
                ubicarAviso(capa);
            } catch (e) {
                console.warn('[cuenta-local] No se pudo mostrar el aviso:', e.message);
                capa = null;
            }
        }

        if (!bloqueoRegistrado) {
            bloqueoRegistrado = true;
            try {
                document.addEventListener('DOMContentLoaded', function (evento) {
                    ubicarAviso(capa);
                    try { evento.stopImmediatePropagation(); } catch (e) { /* nada */ }
                }, true);
            } catch (e) { /* sin DOM no hay nada más que frenar */ }
        }

        return datos;
    }

    /* ==================== comprobación al cargar la página ==================== */

    // En las páginas de datos el guardián corre al cargar el <head>, con el correo de la
    // sesión. En index.html no hay sesión todavía (o es la misma), así que no estorba: el
    // login vuelve a llamar a reclamarOComprobar() cuando ya conoce el correo.
    function comprobarAlCargar() {
        try {
            var email = emailDeSesion();
            if (!email) return null;                 // sin sesión manda sesion.js
            var info = reclamarOComprobar(email);
            if (info.estado === 'ajena') avisarYBloquearSesionAjena(info);
            return info;
        } catch (e) {
            console.warn('[cuenta-local] No se pudo comprobar la cuenta del equipo:', e.message);
            return null;
        }
    }

    window.cuentaLocal = {
        reclamarOComprobar: reclamarOComprobar,
        avisarYBloquearSesionAjena: avisarYBloquearSesionAjena,
        liberarEquipo: liberarEquipo
    };

    comprobarAlCargar();
})();
