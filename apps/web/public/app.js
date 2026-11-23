// DevPilot UI: SPA sin build. Todo el contenido dinámico se inserta con textContent (sin innerHTML) por XSS.
const root = document.getElementById("app");
let csrf = "";
let me = null;
let online = true;
let live = null; // EventSource activo

// ---------- utilidades ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fmt = (iso) => (iso ? new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "medium" }) : "—");
const short = (s, n = 10) => (s || "").slice(0, n);

class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function api(method, url, body) {
  let res;
  try {
    res = await fetch("/api/v1" + url, {
      method, credentials: "same-origin",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-csrf-token": csrf } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { setOnline(false); throw new ApiError(0, "OFFLINE", "Sin conexión con DevPilot"); }
  setOnline(true);
  const json = await res.json().catch(() => null);
  if (res.status === 401 && me) { me = null; location.hash = "#/login"; }
  if (!res.ok || json?.error) throw new ApiError(res.status, json?.error?.code, json?.error?.message || "Error " + res.status);
  return json;
}
const data = async (m, u, b) => (await api(m, u, b)).data;

function toast(msg, kind = "info") {
  let box = document.querySelector(".toasts");
  if (!box) { box = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: "toast " + kind }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 6000);
}
const fail = (e) => toast(e.message || "Error", "bad");

function confirmDialog(title, body, okLabel = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    const d = h("dialog", { "aria-labelledby": "dlg-t" },
      h("h2", { id: "dlg-t" }, title), h("p", {}, body),
      h("div", { class: "row end" },
        h("button", { onclick: () => d.close("no") }, "Cancelar"),
        h("button", { class: danger ? "danger" : "primary", onclick: () => d.close("yes") }, okLabel)));
    d.addEventListener("close", () => { resolve(d.returnValue === "yes"); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}

const STATE = {
  DRAFT: ["Borrador", "", "✎"], READY: ["Lista", "info", "●"], QUEUED: ["En cola", "info", "…"], RUNNING: ["Ejecutando", "info", "▶"],
  REVIEW_PENDING: ["Esperando tu revisión", "warn", "!"], APPROVED: ["Aprobada", "ok", "✓"], REJECTED: ["Rechazada", "bad", "✗"],
  NEEDS_CHANGES: ["Requiere cambios", "warn", "↺"], FAILED: ["Falló", "bad", "✗"], TIMED_OUT: ["Tiempo agotado", "bad", "⏱"],
  CANCELLED: ["Cancelada", "", "⊘"], UNKNOWN: ["Estado desconocido", "warn", "?"], PENDING_APPROVAL: ["Esperando tu aprobación", "warn", "!"],
  SUCCEEDED: ["Completada", "ok", "✓"], PARTIAL: ["Parcial", "warn", "◐"], BLOCKED: ["Bloqueada", "bad", "⛔"],
  PASSED: ["Aprobado", "ok", "✓"], ACTIVE: ["Activo", "ok", "●"], INACTIVE: ["Inactivo", "", "○"], ARCHIVED: ["Archivado", "", "▭"],
};
const badge = (s) => { const [t, k, i] = STATE[s] || [s, "", "•"]; return h("span", { class: "badge " + k }, h("span", { "aria-hidden": "true" }, i), t); };
const empty = (t) => h("div", { class: "empty" }, t);

function closeLive() { if (live) { live.close(); live = null; } }

// ---------- layout ----------
function layout(active, ...content) {
  const link = (href, label) => h("a", { href, "aria-current": active === href ? "page" : false }, label);
  root.replaceChildren(...[
    online ? null : h("div", { class: "banner", role: "alert" }, "Sin conexión con DevPilot: el estado mostrado puede estar desactualizado. Las ejecuciones no se asumen canceladas."),
    h("div", { class: "shell" },
      h("nav", { class: "nav", "aria-label": "Principal" },
        h("div", { class: "brand" }, h("span", { "aria-hidden": "true" }, "◆"), "DevPilot"),
        link("#/dashboard", "Panel"), link("#/projects", "Proyectos"), link("#/agents", "Agentes"), link("#/audit", "Auditoría"), link("#/security", "Seguridad"),
        h("div", { class: "spacer" }),
        h("div", { class: "muted small pad" }, me?.username || ""),
        h("button", { onclick: logout }, "Cerrar sesión")),
      h("main", { id: "main", tabindex: "-1" }, ...content))].filter(Boolean));
  document.getElementById("main")?.focus({ preventScroll: true });
}
function setOnline(v) {
  if (v === online) return;
  online = v;
  if (me) route();
}
async function logout() { try { await api("POST", "/auth/logout"); } catch { /* ya expirada */ } me = null; csrf = ""; location.hash = "#/login"; }

// ---------- páginas ----------
function pageLogin() {
  closeLive();
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        const fd = new FormData(form);
        const r = await data("POST", "/auth/login", { username: fd.get("u"), password: fd.get("p") });
        csrf = r.csrfToken; me = { username: r.username };
        location.hash = "#/dashboard";
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "u" }, "Usuario"), h("input", { id: "u", name: "u", autocomplete: "username", required: true, autofocus: true })),
    h("div", { class: "field" }, h("label", { for: "p" }, "Contraseña"), h("input", { id: "p", name: "p", type: "password", autocomplete: "current-password", required: true })),
    err, h("button", { class: "primary", type: "submit" }, "Ingresar"));
  root.replaceChildren(h("div", { class: "login" }, h("h1", {}, "◆ DevPilot"), h("p", { class: "muted" }, "Plano de control local para tus agentes de programación."), h("div", { class: "card" }, form)));
}

