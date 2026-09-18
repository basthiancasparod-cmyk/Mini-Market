/* Control de sesión para las páginas internas.
 *
 * Se incluye al FINAL del <body>, después del script propio de cada página, y hace dos cosas:
 *
 *   1. FRENA el arranque de la página hasta comprobar la sesión. Es imprescindible hacerlo
 *      aquí y no solo dentro de initFirebase: varias páginas muestran sus datos desde
 *      localStorage SIN tocar Firebase (por ejemplo cuando el Cloud Sync está apagado o no
 *      hay sesión), así que envolver initFirebase no bastaba y la página se abría igual.
 *
 *   2. Exige DOS sesiones:
 *        - la de la APLICACIÓN: la marca compartida 'sesionActiva' en localStorage
 *          (compartida por todas las pestañas; es la que borra "Cerrar sesión").
 *        - la de FIREBASE AUTHENTICATION, que es la que permiten las reglas de la base.
 *
 * Además envuelve initFirebase para que, cuando la página pida la base, la sesión de Firebase
 * ya esté comprobada (necesario en las páginas que cargan el SDK de forma dinámica).
 */
(function () {
    var RUTA_LOGIN = 'index.html';
    var CLAVE_SESION = 'sesionActiva';
    var promesaSesion = null;
    var yaListo = false;

    function irAlLogin(motivo) {
        try { sessionStorage.clear(); } catch (e) { /* nada */ }
        try { localStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
        console.warn('[sesion] ' + (motivo || 'Sin sesión activa.'));
        // Aviso visible: así se distingue "me bloqueó" de "me dejó pasar"
        try {
            var capa = document.createElement('div');
            capa.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-family:system-ui,sans-serif;text-align:center;padding:24px');
            capa.innerHTML = '<strong style="font-size:1.25rem">Sesión no activa</strong>' +
                '<span style="color:#94a3b8">' + (motivo || '') + '</span>' +
                '<span style="color:#94a3b8">Volviendo al inicio de sesión…</span>';
            document.body.appendChild(capa);
        } catch (e) { /* nada */ }
        setTimeout(function () { window.location.replace(RUTA_LOGIN); }, 900);
    }

    function leerMarcaDeSesion() {
        try {
            var bruto = localStorage.getItem(CLAVE_SESION);
            if (!bruto) return null;
            var datos = JSON.parse(bruto);
            return (datos && datos.email) ? datos : null;
        } catch (e) {
            return null;
        }
    }

    // Espera el veredicto de Firebase Authentication.
    // Devuelve el usuario, 'sin-sesion' o 'sin-comprobacion' (SDK no disponible).
    function esperarSesionDeFirebase() {
        return new Promise(function (resolver) {
            var resuelto = false;
            function terminar(estado) {
                if (resuelto) return;
                resuelto = true;
                resolver(estado);
            }

            if (!window.firebase || typeof firebase.auth !== 'function') {
                return terminar('sin-comprobacion');
            }

            try {
                firebase.auth().onAuthStateChanged(function (usuario) {
                    if (!usuario) { irAlLogin('No hay sesión de Firebase.'); terminar('sin-sesion'); return; }
                    terminar(usuario);
                });
            } catch (e) {
                console.warn('[sesion] No se pudo comprobar la sesión de Firebase:', e.message);
                terminar('sin-comprobacion');
            }

            setTimeout(function () {
                if (resuelto) return;
                var actual = null;
                try { actual = firebase.auth().currentUser; } catch (e) { /* nada */ }
                if (actual) {
                    console.warn('[sesion] Firebase tardó; se usa la sesión en memoria.');
                    terminar(actual);
                } else {
                    irAlLogin('Firebase no respondió.');
                    terminar('sin-sesion');
                }
            }, 10000);
        });
    }

    // Comprueba la marca de la aplicación y, si el SDK ya está, también la de Firebase.
    function iniciarSesion() {
        if (promesaSesion) return promesaSesion;

        promesaSesion = (async function () {
            var marca = leerMarcaDeSesion();
            if (!marca) {
                irAlLogin('No hay sesión activa en este equipo.');
                return 'sin-sesion';
            }
            // Mantener la ruta de datos que usan las páginas internas
            try {
                if (!sessionStorage.getItem('propietarioActual')) {
                    sessionStorage.setItem('propietarioActual', marca.email);
                }
            } catch (e) { /* nada */ }
            return esperarSesionDeFirebase();
        })();

        return promesaSesion;
    }

    Object.defineProperty(window, 'sesionLista', { get: iniciarSesion, configurable: true });

    // Envuelve initFirebase: cuando la página pida la base, la sesión ya debe estar comprobada
    if (typeof window.initFirebase === 'function') {
        var original = window.initFirebase;
        window.initFirebase = async function () {
            // 1) Carga e inicializa el SDK (en varias páginas es dinámico)
            var base = await original.apply(this, arguments);
            // 2) Exige la sesión de la aplicación
            var estado = await window.sesionLista;
            if (estado === 'sin-sesion') return new Promise(function () { /* nunca resuelve: se redirige */ });
            // 3) Si antes no se pudo comprobar (el SDK aún no estaba), se comprueba ahora
            if (estado === 'sin-comprobacion') {
                var estado2 = await esperarSesionDeFirebase();
                if (estado2 === 'sin-sesion') return new Promise(function () { /* nunca resuelve */ });
            }
            return base;
        };
    }

    // Freno del arranque de la página: se registra en fase de captura, así corre antes que
    // los manejadores de la página. Se hace SIEMPRE (no solo cuando falta initFirebase),
    // porque las páginas también pintan datos desde localStorage sin tocar Firebase.
    document.addEventListener('DOMContentLoaded', function (evento) {
        if (yaListo) return;
        evento.stopImmediatePropagation();
        window.sesionLista.then(function (estado) {
            if (estado === 'sin-sesion') return; // ya se está redirigiendo al login
            yaListo = true;
            document.dispatchEvent(new Event('DOMContentLoaded'));
        });
    }, true);
})();
