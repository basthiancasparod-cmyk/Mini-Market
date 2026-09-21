/* Tema (modo oscuro/claro) COMPARTIDO por todas las páginas.
 *
 * POR QUÉ EXISTE
 * Antes cada página guardaba el tema a su manera y el ajuste no viajaba de una
 * página a otra. Medido con navegador real (ver _pruebas_tema_oscuro_navegador.js)
 * había CUATRO convenciones distintas:
 *
 *     darkMode = 'enabled'  (7 páginas)   darkMode = 'true'  (index.html)
 *     theme    = 'dark'     (7 páginas)   + config.html usando la clase html.dark
 *
 * y 133 de 225 combinaciones de "pongo oscuro aquí y abro allá" acababan en claro.
 * Este módulo deja UNA sola forma de leer, escribir y pintar el tema.
 *
 * REGLAS
 *   1. CLAVE CANÓNICA: `theme` = 'dark' | 'light'.
 *   2. Se SIGUE LEYENDO `darkMode` ('enabled'/'disabled' y 'true'/'false') para que
 *      nadie pierda el ajuste que ya tenía guardado, y se ESCRIBE también como
 *      espejo, por si queda una pestaña abierta con la versión anterior.
 *   3. Si no hay nada guardado, manda el sistema (`prefers-color-scheme`) mientras
 *      el usuario no elija; en cuanto elige, su elección pesa más.
 *   4. Se pintan LAS DOS clases a la vez:
 *        - `dark`      en <html>  -> es la que usa config.html (variables CSS)
 *        - `dark-mode` en <body>  -> es la que usan las otras 14 páginas
 *      Así ninguna página necesita tocar su CSS y todas se comportan igual.
 *
 * Las claves `theme` y `darkMode` son de EQUIPO, no de negocio: datos_cuenta.js ya
 * las trata como tales (CLAVES_DE_EQUIPO), así que no se prefijan por cuenta.
 * Por eso se escriben con localStorage.setItem directo y NO con guardarLocalSeguro:
 * una cuota llena no debe impedir cambiar de tema.
 */
(function () {
    'use strict';

    var CLAVE = 'theme';            // canónica
    var CLAVE_ESPEJO = 'darkMode';  // heredada
    var CLASE_CUERPO = 'dark-mode'; // la usan 14 páginas en <body>
    var CLASE_RAIZ = 'dark';        // la usa config.html en <html>

    /** Lo guardado, normalizado. null = el usuario nunca eligió. */
    function leerPreferencia() {
        try {
            var temaGuardado = localStorage.getItem(CLAVE);
            if (temaGuardado === 'dark') return true;
            if (temaGuardado === 'light') return false;

            var espejo = localStorage.getItem(CLAVE_ESPEJO);
            if (espejo === 'enabled' || espejo === 'true') return true;
            if (espejo === 'disabled' || espejo === 'false') return false;
        } catch (e) { /* almacén no disponible: se cae al sistema */ }
        return null;
    }

    /** ¿El sistema operativo pide oscuro? */
    function prefiereSistema() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) { return false; }
    }

    /** Estado efectivo: lo elegido o, si no hay nada, lo que pida el sistema. */
    function esOscuro() {
        var elegido = leerPreferencia();
        return elegido === null ? prefiereSistema() : elegido;
    }

    /** Pinta el estado en el documento (las dos clases). */
    function pintar(oscuro) {
        try {
            document.documentElement.classList.toggle(CLASE_RAIZ, !!oscuro);
            if (document.body) document.body.classList.toggle(CLASE_CUERPO, !!oscuro);
        } catch (e) { /* nada */ }
    }

    /** Guarda la elección del usuario en las dos claves. */
    function guardar(oscuro) {
        try {
            localStorage.setItem(CLAVE, oscuro ? 'dark' : 'light');
            localStorage.setItem(CLAVE_ESPEJO, oscuro ? 'enabled' : 'disabled');
        } catch (e) { /* nada: el tema ya está pintado, solo no persiste */ }
    }

    /** Aplica lo guardado (o el sistema) y devuelve si quedó oscuro. */
    function aplicar() {
        var oscuro = esOscuro();
        pintar(oscuro);
        return oscuro;
    }

    /** Cambia de tema, lo guarda y devuelve el estado nuevo. */
    function alternar() {
        var oscuro = !esOscuro();
        guardar(oscuro);
        pintar(oscuro);
        return oscuro;
    }

    /** El usuario elige explícitamente. */
    function fijar(oscuro) {
        guardar(oscuro);
        pintar(oscuro);
        return !!oscuro;
    }

    window.tema = {
        CLAVE: CLAVE,
        CLAVE_ESPEJO: CLAVE_ESPEJO,
        leerPreferencia: leerPreferencia,
        prefiereSistema: prefiereSistema,
        esOscuro: esOscuro,
        pintar: pintar,
        guardar: guardar,
        aplicar: aplicar,
        alternar: alternar,
        fijar: fijar
    };

    // 1) Cuanto antes: en <html> la clase ya se puede poner (evita el fogonazo blanco).
    pintar(esOscuro());

    // 2) En <body> no se puede hasta que exista el elemento.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { pintar(esOscuro()); });
    } else {
        pintar(esOscuro());
    }

    // 3) Mientras el usuario no haya elegido, se sigue al sistema en vivo.
    try {
        var consulta = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (consulta) {
            var alCambiar = function () {
                if (leerPreferencia() === null) pintar(prefiereSistema());
            };
            if (consulta.addEventListener) consulta.addEventListener('change', alCambiar);
            else if (consulta.addListener) consulta.addListener(alCambiar);
        }
    } catch (e) { /* nada */ }
})();