async function pageDashboard() {
  const d = await data("GET", "/dashboard");
  const sec = (title, items, render, none) => h("section", { class: "card", "aria-labelledby": "s-" + title }, h("h2", { id: "s-" + title }, title), items.length ? h("ul", { class: "list" }, items.map(render)) : empty(none));
  layout("#/dashboard",
    h("h1", {}, "Panel"), h("p", { class: "muted" }, `${d.stats.projects} proyecto(s) activo(s) · ${d.stats.tasks} tarea(s) · ${d.stats.runs} ejecución(es), ${d.stats.succeeded} completada(s)`),
    h("div", { class: "grid" },
      sec("Ejecutándose", d.running, (r) => h("li", {}, h("a", { href: "#/runs/" + r.id }, r.title), " ", badge(r.state)), "Nada en ejecución."),
      sec("Necesita tu aprobación", d.needsApproval, (r) => h("li", {}, h("a", { href: "#/runs/" + r.id }, r.title), " ", h("span", { class: "muted small" }, r.kind === "start" ? "autorizar inicio" : "revisar diff"), " ", badge(r.kind === "start" ? "PENDING_APPROVAL" : "REVIEW_PENDING")), "Nada pendiente de aprobación."),
      sec("Fallos recientes", d.failed, (r) => h("li", {}, h("a", { href: "#/runs/" + r.id }, r.title), " ", badge(r.state), r.error ? h("div", { class: "muted small" }, r.error) : null), "Sin fallos recientes.")));
}

async function pageProjects() {
  const [projects, roots] = await Promise.all([data("GET", "/projects"), data("GET", "/roots")]);
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      const fd = new FormData(form);
      try {
        const p = await data("POST", "/projects", { name: fd.get("name"), repoPath: fd.get("path"), enabledChecks: fd.getAll("checks") });
        toast("Proyecto registrado", "ok"); location.hash = "#/projects/" + p.id;
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "pn" }, "Nombre"), h("input", { id: "pn", name: "name", required: true, maxlength: 100 })),
    h("div", { class: "field" }, h("label", { for: "pp" }, "Ruta del repositorio"), h("input", { id: "pp", name: "path", required: true, class: "mono", "aria-describedby": "pph" }),
      h("div", { id: "pph", class: "hint" }, roots.some((r) => r.enabled) ? "Debe estar dentro de una raíz autorizada." : "Primero autorizá una raíz en Seguridad.")),
    h("fieldset", { class: "field plain" }, h("legend", { class: "lg" }, "Checks de QA permitidos"),
      ["lint", "test", "typecheck"].map((c) => h("label", { class: "chk" }, h("input", { type: "checkbox", name: "checks", value: c }), c))),
    err, h("button", { class: "primary", type: "submit" }, "Registrar repositorio"));
  layout("#/projects", h("h1", {}, "Proyectos"),
    h("div", { class: "card" }, projects.length ? h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Proyecto", "Estado", "Tareas abiertas", "Ruta"].map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, projects.map((p) => h("tr", {}, h("td", {}, h("a", { href: "#/projects/" + p.id }, p.name)), h("td", {}, badge(p.status)), h("td", {}, p.openTasks), h("td", { class: "mono" }, p.path)))))) : empty("Todavía no registraste repositorios.")),
    h("div", { class: "card" }, h("h2", {}, "Registrar repositorio"), form));
}

