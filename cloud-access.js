/* Control central de la suscripción Cloud Sync. */
(function () {
    const CACHE_KEY = 'cloudSync';
    const EMAIL_KEY = 'cloudSyncEmail';
    let pendingCheck = null;
    window.checkCloudAccess = async function () {
        const email = typeof window.getCurrentUserEmail === 'function' ? window.getCurrentUserEmail() : null;
        if (!email || typeof window.initFirebase !== 'function') return false;
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (sessionStorage.getItem(EMAIL_KEY) === email && (cached === 'true' || cached === 'false')) return cached === 'true';
        if (pendingCheck) return pendingCheck;
        pendingCheck = (async () => {
            let allowed = false;
            let database = null;
            try {
                database = await window.initFirebase();
                if (database) {
                    const safeEmail = typeof window.sanitizeEmailForDb === 'function' ? window.sanitizeEmailForDb(email) : email.replace('@', '_at_').replace(/\./g, '_');
                    allowed = (await database.ref('BBDD/' + safeEmail + '/suscripcion/cloudSync').once('value')).val() === true;
                }
            } catch (_) { allowed = false; }
            sessionStorage.setItem(EMAIL_KEY, email);
            sessionStorage.setItem(CACHE_KEY, String(allowed));
            if (allowed && database && typeof window.setupConnectionMonitor === 'function') {
                window.setupConnectionMonitor(database);
            }
            return allowed;
        })();
        try { return await pendingCheck; } finally { pendingCheck = null; }
    };
})();
