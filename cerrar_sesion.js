/* Cierre de sesión real.
 *
 * Limpiar sessionStorage NO cierra la sesión de Firebase: mientras el navegador siga
 * autenticado, cualquier página interna volvería a abrirse. Esta función cierra las dos:
 * la de Firebase Authentication y la de la pestaña.
 *
 * Se usa desde páginas que no cargan el SDK (menu.html): si hace falta, lo carga y
 * inicializa antes de cerrar la sesión.
 */
(function () {
    var CONFIG = {
        apiKey: "AIzaSyCyaIC2-pCCQf_mJWGtG6v-0kA1l2Or2CQ",
        authDomain: "mini-market-ciervo-index.firebaseapp.com",
        databaseURL: "https://mini-market-ciervo-index-default-rtdb.firebaseio.com",
        projectId: "mini-market-ciervo-index",
        storageBucket: "mini-market-ciervo-index.firebasestorage.app",
        messagingSenderId: "828978506509",
        appId: "1:828978506509:web:52b6220033072038115e44"
    };

    function cargarScript(src) {
        return new Promise(function (resolver, rechazar) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = function () { resolver(); };
            s.onerror = function () { rechazar(new Error('No se pudo cargar ' + src)); };
            document.head.appendChild(s);
        });
    }

    async function asegurarSDK() {
        if (typeof window.firebase === 'undefined') {
            await cargarScript('https://www.gstatic.com/firebasejs/8.10.0/firebase-app.js');
            await cargarScript('https://www.gstatic.com/firebasejs/8.10.0/firebase-auth.js');
        }
        var fb = window.firebase;
        if (fb && (!fb.apps || fb.apps.length === 0)) {
            fb.initializeApp(CONFIG);
        }
        return window.firebase;
    }

    // La sesión guardada se restaura de forma ASÍNCRONA: al inicializar el SDK,
    // currentUser todavía puede estar vacío aunque haya sesión. Por eso esperamos al
    // primer aviso de Authentication (con o sin usuario) y luego cerramos siempre.
    async function cerrarSesionFirebase() {
        var fb = await asegurarSDK();
        if (!fb || typeof fb.auth !== 'function') return false;
        var auth = fb.auth();

        await new Promise(function (resolver) {
            var resuelto = false;
            function listo() { if (!resuelto) { resuelto = true; resolver(); } }
            try { auth.onAuthStateChanged(listo); } catch (e) { listo(); }
            setTimeout(listo, 3000); // por si Authentication no responde
        });

        // signOut() limpia la sesión guardada aunque currentUser aún no estuviera listo
        await auth.signOut();
        return true;
    }

    // Cierra la sesión de Firebase y la de la pestaña, y manda al login
    window.cerrarSesionApp = async function (destino) {
        var irA = destino || 'index.html';
        try {
            await cerrarSesionFirebase();
        } catch (e) {
            console.warn('[cerrar-sesion] No se pudo cerrar la sesión de Firebase:', e.message);
        }
        // Solo se borra la marca de sesión: localStorage guarda además el inventario,
        // las ventas y la configuración, y no se debe tocar.
        try { localStorage.removeItem('sesionActiva'); } catch (e) { /* nada */ }
        try { sessionStorage.clear(); } catch (e) { /* nada */ }
        window.location.replace(irA);
    };
})();