const TYPES = ["bug", "feature", "refactor", "docs", "test", "chore"];
const PRIOS = ["low", "medium", "high", "critical"];
const opt = (v, sel) => h("option", { value: v, selected: v === sel }, v);

async function pageProject(id) {
  const [p, git] = await Promise.all([data("GET", "/projects/" + id), data("GET", `/projects/${id}/git`).catch(() => null)]);
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      const fd = new FormData(form);
      const ac = String(fd.get("ac") || "").split("\n").map((s) => s.trim()).filter(Boolean);
      try {
        const t = await data("POST", "/tasks", { projectId: id, title: fd.get("title"), description: fd.get("desc") || undefined, type: fd.get("type"), priority: fd.get("priority"), acceptanceCriteria: ac });
        toast(t.state === "READY" ? "Tarea creada y lista" : "Tarea creada como borrador: faltan criterios", "ok"); location.hash = "#/tasks/" + t.id;
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "tt" }, "Título"), h("input", { id: "tt", name: "title", required: true, minlength: 3, maxlength: 200 })),
    h("div", { class: "field" }, h("label", { for: "td" }, "Descripción (opcional)"), h("textarea", { id: "td", name: "desc", maxlength: 10000 })),
    h("div", { class: "grid" },
      h("div", { class: "field" }, h("label", { for: "ty" }, "Tipo"), h("select", { id: "ty", name: "type" }, TYPES.map((t) => opt(t, "feature")))),
      h("div", { class: "field" }, h("label", { for: "pr" }, "Prioridad"), h("select", { id: "pr", name: "priority" }, PRIOS.map((t) => opt(t, "medium"))))),
    h("div", { class: "field" }, h("label", { for: "ta" }, "Criterios de aceptación (uno por línea)"), h("textarea", { id: "ta", name: "ac", "aria-describedby": "tah" }), h("div", { id: "tah", class: "hint" }, "Sin criterios la tarea queda en borrador y no se puede ejecutar.")),
    err, h("button", { class: "primary", type: "submit" }, "Crear tarea"));
  const listBox = h("div", { "aria-live": "polite" });
  const fq = h("input", { type: "search", placeholder: "Buscar por título", "aria-label": "Buscar tareas", maxlength: 100 });
  const fs = h("select", { "aria-label": "Filtrar por estado" }, h("option", { value: "" }, "Todos los estados"),
    ["DRAFT", "READY", "QUEUED", "RUNNING", "REVIEW_PENDING", "APPROVED", "REJECTED", "NEEDS_CHANGES", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].map((k) => h("option", { value: k }, STATE[k][0])));
  const so = h("select", { "aria-label": "Ordenar tareas" }, h("option", { value: "updated" }, "Más recientes"), h("option", { value: "priority" }, "Por prioridad"), h("option", { value: "created" }, "Por creación"));
  const ar = h("input", { type: "checkbox", "aria-label": "Mostrar archivadas" });
  let timer;
  const loadTasks = async () => {
    try {
      const qs = new URLSearchParams({ sort: so.value, archived: String(ar.checked) });
      if (fs.value) qs.set("state", fs.value);
      if (fq.value.trim()) qs.set("q", fq.value.trim());
      const tasks = await data("GET", `/projects/${id}/tasks?${qs}`);
      listBox.replaceChildren(tasks.length ? h("ul", { class: "list" }, tasks.map((t) => h("li", { class: "row between" }, h("span", {}, h("a", { href: "#/tasks/" + t.id }, t.title), " ", h("span", { class: "muted small" }, `${t.type} · ${t.priority}`)), badge(t.state))))
        : empty(fq.value || fs.value || ar.checked ? "Ninguna tarea coincide con los filtros." : "Sin tareas. Creá la primera abajo."));
    } catch (e) { fail(e); }
  };
  fq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadTasks, 250); });
  for (const el of [fs, so, ar]) el.addEventListener("change", loadTasks);
  const toggle = async (status) => { try { await data("PATCH", "/projects/" + id, { version: p.version, status }); route(); } catch (e) { fail(e); } };
  layout("#/projects",
    h("p", {}, h("a", { href: "#/projects" }, "← Proyectos")),
    h("div", { class: "row between" }, h("div", {}, h("h1", {}, p.name), h("div", { class: "muted mono small" }, p.path)), h("div", { class: "row" }, badge(p.status),
      p.status === "ACTIVE" ? h("button", { onclick: () => toggle("ARCHIVED") }, "Archivar") : h("button", { onclick: () => toggle("ACTIVE") }, "Reactivar"))),
    h("div", { class: "card" }, git ? h("div", { class: "row" }, "Rama ", h("code", {}, git.branch), git.dirty ? badge("UNKNOWN") && h("span", { class: "badge warn" }, `${git.changedFiles} cambio(s) sin commitear`) : h("span", { class: "badge ok" }, "limpio"), git.lastCommit ? h("span", { class: "muted small" }, `${short(git.lastCommit.sha, 7)} ${git.lastCommit.subject}`) : null) : h("span", { class: "muted" }, "No se pudo leer el estado Git."),
      h("div", { class: "muted small" }, "Checks habilitados: " + (p.enabledChecks.join(", ") || "ninguno"))),
    h("div", { class: "card" }, h("h2", {}, "Tareas"), h("div", { class: "row filters" }, fq, fs, so, h("label", { class: "chk" }, ar, "Archivadas")), listBox),
    h("div", { class: "card" }, h("h2", {}, "Nueva tarea"), form));
  loadTasks();
}

