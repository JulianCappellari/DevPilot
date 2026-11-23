// Aplica la preferencia de tema antes del primer render (script clásico: la CSP sólo admite archivos locales).
try { const t = localStorage.getItem("devpilot-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch { /* almacenamiento bloqueado */ }