async function pageTask(id) {
  const t = await data("GET", "/tasks/" + id);
  const prov = await data("GET", "/providers");
  const sel = h("select", { id: "prov" }, prov.providers.filter((p) => p.id !== "ollama").map((p) => h("option", { value: p.id, disabled: !p.available }, `${p.id}${p.available ? "" : " (no disponible)"} · ${p.costOrigin}`)));
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, "ok"); route(); } catch (e) { fail(e); } };
  const EDITABLE = ["DRAFT", "READY", "NEEDS_CHANGES", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"];
  const eErr = h("p", { class: "hint err", role: "alert" });
  const eForm = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); eErr.textContent = "";
      const fd = new FormData(eForm);
      try {
        await data("PATCH", "/tasks/" + id, { version: t.version, title: fd.get("title"), description: fd.get("desc") || null, type: fd.get("type"), priority: fd.get("priority"),
          acceptanceCriteria: String(fd.get("ac") || "").split("\n").map((x) => x.trim()).filter(Boolean) });
        toast("Tarea actualizada", "ok"); route();
      } catch (ex) { eErr.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "et" }, "Título"), h("input", { id: "et", name: "title", value: t.title, required: true, minlength: 3, maxlength: 200 })),
    h("div", { class: "field" }, h("label", { for: "ed" }, "Descripción"), h("textarea", { id: "ed", name: "desc" }, t.description || "")),
    h("div", { class: "grid" },
      h("div", { class: "field" }, h("label", { for: "ety" }, "Tipo"), h("select", { id: "ety", name: "type" }, TYPES.map((x) => opt(x, t.type)))),
      h("div", { class: "field" }, h("label", { for: "epr" }, "Prioridad"), h("select", { id: "epr", name: "priority" }, PRIOS.map((x) => opt(x, t.priority))))),
    h("div", { class: "field" }, h("label", { for: "eac" }, "Criterios de aceptación (uno por línea)"), h("textarea", { id: "eac", name: "ac" }, t.acceptanceCriteria.join("\n"))),
    eErr, h("button", { class: "primary", type: "submit" }, "Guardar cambios"));
  const editCard = h("div", { class: "card" },
    EDITABLE.includes(t.state) ? h("details", {}, h("summary", {}, "Editar tarea"), h("div", { class: "stack" }, eForm)) : h("p", { class: "muted small" }, "La tarea no se puede editar en el estado actual."),
    !["QUEUED", "RUNNING"].includes(t.state) && !t.archived ? h("p", {}, h("button", { class: "danger", onclick: async () => { if (await confirmDialog("Archivar tarea", "La tarea y su historial se conservan; deja de aparecer en la lista.", "Archivar", true)) { try { await data("POST", `/tasks/${id}/archive`); toast("Tarea archivada", "ok"); location.hash = "#/projects/" + t.projectId; } catch (ex) { fail(ex); } } } }, "Archivar tarea")) : null,
    t.archived ? h("p", { class: "muted small" }, "Esta tarea está archivada.") : null);
  const c = t.classification;
  layout("#/projects",
    h("p", {}, h("a", { href: "#/projects/" + t.projectId }, "← " + t.project.name)),
    h("div", { class: "row between" }, h("h1", {}, t.title), badge(t.state)),
    h("p", { class: "muted" }, `${t.type} · prioridad ${t.priority}`), t.description ? h("p", {}, t.description) : null,
    h("div", { class: "card" }, h("h2", {}, "Criterios de aceptación"), t.acceptanceCriteria.length ? h("ul", {}, t.acceptanceCriteria.map((a) => h("li", {}, a))) : empty("Sin criterios: la tarea no puede ejecutarse.")),
    editCard,
    h("div", { class: "card" }, h("h2", {}, "Clasificación con IA local"),
      c ? h("div", {}, h("p", {}, h("strong", {}, c.category), ` · prioridad sugerida ${c.suggestedPriority} · confianza ${Math.round(c.confidence * 100)}%`), h("p", { class: "muted" }, c.summary),
        h("p", { class: "hint" }, `Propuesta no vinculante (${c.source}${c.model ? " " + c.model : ""}). ${c.note || ""}`)) : h("p", { class: "muted" }, "Sin clasificar."),
      h("button", { onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Clasificando… (puede tardar si el modelo se está cargando)"; act(() => data("POST", `/tasks/${id}/classify`), "Clasificada"); } }, "Clasificar")),
    h("div", { class: "card" }, h("h2", {}, "Ejecutar"),
      t.state === "DRAFT" ? h("div", {}, h("p", { class: "muted" }, "Borrador. Agregá criterios y marcala como lista."), h("button", { disabled: !t.acceptanceCriteria.length, onclick: () => act(() => data("POST", `/tasks/${id}/transition`, { to: "READY", version: t.version }), "Tarea lista") }, "Marcar como lista"))
      : t.state === "READY" ? h("div", { class: "row" }, h("label", { for: "prov", class: "small" }, "Proveedor"), sel,
        h("button", { class: "primary", onclick: () => act(async () => { const r = await data("POST", `/tasks/${id}/runs`, { providerId: sel.value }); location.hash = "#/runs/" + r.id; }) }, "Solicitar ejecución"))
      : ["NEEDS_CHANGES", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"].includes(t.state) ? h("div", {}, h("p", { class: "muted" }, "Un nuevo intento no borra el anterior."), h("button", { onclick: () => act(() => data("POST", `/tasks/${id}/transition`, { to: "READY", version: t.version }), "Lista para un nuevo intento") }, "Preparar nuevo intento"))
      : h("p", { class: "muted" }, "Estado actual: " + (STATE[t.state]?.[0] || t.state))),
    h("div", { class: "card" }, h("h2", {}, "Ejecuciones"), t.runs.length ? h("ul", { class: "list" }, t.runs.map((r) => h("li", { class: "row between" }, h("a", { href: "#/runs/" + r.id }, `Intento ${r.attempt} · ${r.providerId} · ${fmt(r.createdAt)}`), badge(r.state)))) : empty("Todavía no hay ejecuciones.")),
    h("div", { class: "card" }, h("h2", {}, "Historial de estados"), h("ul", { class: "list small" }, t.history.map((x) => h("li", {}, `${fmt(x.at)} · ${x.from || "—"} → ${x.to}`, x.reason ? ` · ${x.reason}` : "")))));
}

function renderDiff(patch) {
  const box = h("div", { class: "diff", tabindex: "0", role: "region", "aria-label": "Diff" });
  for (const line of patch.split("\n")) {
    const k = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    box.append(h("div", { class: k }, line || " "));
  }
  return box;
}

async function pageRun(id) {
  const r = await data("GET", "/runs/" + id);
  const diff = await data("GET", `/runs/${id}/diff`);
  const timeline = h("ul", { class: "timeline", "aria-live": "polite", "aria-label": "Eventos de la ejecución" });
  const status = h("span", {}, badge(r.state));
  const conn = h("span", { class: "muted small" });
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, "ok"); route(); } catch (e) { fail(e); } };
  const allPassed = r.checks.length > 0 && r.checks.every((c) => c.state === "PASSED");
  const reason = h("input", { id: "rsn", maxlength: 500, "aria-describedby": "rsnh" });
  const override = h("input", { type: "checkbox", id: "ovr" });
  const review = async (decision) => {
    const approve = decision === "approve";
    if (approve && !(await confirmDialog("Aprobar cambios", "Se creará un commit en la rama de la tarea. No se hará merge, push ni deploy.", "Aprobar"))) return;
    if (!approve && !(await confirmDialog(decision === "reject" ? "Rechazar" : "Pedir cambios", "La evidencia de esta ejecución se conserva.", "Confirmar", true))) return;
    act(() => data("POST", `/runs/${id}/review`, { decision, diffHash: diff.diffHash, reason: reason.value || undefined, overrideQa: override.checked }), approve ? "Cambios aprobados" : "Decisión registrada");
  };
  layout("#/projects",
    h("p", {}, h("a", { href: "#/tasks/" + r.task.id }, "← " + r.task.title)),
    h("div", { class: "row between" }, h("h1", {}, `Ejecución · intento ${r.attempt}`), status),
    h("p", { class: "muted small mono" }, `${r.providerId} · ${r.branch || "sin rama"} · inicio ${fmt(r.startedAt)} · fin ${fmt(r.finishedAt)}`),
    r.error ? h("div", { class: "warnbox", role: "alert" }, r.error) : null,
    r.state === "PENDING_APPROVAL" ? h("div", { class: "card" }, h("h2", {}, "Autorizar inicio"), h("p", {}, "Se creará un worktree aislado y el agente podrá modificar archivos en él. Nada se integra al repositorio principal sin tu aprobación."),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => act(() => data("POST", `/runs/${id}/approve-start`), "Ejecución en cola") }, "Aprobar e iniciar"), h("button", { class: "danger", onclick: () => act(() => data("POST", `/runs/${id}/cancel`), "Cancelada") }, "Cancelar"))) : null,
    ["QUEUED", "RUNNING"].includes(r.state) ? h("div", { class: "row" }, h("button", { class: "danger", onclick: async () => { if (await confirmDialog("Cancelar ejecución", "Se terminará el proceso del agente.", "Cancelar ejecución", true)) act(() => data("POST", `/runs/${id}/cancel`), "Cancelación solicitada"); } }, "Cancelar ejecución"), conn) : null,
    h("div", { class: "card" }, h("h2", {}, "Línea de tiempo"), timeline),
    h("div", { class: "card" }, h("h2", {}, "Checks de QA"),
      r.checks.length ? h("ul", { class: "list" }, r.checks.map((c) => h("li", {}, h("div", { class: "row between" }, h("strong", {}, c.commandId), h("span", {}, badge(c.state), ` exit ${c.exitCode ?? "—"} · ${c.durationMs} ms`)),
        h("button", { class: "small", onclick: async (e) => { const o = await data("GET", `/runs/${id}/checks`); const x = o.find((y) => y.id === c.id); const li = e.target.closest("li"); li.querySelector("pre")?.remove(); li.append(h("pre", { class: "log" }, (x.stdout + (x.stderr ? "\n[stderr]\n" + x.stderr : "")).trim() || "(sin salida)")); } }, "Ver salida")))) : empty("Sin checks ejecutados: no hay evidencia de QA.")),
    h("div", { class: "card" }, h("h2", {}, "Cambios"),
      diff.warnings.map((w) => h("div", { class: "warnbox", role: "alert" }, "⚠ " + w.message)),
      diff.files.length ? h("div", {}, h("ul", { class: "list small" }, diff.files.map((f) => h("li", {}, h("span", { class: "badge" }, f.status), " ", h("code", {}, f.path)))), renderDiff(diff.patch)) : empty("Sin archivos modificados."),
      diff.diffHash ? h("p", { class: "hint mono" }, "diffHash " + short(diff.diffHash, 16) + "…") : null),
    r.task.state === "REVIEW_PENDING" && r.state === "SUCCEEDED" ? h("div", { class: "card" }, h("h2", {}, "Tu decisión"),
      allPassed ? h("p", { class: "muted" }, "Todos los checks pasaron con evidencia.") : h("div", { class: "warnbox" }, "Hay checks sin aprobar o sin evidencia. Para aprobar igual necesitás una excepción con motivo."),
      h("div", { class: "field" }, h("label", { for: "rsn" }, "Motivo (obligatorio si aprobás con excepción)"), reason, h("div", { id: "rsnh", class: "hint" }, "Queda en la auditoría.")),
      allPassed ? null : h("div", { class: "field" }, h("label", { for: "ovr", class: "chk" }, override, "Aprobar con excepción de QA")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => review("approve") }, "Aprobar"), h("button", { onclick: () => review("needs_changes") }, "Pedir cambios"), h("button", { class: "danger", onclick: () => review("reject") }, "Rechazar"))) : null,
    r.deliveredCommit ? h("div", { class: "card" }, h("h2", {}, "Entregado"), h("p", {}, "Rama ", h("code", {}, r.branch), " · commit ", h("code", {}, short(r.deliveredCommit, 10)), ". Integrá la rama manualmente cuando quieras.")) : null,
    h("div", { class: "card" }, h("h2", {}, "Aprobaciones"), r.approvals.length ? h("ul", { class: "list small" }, r.approvals.map((a) => h("li", {}, `${fmt(a.createdAt)} · ${a.action} · ${a.decision}${a.reason ? " · " + a.reason : ""}`))) : empty("Sin aprobaciones registradas.")));

  // SSE con reanudación automática por Last-Event-ID; reconectar no implica cancelada (RN-013).
  closeLive();
  const addEv = (type, p) => {
    if (p.state && (type === "run.state" || type === "run.completed")) status.replaceChildren(badge(p.state)); // la insignia sigue al estado real
    const msg = p.message || p.text || (p.state ? "Estado: " + p.state : "") || p.path || (p.commandId ? `check ${p.commandId}: ${p.state}` : "");
    timeline.append(h("li", {}, h("span", { class: "muted small" }, new Date(p.at || Date.now()).toLocaleTimeString("es-AR") + " "), type.replace("run.", "") + (msg ? " · " + msg : "")));
    timeline.scrollTop = timeline.scrollHeight;
  };
  const types = ["run.progress", "run.log", "run.file_changed", "run.check.finished", "run.state", "run.completed", "run.error"];
  const es = new EventSource(`/api/v1/runs/${id}/events`);
  live = es;
  for (const t of types) es.addEventListener(t, (e) => { conn.textContent = ""; try { addEv(t, JSON.parse(e.data)); } catch { /* evento ilegible */ } });
  es.addEventListener("run.end", () => { es.close(); live = null; if (["QUEUED", "RUNNING"].includes(r.state) || r.state === "PENDING_APPROVAL") route(); });
  es.onerror = () => { conn.textContent = "Reconectando… la ejecución no se considera cancelada."; };
}

async function pageAgents() {
  const r = await data("GET", "/providers");
  layout("#/agents", h("h1", {}, "Agentes y proveedores"),
    r.paidApisEnabled ? h("div", { class: "warnbox" }, "Las APIs de pago están habilitadas.") : h("p", { class: "muted" }, "APIs de pago deshabilitadas (costo adicional: USD 0)."),
    h("div", { class: "grid" }, r.providers.map((p) => h("div", { class: "card" }, h("h3", {}, p.id), h("div", { class: "row" }, h("span", { class: "badge " + (p.available ? "ok" : "bad") }, p.available ? "✓ Disponible" : "✗ No disponible"), h("span", { class: "badge" }, p.costOrigin)), h("p", { class: "muted small" }, p.detail || (p.canWriteCode ? "Puede escribir código" : "Sólo análisis"))))));
}

async function pageAudit() {
  const rows = await data("GET", "/audit?limit=100");
  layout("#/audit", h("h1", {}, "Auditoría"), h("p", { class: "muted" }, "Registro append-only de acciones críticas."),
    h("div", { class: "card tablewrap" }, rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Fecha", "Acción", "Entidad", "Resultado", "Detalle"].map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, rows.map((a) => h("tr", {}, h("td", { class: "small" }, fmt(a.createdAt)), h("td", {}, a.action), h("td", { class: "mono small" }, `${a.entityType}${a.entityId ? " " + short(a.entityId, 14) : ""}`), h("td", {}, h("span", { class: "badge " + (a.outcome === "OK" ? "ok" : "bad") }, a.outcome === "OK" ? "✓ OK" : "✗ " + a.outcome)), h("td", { class: "mono small" }, a.detail || ""))))) : empty("Sin eventos.")));
}

async function pageSecurity() {
  const [roots, sessions] = await Promise.all([data("GET", "/roots"), data("GET", "/auth/sessions")]);
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", { onsubmit: async (e) => { e.preventDefault(); err.textContent = ""; try { await data("POST", "/roots", { path: new FormData(form).get("path") }); toast("Raíz autorizada", "ok"); route(); } catch (ex) { err.textContent = ex.message; } } },
    h("div", { class: "field" }, h("label", { for: "rp" }, "Carpeta a autorizar"), h("input", { id: "rp", name: "path", class: "mono", required: true })), err, h("button", { class: "primary", type: "submit" }, "Autorizar raíz"));
  layout("#/security", h("h1", {}, "Seguridad"),
    h("div", { class: "card" }, h("h2", {}, "Raíces autorizadas"), roots.length ? h("ul", { class: "list" }, roots.map((x) => h("li", { class: "row between" }, h("code", {}, x.path),
      h("button", { onclick: async () => { try { await data("PATCH", "/roots/" + x.id, { enabled: !x.enabled }); route(); } catch (e) { fail(e); } } }, x.enabled ? "Deshabilitar" : "Habilitar")))) : empty("No hay raíces. Los repositorios sólo pueden registrarse dentro de una raíz autorizada."), form),
    h("div", { class: "card" }, h("h2", {}, "Sesiones"), h("ul", { class: "list small" }, sessions.map((s) => h("li", {}, `${fmt(s.created_at)} · ${s.ip || "?"}`, s.current ? " · (actual)" : "", s.revoked_at ? " · revocada" : ""))),
      h("button", { onclick: async () => { try { const r = await data("POST", "/auth/revoke-others"); toast(`${r.revoked} sesión(es) revocada(s)`, "ok"); route(); } catch (e) { fail(e); } } }, "Revocar otras sesiones")));
}

// ---------- router ----------
async function route() {
  const hash = location.hash || "#/dashboard";
  const [, a, b] = hash.split("/");
  if (!me) {
    try { const m = await data("GET", "/auth/me"); csrf = m.csrfToken; me = { username: m.username }; } catch { if (a !== "login") { location.hash = "#/login"; return; } }
  }
  if (a === "login") { if (me) { location.hash = "#/dashboard"; return; } return pageLogin(); }
  closeLive();
  try {
    if (a === "dashboard") await pageDashboard();
    else if (a === "projects") await (b ? pageProject(b) : pageProjects());
    else if (a === "tasks" && b) await pageTask(b);
    else if (a === "runs" && b) await pageRun(b);
    else if (a === "agents") await pageAgents();
    else if (a === "audit") await pageAudit();
    else if (a === "security") await pageSecurity();
    else location.hash = "#/dashboard";
  } catch (e) {
    if (e.status === 401) return;
    layout("", h("h1", {}, "No se pudo cargar"), h("div", { class: "warnbox", role: "alert" }, e.message), h("button", { onclick: route }, "Reintentar"));
  }
}
window.addEventListener("hashchange", route);
setInterval(async () => { try { const r = await fetch("/api/v1/health", { cache: "no-store" }); setOnline(r.ok); } catch { setOnline(false); } }, 10000);
route();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* PWA opcional */ });
