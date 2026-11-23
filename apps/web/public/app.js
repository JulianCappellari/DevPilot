// DevPilot UI: SPA sin build. Todo el contenido dinámico se inserta con textContent (sin innerHTML) por XSS.
import { icon } from "./ui/icons.js";
import { enter, leave, pulse, reduced } from "./ui/motion.js";

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
  const t = h("div", { class: "toast " + kind }, icon(kind === "ok" ? "circleCheck" : kind === "bad" ? "alert" : "dot"), h("span", {}, msg));
  box.append(t);
  enter(t);
  setTimeout(async () => { await leave(t); t.remove(); }, 6000);
}
const fail = (e) => toast(e.message || "Error", "bad");

function confirmDialog(title, body, okLabel = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    const finish = async (value) => { await leave(d, { y: 4 }); d.close(value); };
    const d = h("dialog", { "aria-labelledby": "dlg-t" },
      h("h2", { id: "dlg-t" }, title), h("p", {}, body),
      h("div", { class: "row end" },
        h("button", { onclick: () => finish("no") }, "Cancelar"),
        h("button", { class: danger ? "danger" : "primary", onclick: () => finish("yes") }, okLabel)));
    d.addEventListener("close", () => { resolve(d.returnValue === "yes"); d.remove(); });
    document.body.append(d);
    d.showModal();
    enter(d, { y: 10 });
  });
}

// Marca un botón como ocupado mientras corre una promesa y evita dobles envíos.
async function busy(button, fn) {
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

const STATE = {
  DRAFT: ["Borrador", "", "pencil"], READY: ["Lista", "info", "circleCheck"], QUEUED: ["En cola", "info", "clock"], RUNNING: ["Ejecutando", "info", "spinner"],
  REVIEW_PENDING: ["Esperando tu revisión", "warn", "alert"], APPROVED: ["Aprobada", "ok", "check"], REJECTED: ["Rechazada", "bad", "x"],
  NEEDS_CHANGES: ["Requiere cambios", "warn", "retry"], FAILED: ["Falló", "bad", "x"], TIMED_OUT: ["Tiempo agotado", "bad", "timer"],
  CANCELLED: ["Cancelada", "", "ban"], UNKNOWN: ["Estado desconocido", "warn", "help"], PENDING_APPROVAL: ["Esperando tu aprobación", "warn", "alert"],
  SUCCEEDED: ["Completada", "ok", "check"], PARTIAL: ["Parcial", "warn", "half"], BLOCKED: ["Bloqueada", "bad", "ban"],
  PASSED: ["Aprobado", "ok", "check"], ACTIVE: ["Activo", "ok", "dot"], INACTIVE: ["Inactivo", "", "circle"], ARCHIVED: ["Archivado", "", "archive"],
};
const badge = (s) => { const [t, k, i] = STATE[s] || [s, "", "dot"]; return h("span", { class: "badge " + k }, icon(i, i === "spinner" ? "spin" : ""), t); };
const empty = (t, ic = "inbox") => h("div", { class: "empty" }, icon(ic), t);
const back = (href, label) => h("a", { class: "back", href }, icon("back"), label);
const head = (title, lede, ...actions) => h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), lede ? h("p", {}, lede) : null), actions.length ? h("div", { class: "row" }, ...actions) : null);

function closeLive() { if (live) { live.close(); live = null; } }

// ---------- layout ----------
const NAV = [
  ["Trabajo", [["#/dashboard", "Panel", "dashboard"], ["#/projects", "Proyectos", "folder"]]],
  ["Sistema", [["#/agents", "Agentes", "bot"], ["#/reports", "Informes", "chart"], ["#/audit", "Auditoría", "log"], ["#/security", "Seguridad", "shield"]]],
];
let shell = null; // estructura persistente: la navegación no se reconstruye en cada página
let lastPath = "";
let skelTimer = 0;

const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("devpilot-theme", next); } catch { /* almacenamiento bloqueado */ }
  syncThemeButtons();
}
function themeButton(cls) {
  return h("button", { class: cls, "data-theme-btn": "", onclick: toggleTheme });
}
function syncThemeButtons() {
  for (const b of document.querySelectorAll("[data-theme-btn]")) {
    const dark = isDark();
    b.setAttribute("aria-label", dark ? "Cambiar a tema claro" : "Cambiar a tema oscuro");
    b.title = dark ? "Tema claro" : "Tema oscuro";
    b.replaceChildren(icon(dark ? "sun" : "moon"));
  }
}

function buildShell() {
  const links = [];
  const groups = NAV.flatMap(([title, items]) => [h("div", { class: "nav-group", "aria-hidden": "true" }, title),
    ...items.map(([href, label, ic]) => { const a = h("a", { href }, icon(ic), label); links.push([href, a]); return a; })]);
  const brand = () => h("div", { class: "brand" }, h("span", { class: "mark" }, icon("nav", "fill")), "DevPilot");
  const nav = h("nav", { class: "nav", "aria-label": "Principal" }, brand(), ...groups, h("div", { class: "spacer" }),
    h("div", { class: "nav-foot" },
      h("div", { class: "who" }, h("span", { class: "avatar", "aria-hidden": "true" }, (me?.username || "?").slice(0, 1)), h("span", {}, me?.username || "")),
      h("div", { class: "foot-actions" }, h("button", { class: "btn-grow ghost", onclick: logout }, icon("logout"), "Cerrar sesión"), themeButton("ghost icon-btn"))));
  const topbar = h("div", { class: "topbar" }, brand(), h("div", { class: "row" }, themeButton("ghost icon-btn"),
    h("button", { class: "ghost icon-btn", "aria-label": "Cerrar sesión", title: "Cerrar sesión", onclick: logout }, icon("logout"))));
  const main = h("main", { id: "main", tabindex: "-1" });
  const slot = h("div");
  const el = h("div", { class: "shell" }, nav, h("div", { class: "content" }, topbar, main));
  root.replaceChildren(slot, el);
  shell = { el, slot, main, links, hadContent: false };
  syncThemeButtons();
  return shell;
}

function layout(active, ...content) {
  clearTimeout(skelTimer);
  const s = shell && root.contains(shell.el) ? shell : buildShell();
  const navigated = location.hash !== lastPath;
  lastPath = location.hash;
  const swap = () => {
    s.slot.replaceChildren(...(online ? [] : [h("div", { class: "banner", role: "alert" }, icon("alert"), "Sin conexión con DevPilot: el estado mostrado puede estar desactualizado. Las ejecuciones no se asumen canceladas.")]));
    for (const [href, a] of s.links) { if (active === href) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    s.main.replaceChildren(...content.flat().filter((x) => x != null && x !== false));
    if (navigated) window.scrollTo(0, 0);
    s.main.focus({ preventScroll: true });
  };
  if (navigated && s.hadContent && document.startViewTransition && !reduced()) { try { document.startViewTransition(swap); } catch { swap(); } } else swap();
  s.hadContent = true;
}
function skeleton() {
  return h("div", { class: "skeleton", role: "status" }, h("span", { class: "sr" }, "Cargando…"), h("div", { class: "sk h" }), h("div", { class: "sk b" }), h("div", { class: "sk b" }));
}
function setOnline(v) {
  if (v === online) return;
  online = v;
  if (me) route();
}
async function logout() { try { await api("POST", "/auth/logout"); } catch { /* ya expirada */ } me = null; csrf = ""; shell = null; location.hash = "#/login"; }

// ---------- páginas ----------
function pageLogin() {
  closeLive();
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      const submit = form.querySelector("button");
      try {
        const fd = new FormData(form);
        const r = await busy(submit, () => data("POST", "/auth/login", { username: fd.get("u"), password: fd.get("p") }));
        csrf = r.csrfToken; me = { username: r.username };
        location.hash = "#/dashboard";
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "u" }, "Usuario"), h("input", { id: "u", name: "u", autocomplete: "username", required: true, autofocus: true })),
    h("div", { class: "field" }, h("label", { for: "p" }, "Contraseña"), h("input", { id: "p", name: "p", type: "password", autocomplete: "current-password", required: true })),
    err, h("button", { class: "primary", type: "submit" }, "Ingresar"));
  clearTimeout(skelTimer);
  shell = null;
  root.replaceChildren(h("div", { class: "login" }, h("div", { class: "brand" }, h("span", { class: "mark" }, icon("nav", "fill")), "DevPilot"),
    h("h1", {}, "Ingresá a tu plano de control"), h("p", { class: "lede" }, "Orquestá y revisá a tus agentes de programación, todo en tu equipo."), h("div", { class: "card" }, form)));
}

async function pageDashboard() {
  const d = await data("GET", "/dashboard");
  const sec = (title, items, render, none, { attn = false, cls = "", ic = "inbox" } = {}) => h("section", { class: "card " + cls, "aria-labelledby": "s-" + title },
    h("div", { class: "card-head" }, h("h2", { id: "s-" + title }, title), items.length ? h("span", { class: "count" + (attn ? " attn" : "") }, items.length) : null),
    items.length ? h("ul", { class: "list" }, items.map(render)) : empty(none, ic));
  const row = (r, sub, state) => h("li", { class: "item" }, h("a", { href: "#/runs/" + r.id }, r.title), badge(state), sub ? h("span", { class: "sub" }, sub) : null);
  layout("#/dashboard",
    head("Panel"),
    h("ul", { class: "stats", "aria-label": "Resumen" },
      [["proyecto(s) activo(s)", d.stats.projects], ["tarea(s)", d.stats.tasks], ["ejecución(es)", d.stats.runs], ["completada(s)", d.stats.succeeded]].map(([label, n]) => h("li", {}, h("b", {}, n), label))),
    h("div", { class: "dash" },
      sec("Necesita tu aprobación", d.needsApproval, (r) => row(r, r.kind === "start" ? "Autorizar inicio" : "Revisar el diff", r.kind === "start" ? "PENDING_APPROVAL" : "REVIEW_PENDING"), "Nada pendiente de aprobación.", { attn: true, ic: "circleCheck" }),
      sec("Ejecutándose", d.running, (r) => row(r, null, r.state), "Nada en ejecución.", { ic: "play" }),
      sec("Fallos recientes", d.failed, (r) => row(r, r.error, r.state), "Sin fallos recientes.", { cls: "wide", ic: "circleCheck" })));
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
      ["lint", "test", "typecheck", "build"].map((c) => h("label", { class: "chk" }, h("input", { type: "checkbox", name: "checks", value: c }), c))),
    err, h("button", { class: "primary", type: "submit" }, "Registrar repositorio"));
  layout("#/projects", head("Proyectos", "Repositorios autorizados donde los agentes pueden trabajar."),
    h("div", { class: "card" }, projects.length ? h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Proyecto", "Estado", "Tareas abiertas", "Ruta"].map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, projects.map((p) => h("tr", {}, h("td", {}, h("a", { href: "#/projects/" + p.id }, p.name)), h("td", {}, badge(p.status)), h("td", {}, p.openTasks), h("td", { class: "mono" }, p.logicalPath)))))) : empty("Todavía no registraste repositorios.")),
    h("div", { class: "card" }, h("h2", {}, "Registrar repositorio"), form));
}

const TYPES = ["bug", "feature", "refactor", "docs", "test", "chore"];
const PRIOS = ["low", "medium", "high", "critical"];
const opt = (v, sel) => h("option", { value: v, selected: v === sel }, v);
const labelsFrom = (value) => String(value || "").split(",").map((label) => label.trim()).filter(Boolean);
const summaryText = (result) => [result.proposal ? "Propuesta de Ollama" : "Resumen de evidencia",
  "Decisiones", ...result.decisions.map((line) => "• " + line),
  "Pendientes", ...(result.pending.length ? result.pending.map((line) => "• " + line) : ["—"])].join("\n");

async function pageProject(id) {
  const [p, git] = await Promise.all([data("GET", "/projects/" + id), data("GET", `/projects/${id}/git`).catch(() => null)]);
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      const fd = new FormData(form);
      const ac = String(fd.get("ac") || "").split("\n").map((s) => s.trim()).filter(Boolean);
      try {
        const t = await data("POST", "/tasks", { projectId: id, title: fd.get("title"), description: fd.get("desc") || undefined, type: fd.get("type"), priority: fd.get("priority"), acceptanceCriteria: ac, labels: labelsFrom(fd.get("labels")) });
        toast(t.state === "READY" ? "Tarea creada y lista" : "Tarea creada como borrador: faltan criterios", "ok"); location.hash = "#/tasks/" + t.id;
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "tt" }, "Título"), h("input", { id: "tt", name: "title", required: true, minlength: 3, maxlength: 200 })),
    h("div", { class: "field" }, h("label", { for: "td" }, "Descripción (opcional)"), h("textarea", { id: "td", name: "desc", maxlength: 10000 })),
    h("div", { class: "field" }, h("label", { for: "tl" }, "Etiquetas (separadas por comas)"), h("input", { id: "tl", name: "labels", maxlength: 320 })),
    h("div", { class: "grid" },
      h("div", { class: "field" }, h("label", { for: "ty" }, "Tipo"), h("select", { id: "ty", name: "type" }, TYPES.map((t) => opt(t, "feature")))),
      h("div", { class: "field" }, h("label", { for: "pr" }, "Prioridad"), h("select", { id: "pr", name: "priority" }, PRIOS.map((t) => opt(t, "medium"))))),
    h("div", { class: "field" }, h("label", { for: "ta" }, "Criterios de aceptación (uno por línea)"), h("textarea", { id: "ta", name: "ac", "aria-describedby": "tah" }), h("div", { id: "tah", class: "hint" }, "Sin criterios la tarea queda en borrador y no se puede ejecutar.")),
    err, h("button", { class: "primary", type: "submit" }, "Crear tarea"));
  const listBox = h("div", { "aria-live": "polite" });
  const fq = h("input", { type: "search", placeholder: "Buscar por título", "aria-label": "Buscar tareas", maxlength: 100 });
  const fl = h("input", { type: "search", placeholder: "Etiqueta", "aria-label": "Filtrar por etiqueta", maxlength: 30 });
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
      if (fl.value.trim()) qs.set("label", fl.value.trim());
      const tasks = await data("GET", `/projects/${id}/tasks?${qs}`);
      listBox.replaceChildren(tasks.length ? h("ul", { class: "list" }, tasks.map((t) => h("li", { class: "item" }, h("a", { href: "#/tasks/" + t.id }, t.title), badge(t.state), h("span", { class: "sub" }, [t.type, t.priority, ...t.labels].join(" · ")))))
        : empty(fq.value || fs.value || ar.checked ? "Ninguna tarea coincide con los filtros." : "Sin tareas. Creá la primera abajo."));
    } catch (e) { fail(e); }
  };
  for (const input of [fq, fl]) input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadTasks, 250); });
  for (const el of [fs, so, ar]) el.addEventListener("change", loadTasks);
  const toggle = async (status) => { try { await data("PATCH", "/projects/" + id, { version: p.version, status }); route(); } catch (e) { fail(e); } };
  const checks = h("form", { onsubmit: async (event) => {
    event.preventDefault();
    try {
      await data("PATCH", "/projects/" + id, { version: p.version, enabledChecks: new FormData(event.currentTarget).getAll("checks") });
      toast("Checks guardados", "ok");
      route();
    } catch (error) { fail(error); }
  } },
  h("fieldset", { class: "field plain" }, h("legend", { class: "lg" }, "Checks de QA permitidos"),
    ["lint", "test", "typecheck", "build"].map((check) => h("label", { class: "chk" },
      h("input", { type: "checkbox", name: "checks", value: check, checked: p.enabledChecks.includes(check) }), check))),
  h("button", { type: "submit" }, "Guardar checks"));
  layout("#/projects",
    back("#/projects", "Proyectos"),
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, p.name), h("div", { class: "muted mono small" }, p.logicalPath)), h("div", { class: "row" }, badge(p.status),
      p.status === "ACTIVE" ? h("button", { onclick: () => toggle("INACTIVE") }, "Desactivar") : h("button", { onclick: () => toggle("ACTIVE") }, "Reactivar"),
      p.status !== "ARCHIVED" ? h("button", { onclick: () => toggle("ARCHIVED") }, "Archivar") : null)),
    h("div", { class: "card" }, git ? h("div", { class: "row" }, "Rama ", h("code", {}, git.branch), git.dirty ? badge("UNKNOWN") && h("span", { class: "badge warn" }, `${git.changedFiles} cambio(s) sin commitear`) : h("span", { class: "badge ok" }, "limpio"), git.lastCommit ? h("span", { class: "muted small" }, `${short(git.lastCommit.sha, 7)} ${git.lastCommit.subject}`) : null) : h("span", { class: "muted" }, "No se pudo leer el estado Git."),
      h("div", { class: "muted small" }, "Checks habilitados: " + (p.enabledChecks.join(", ") || "ninguno")),
      p.status !== "ARCHIVED" ? h("details", {}, h("summary", {}, "Configurar checks"), checks) : null),
    p.status === "ACTIVE" ? h("div", { class: "row" }, h("a", { class: "btn", href: "#/context/" + id }, icon("file"), "Contexto Markdown"),
      p.githubReadEnabled ? h("a", { class: "btn", href: "#/github/" + id }, icon("branch"), "Issues y PR de GitHub") : null) : null,
    h("div", { class: "card" }, h("h2", {}, "Tareas"), h("div", { class: "row filters" }, fq, fl, fs, so, h("label", { class: "chk" }, ar, "Archivadas")), listBox),
    h("div", { class: "card" }, h("h2", {}, "Nueva tarea"), form));
  loadTasks();
}

async function pageContext(projectId, selectedId) {
  const base = `/projects/${projectId}/context`;
  const [files, selected] = await Promise.all([data("GET", base), selectedId ? data("GET", base + "/" + selectedId) : null]);
  const field = h("input", { id: "ctx-path", required: true, maxlength: 400, placeholder: "docs/decisiones.md" });
  const action = async (button, fn) => {
    button.disabled = true;
    try { await fn(); } catch (error) { fail(error); } finally { button.disabled = false; }
  };
  const pathForm = h("form", { onsubmit: (event) => {
    event.preventDefault();
    action(pathForm.querySelector("button"), async () => {
      const registered = await data("POST", base, { path: field.value.trim() });
      location.hash = `#/context/${projectId}/${registered.id}`;
    });
  } }, h("div", { class: "field" }, h("label", { for: "ctx-path" }, "Ruta relativa del Markdown"), field),
  h("button", { type: "submit" }, "Registrar archivo"));
  let editor = null;
  if (selected) {
    const endpoint = base + "/" + selected.id;
    const content = h("textarea", { id: "ctx-content", rows: 16, maxlength: 65536 }, selected.content);
    const summary = h("pre", { class: "log muted", role: "status" });
    editor = h("div", { class: "card" }, h("h2", {}, selected.path),
      selected.changed ? h("p", { class: "warnbox" }, "El archivo cambió desde que lo registraste.") : null,
      h("div", { class: "row" },
        selected.changed ? h("button", { onclick: (event) => action(event.currentTarget, async () => {
          await data("POST", base, { path: selected.path, version: selected.version });
          route();
        }) }, "Registrar la versión actual") : null,
        h("button", { onclick: (event) => action(event.currentTarget, async () => {
          summary.textContent = "Generando resumen local…";
          try { summary.textContent = summaryText(await data("POST", endpoint + "/summary")); }
          finally { if (summary.textContent === "Generando resumen local…") summary.textContent = ""; }
        }) }, "Resumir decisiones y pendientes")),
      summary, h("div", { class: "field" }, h("label", { for: "ctx-content" }, "Markdown propuesto"), content),
      h("button", { class: "primary", disabled: selected.changed, onclick: (event) => action(event.currentTarget, async () => {
        const result = await data("POST", endpoint + "/proposals", { version: selected.version, content: content.value });
        location.hash = "#/tasks/" + result.taskId;
      }) }, "Preparar propuesta"));
  }
  layout("#/projects", back("#/projects/" + projectId, "Proyecto"), head("Contexto Markdown", "Archivos .md versionados que dan contexto a los agentes."),
    h("div", { class: "card" }, pathForm),
    h("div", { class: "card" }, h("h2", {}, "Archivos registrados"), files.length ? h("ul", { class: "list" },
      files.map((file) => h("li", {}, h("a", { href: `#/context/${projectId}/${file.id}`, "aria-current": file.id === selectedId ? "page" : false }, file.path)))) : empty("Todavía no hay archivos registrados.")),
    editor);
}

async function pageTask(id) {
  const t = await data("GET", "/tasks/" + id);
  const editable = !t.archived && ["DRAFT", "READY", "NEEDS_CHANGES", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"].includes(t.state);
  const [prov, projectTasks] = await Promise.all([data("GET", "/providers"),
    editable ? data("GET", `/projects/${t.projectId}/tasks`) : []]);
  const selected = new Set(t.prerequisites.map((task) => task.id));
  const candidates = new Map([...t.prerequisites, ...projectTasks.filter((task) => task.id !== id)].map((task) => [task.id, task]));
  const pendingDependencies = t.prerequisites.some((task) => task.state !== "APPROVED");
  const sel = h("select", { id: "prov" }, prov.providers.filter((p) => t.contextProposal ? p.id === "context-markdown" : p.id !== "ollama" && p.id !== "context-markdown")
    .map((p) => h("option", { value: p.id, disabled: !p.available }, `${p.id}${p.available ? "" : " (no disponible)"} · ${p.costOrigin}`)));
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, "ok"); route(); } catch (e) { fail(e); } };
  const eErr = h("p", { class: "hint err", role: "alert" });
  const eForm = h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); eErr.textContent = "";
      const fd = new FormData(eForm);
      try {
        await data("PATCH", "/tasks/" + id, { version: t.version, title: fd.get("title"), description: fd.get("desc") || null, type: fd.get("type"), priority: fd.get("priority"),
          acceptanceCriteria: String(fd.get("ac") || "").split("\n").map((x) => x.trim()).filter(Boolean),
          labels: labelsFrom(fd.get("labels")), prerequisiteIds: fd.getAll("prerequisites") });
        toast("Tarea actualizada", "ok"); route();
      } catch (ex) { eErr.textContent = ex.message; }
    },
  },
    h("div", { class: "field" }, h("label", { for: "et" }, "Título"), h("input", { id: "et", name: "title", value: t.title, required: true, minlength: 3, maxlength: 200 })),
    h("div", { class: "field" }, h("label", { for: "ed" }, "Descripción"), h("textarea", { id: "ed", name: "desc" }, t.description || "")),
    h("div", { class: "field" }, h("label", { for: "el" }, "Etiquetas (separadas por comas)"), h("input", { id: "el", name: "labels", value: t.labels.join(", "), maxlength: 320 })),
    h("div", { class: "field" }, h("label", { for: "deps" }, "Tareas requeridas"), h("select", { id: "deps", name: "prerequisites", multiple: true, size: 4 },
      [...candidates.values()].map((task) => h("option", { value: task.id, selected: selected.has(task.id) }, task.title)))),
    h("div", { class: "grid" },
      h("div", { class: "field" }, h("label", { for: "ety" }, "Tipo"), h("select", { id: "ety", name: "type" }, TYPES.map((x) => opt(x, t.type)))),
      h("div", { class: "field" }, h("label", { for: "epr" }, "Prioridad"), h("select", { id: "epr", name: "priority" }, PRIOS.map((x) => opt(x, t.priority))))),
    h("div", { class: "field" }, h("label", { for: "eac" }, "Criterios de aceptación (uno por línea)"), h("textarea", { id: "eac", name: "ac" }, t.acceptanceCriteria.join("\n"))),
    eErr, h("button", { class: "primary", type: "submit" }, "Guardar cambios"));
  const editCard = h("div", { class: "card" },
    editable ? h("details", {}, h("summary", {}, "Editar tarea"), h("div", { class: "stack" }, eForm)) : h("p", { class: "muted small" }, "La tarea no se puede editar en el estado actual."),
    !["QUEUED", "RUNNING"].includes(t.state) && !t.archived ? h("p", {}, h("button", { class: "danger", onclick: async () => { if (await confirmDialog("Archivar tarea", "La tarea y su historial se conservan; deja de aparecer en la lista.", "Archivar", true)) { try { await data("POST", `/tasks/${id}/archive`); toast("Tarea archivada", "ok"); location.hash = "#/projects/" + t.projectId; } catch (ex) { fail(ex); } } } }, "Archivar tarea")) : null,
    t.archived ? h("p", { class: "muted small" }, "Esta tarea está archivada.") : null);
  const c = t.classification;
  layout("#/projects",
    back("#/projects/" + t.projectId, t.project.name),
    h("div", { class: "page-head" }, h("h1", {}, t.title), badge(t.state)),
    h("p", { class: "muted" }, [t.type, `prioridad ${t.priority}`, ...t.labels].join(" · ")), t.description ? h("p", {}, t.description) : null,
    h("div", { class: "card" }, h("h2", {}, "Criterios de aceptación"), t.acceptanceCriteria.length ? h("ul", {}, t.acceptanceCriteria.map((a) => h("li", {}, a))) : empty("Sin criterios: la tarea no puede ejecutarse.")),
    editCard,
    t.prerequisites.length ? h("div", { class: "card" }, h("h2", {}, "Tareas requeridas"), h("ul", { class: "list" },
      t.prerequisites.map((task) => h("li", {}, h("a", { href: "#/tasks/" + task.id }, task.title), " ", badge(task.state))))) : null,
    h("div", { class: "card" }, h("h2", {}, "Clasificación con IA local"),
      c ? h("div", {}, h("p", {}, h("strong", {}, c.category), ` · prioridad sugerida ${c.suggestedPriority} · confianza ${Math.round(c.confidence * 100)}%`), h("p", { class: "muted" }, c.summary),
        h("p", { class: "hint" }, `Propuesta no vinculante (${c.source}${c.model ? " " + c.model : ""}). ${c.note || ""}`)) : h("p", { class: "muted" }, "Sin clasificar."),
      h("button", { onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Clasificando… (puede tardar si el modelo se está cargando)"; act(() => data("POST", `/tasks/${id}/classify`), "Clasificada"); } }, "Clasificar")),
    h("div", { class: "card" }, h("h2", {}, "Ejecutar"),
      t.state === "DRAFT" ? h("div", {}, h("p", { class: "muted" }, "Borrador. Agregá criterios y marcala como lista."), h("button", { disabled: !t.acceptanceCriteria.length, onclick: () => act(() => data("POST", `/tasks/${id}/transition`, { to: "READY", version: t.version }), "Tarea lista") }, "Marcar como lista"))
      : t.state === "READY" ? h("div", {},
        pendingDependencies ? h("p", { class: "warnbox" }, "Aprobá primero las tareas requeridas.") : null,
        h("div", { class: "row" }, h("label", { for: "prov", class: "small" }, "Proveedor"), sel,
        h("button", { class: "primary", disabled: pendingDependencies || t.archived, onclick: () => act(async () => {
          const provider = prov.providers.find((p) => p.id === sel.value);
          if (!provider?.available) return;
          const acknowledgeExternal = provider.costOrigin !== "LOCAL";
          if (acknowledgeExternal && !(await confirmDialog("Compartir contexto", "El contexto de la tarea y del repositorio puede salir de tu equipo y enviarse al proveedor.", "Entendido"))) return;
          const r = await data("POST", `/tasks/${id}/runs`, { providerId: sel.value, acknowledgeExternal });
          location.hash = "#/runs/" + r.id;
        }) }, "Solicitar ejecución")))
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

// Fase actual de una ejecución, derivada del estado que decide el backend (no se calcula nada propio).
function phases(r) {
  const labels = ["Autorización", "Ejecución", "QA", "Revisión", "Entrega"];
  const at = r.deliveredCommit ? 5 : r.state === "PENDING_APPROVAL" ? 0 : ["QUEUED", "RUNNING"].includes(r.state) ? 1 : r.state === "SUCCEEDED" ? 3 : 1;
  const stop = ["FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN", "PARTIAL"].includes(r.state) ? Math.min(Math.max(at, 1), 2) : -1;
  return h("ol", { class: "phases", "aria-label": "Fases de la ejecución" }, labels.map((label, i) => h("li", {
    class: i === stop ? "stop" : i < at ? "done" : "", "aria-current": i === at && stop < 0 ? "step" : false }, label)));
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
  const summary = h("pre", { class: "log", role: "status", hidden: true });
  const manual = r.state === "SUCCEEDED" && diff.files.length ? await manualReview(id, diff.diffHash) : null;
  const review = async (decision) => {
    const approve = decision === "approve";
    if (approve && !(await confirmDialog("Aprobar cambios", "Se creará un commit en la rama de la tarea. No se hará merge, push ni deploy.", "Aprobar"))) return;
    if (!approve && !(await confirmDialog(decision === "reject" ? "Rechazar" : "Pedir cambios", "La evidencia de esta ejecución se conserva.", "Confirmar", true))) return;
    act(() => data("POST", `/runs/${id}/review`, { decision, diffHash: diff.diffHash, reason: reason.value || undefined, overrideQa: override.checked }), approve ? "Cambios aprobados" : "Decisión registrada");
  };
  const publish = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const target = await data("GET", `/runs/${id}/pr-target`);
      if (!(await confirmDialog("Autorizar PR en GitHub", `Se publicará la rama ${r.branch} con el commit ${short(target.commit, 10)} en ${target.repository} y se abrirá un PR en borrador.`, "Publicar y abrir PR"))) return;
      const approval = await data("POST", `/runs/${id}/pr-approval`, target);
      await data("POST", `/runs/${id}/pr`, { approvalId: approval.approvalId });
      toast("PR creado", "ok");
      route();
    } catch (error) { fail(error); } finally { button.disabled = false; }
  };
  layout("#/projects",
    back("#/tasks/" + r.task.id, r.task.title),
    h("div", { class: "page-head" }, h("h1", {}, `Ejecución · intento ${r.attempt}`), status),
    phases(r),
    h("p", { class: "muted small mono" }, `${r.providerId} · ${r.branch || "sin rama"} · inicio ${fmt(r.startedAt)} · fin ${fmt(r.finishedAt)}`),
    r.error ? h("div", { class: "warnbox bad", role: "alert" }, icon("alert"), r.error) : null,
    r.state === "PENDING_APPROVAL" ? h("div", { class: "card" }, h("h2", {}, "Autorizar inicio"), h("p", {}, r.canWriteCode === false
      ? "Se creará un worktree para esta ejecución de sólo lectura." : "Se creará un worktree para los cambios. La entrega requiere revisar y aprobar el diff."),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => act(() => data("POST", `/runs/${id}/approve-start`), "Ejecución en cola") }, "Aprobar e iniciar"), h("button", { class: "danger", onclick: () => act(() => data("POST", `/runs/${id}/cancel`), "Cancelada") }, "Cancelar"))) : null,
    ["QUEUED", "RUNNING"].includes(r.state) ? h("div", { class: "row" }, h("button", { class: "danger", onclick: async () => { if (await confirmDialog("Cancelar ejecución", "Se terminará el proceso del agente.", "Cancelar ejecución", true)) act(() => data("POST", `/runs/${id}/cancel`), "Cancelación solicitada"); } }, "Cancelar ejecución"), conn) : null,
    h("div", { class: "card" }, h("h2", {}, "Línea de tiempo"), timeline),
    h("div", { class: "card" }, h("h2", {}, "Checks de QA"),
      r.checks.length ? h("ul", { class: "list" }, r.checks.map((c) => h("li", { class: "check" }, h("div", { class: "row between" }, h("strong", { class: "name" }, c.commandId), h("span", { class: "row" }, badge(c.state), h("span", { class: "mono muted" }, `exit ${c.exitCode ?? "—"} · ${c.durationMs} ms`))),
        h("p", { class: "muted small" }, c.environment || "Entorno sin registrar"),
        h("button", { class: "small", onclick: async (e) => { const o = await data("GET", `/runs/${id}/checks`); const x = o.find((y) => y.id === c.id); const li = e.target.closest("li"); li.querySelector("pre")?.remove(); li.append(h("pre", { class: "log" }, (x.stdout + (x.stderr ? "\n[stderr]\n" + x.stderr : "")).trim() || "(sin salida)")); } }, "Ver salida")))) : empty("Sin checks ejecutados: no hay evidencia de QA.")),
    h("div", { class: "card" }, h("h2", {}, "Cambios"),
      diff.warnings.map((w) => h("div", { class: "warnbox", role: "alert" }, icon("alert"), w.message)),
      diff.files.length ? h("div", {}, h("ul", { class: "list small" }, diff.files.map((f) => h("li", {}, h("span", { class: "badge" }, f.status), " ", h("code", {}, f.path)))), renderDiff(diff.patch)) : empty("Sin archivos modificados."),
      diff.diffHash ? h("p", { class: "hint mono" }, "diffHash " + short(diff.diffHash, 16) + "…") : null,
      diff.diffHash ? h("button", { onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        summary.hidden = false;
        summary.textContent = "Generando resumen…";
        try { summary.textContent = summaryText(await data("POST", `/runs/${id}/summary`)); }
        catch (error) { summary.textContent = error.message; } finally { button.disabled = false; }
      } }, "Resumir resultado") : null, summary),
    manual,
    r.task.state === "REVIEW_PENDING" && r.state === "SUCCEEDED" ? h("div", { class: "card decision" }, h("h2", {}, "Tu decisión"),
      allPassed ? h("p", { class: "muted" }, "Todos los checks pasaron con evidencia.") : h("div", { class: "warnbox" }, "Hay checks sin aprobar o sin evidencia. Para aprobar igual necesitás una excepción con motivo."),
      h("div", { class: "field" }, h("label", { for: "rsn" }, "Motivo (obligatorio si aprobás con excepción)"), reason, h("div", { id: "rsnh", class: "hint" }, "Queda en la auditoría.")),
      allPassed ? null : h("div", { class: "field" }, h("label", { for: "ovr", class: "chk" }, override, "Aprobar con excepción de QA")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => review("approve") }, icon("check"), "Aprobar"), h("button", { onclick: () => review("needs_changes") }, icon("retry"), "Pedir cambios"), h("button", { class: "danger", onclick: () => review("reject") }, icon("x"), "Rechazar"))) : null,
    r.deliveredCommit ? h("div", { class: "card" }, h("h2", {}, "Entregado"), h("p", {}, "Rama ", h("code", {}, r.branch), " · commit ", h("code", {}, short(r.deliveredCommit, 10)), "."),
      r.pullRequest ? h("a", { href: r.pullRequest.url, target: "_blank", rel: "noopener noreferrer" }, "Abrir PR #" + r.pullRequest.number) :
        r.githubPrEnabled ? h("button", { onclick: publish }, "Crear PR en GitHub") : null) : null,
    h("div", { class: "card" }, h("h2", {}, "Aprobaciones"), r.approvals.length ? h("ul", { class: "list small" }, r.approvals.map((a) => h("li", {}, `${fmt(a.createdAt)} · ${a.action} · ${a.decision}${a.reason ? " · " + a.reason : ""}`))) : empty("Sin aprobaciones registradas.")));

  // SSE con reanudación automática por Last-Event-ID; reconectar no implica cancelada (RN-013).
  closeLive();
  const addEv = (type, p) => {
    if (p.state && (type === "run.state" || type === "run.completed")) { status.replaceChildren(badge(p.state)); pulse(status); } // la insignia sigue al estado real
    const msg = p.message || p.text || (p.state ? "Estado: " + p.state : "") || p.path || (p.commandId ? `check ${p.commandId}: ${p.state}` : "");
    const item = h("li", {}, h("time", {}, new Date(p.at || Date.now()).toLocaleTimeString("es-AR")), type.replace("run.", "") + (msg ? " · " + msg : ""));
    timeline.append(item);
    enter(item, { y: 4, duration: 0.18 });
    timeline.scrollTop = timeline.scrollHeight;
  };
  const types = ["run.progress", "run.log", "run.file_changed", "run.check.finished", "run.state", "run.completed", "run.error"];
  const es = new EventSource(`/api/v1/runs/${id}/events`);
  live = es;
  for (const t of types) es.addEventListener(t, (e) => { conn.textContent = ""; try { addEv(t, JSON.parse(e.data)); } catch { /* evento ilegible */ } });
  es.addEventListener("run.end", () => { es.close(); live = null; if (["QUEUED", "RUNNING"].includes(r.state) || r.state === "PENDING_APPROVAL") route(); });
  es.onerror = () => { conn.textContent = "Reconectando… la ejecución no se considera cancelada."; };
}

async function manualReview(id, diffHash) {
  const endpoint = `/runs/${id}/manual-review`;
  const reviews = await data("GET", endpoint);
  const brief = h("textarea", { id: "claude-brief", readonly: true, rows: 8 });
  const findings = h("textarea", { id: "claude-findings", required: true, maxlength: 12000, rows: 5 });
  return h("div", { class: "card" }, h("details", {}, h("summary", {}, "Revisión manual con Claude Code"),
    h("p", {}, "Verificá que tu cuenta admite el uso en la aplicación oficial. Revisá el material antes de copiarlo. El proveedor puede recibir el contexto que compartas."),
    h("p", {}, h("a", { href: "https://code.claude.com/docs/en/legal-and-compliance", target: "_blank", rel: "noopener noreferrer" }, "Condiciones oficiales de Claude Code")),
    h("button", { onclick: async (event) => {
      const button = event.currentTarget;
      if (!(await confirmDialog("Preparar revisión manual", "El material contiene el diff. Revisalo antes de compartirlo con Claude Code.", "Preparar material"))) return;
      button.disabled = true;
      try { brief.value = (await data("POST", endpoint + "/brief", { acknowledgeExternal: true })).text; brief.focus(); }
      catch (error) { fail(error); } finally { button.disabled = false; }
    } }, "Preparar material de revisión"),
    h("div", { class: "field" }, h("label", { for: "claude-brief" }, "Material para revisar"), brief),
    h("form", { onsubmit: async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button");
      button.disabled = true;
      try { await data("POST", endpoint, { diffHash, findings: findings.value }); toast("Hallazgos registrados", "ok"); route(); }
      catch (error) { fail(error); } finally { button.disabled = false; }
    } },
    h("div", { class: "field" }, h("label", { for: "claude-findings" }, "Hallazgos para guardar"), findings),
    h("button", { type: "submit" }, "Guardar hallazgos")),
    reviews.length ? h("ul", { class: "list" }, reviews.map((note) => h("li", {}, h("span", { class: "muted" }, fmt(note.createdAt)), h("pre", { class: "log" }, note.findings)))) : null));
}

async function pageGithub(id, section, pageValue) {
  const kind = section === "pulls" ? "pulls" : "issues";
  const page = /^[1-9][0-9]?$|^100$/.test(pageValue || "") ? Number(pageValue) : 1;
  const r = await data("GET", `/projects/${id}/github?kind=${kind}&page=${page}&state=all`);
  const base = `#/github/${id}/`;
  layout("#/projects", back("#/projects/" + id, "Proyecto"),
    head("GitHub", r.repo),
    h("div", { class: "row" }, h("a", { href: base + "issues", "aria-current": kind === "issues" ? "page" : false }, "Issues"),
      h("a", { href: base + "pulls", "aria-current": kind === "pulls" ? "page" : false }, "Pull requests")),
    h("div", { class: "card" }, r.items.length ? h("ul", { class: "list" }, r.items.map((item) => h("li", {},
      h("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, `#${item.number} ${item.title}`),
      h("p", { class: "muted small" }, [item.draft ? "Borrador" : item.state === "open" ? "Abierto" : "Cerrado", fmt(item.updatedAt)].join(" · "))))) : empty("Sin resultados en esta página.")),
    h("div", { class: "row" }, page > 1 ? h("a", { href: base + `${kind}/${page - 1}` }, "Anterior") : null,
      h("span", {}, `Página ${page}`), r.hasMore && page < 100 ? h("a", { href: base + `${kind}/${page + 1}` }, "Siguiente") : null));
}

async function pageReports() {
  const r = await data("GET", "/reports");
  // Barras proporcionales al mayor valor del grupo; el ancho viaja como propiedad CSS (la CSP no admite style inline).
  const list = (heading, rows, label, value, meta) => {
    const max = Math.max(1, ...rows.map(value));
    return h("section", { class: "card", "aria-label": heading }, h("h2", {}, heading),
      rows.length ? h("ul", { class: "bars" }, rows.map((row) => {
        const bar = h("span", { class: "bar", "aria-hidden": "true" });
        bar.style.setProperty("--v", String(Math.round((value(row) / max) * 100)));
        return h("li", {}, h("span", {}, label(row)), h("b", {}, value(row)), bar, meta?.(row) ? h("span", { class: "meta muted" }, meta(row)) : null);
      })) : empty("Sin datos.", "chart"));
  };
  const duration = (ms) => ms === null ? "" : ` · media ${ms} ms`;
  const download = async () => {
    try {
      const { markdown } = await data("POST", "/reports/portfolio");
      const url = URL.createObjectURL(new window.Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      h("a", { href: url, download: "devpilot-portfolio.md" }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { fail(error); }
  };
  layout("#/reports", head("Informes", "Resultados, tiempos y origen de consumo de las ejecuciones registradas."),
    h("p", {}, h("button", { onclick: download }, icon("file"), "Descargar informe técnico anonimizado")),
    h("div", { class: "grid" },
      list("Tareas", r.tasks, (row) => STATE[row.state]?.[0] || row.state, (row) => row.count),
      list("Ejecuciones", r.runs, (row) => STATE[row.state]?.[0] || row.state, (row) => row.count, (row) => duration(row.averageMs).replace(" · ", "")),
      list("Proveedores", r.providers, (row) => row.id, (row) => row.succeeded, (row) => `${row.succeeded}/${row.finished} ejecuciones exitosas${duration(row.averageMs)}`),
      list("Consumo declarado", r.costs, (row) => row.origin, (row) => row.count, () => "ejecuciones registradas"),
      list("Checks", r.checks, (row) => STATE[row.state]?.[0] || row.state, (row) => row.count, (row) => duration(row.averageMs).replace(" · ", ""))));
}

async function pageAgents() {
  const r = await data("GET", "/providers");
  layout("#/agents", head("Agentes y proveedores"),
    h("p", { class: r.sandbox.available ? "muted" : "warnbox" }, r.sandbox.mode === "none" ? "Checks en el host · sandbox deshabilitado" :
      r.sandbox.available ? "Sandbox Docker disponible · checks sin red" : "Sandbox Docker no disponible · se bloquearán los checks"),
    r.paidApisEnabled ? h("div", { class: "warnbox" }, icon("alert"), "Las APIs de pago están habilitadas.") : h("p", { class: "muted" }, "APIs de pago deshabilitadas (costo adicional: USD 0)."),
    h("div", { class: "grid" }, r.providers.map((p) => h("div", { class: "card" }, h("h3", {}, p.id), h("div", { class: "row" }, h("span", { class: "badge " + (p.available ? "ok" : "bad") }, icon(p.available ? "check" : "x"), p.available ? "Disponible" : "No disponible"), h("span", { class: "badge" }, p.costOrigin)), h("p", { class: "muted small" }, p.detail || (p.canWriteCode ? "Puede escribir código" : "Sólo análisis"))))));
}

async function pageAudit() {
  const rows = await data("GET", "/audit?limit=100");
  layout("#/audit", head("Auditoría", "Registro append-only de acciones críticas."),
    h("div", { class: "card tablewrap" }, rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Fecha", "Acción", "Entidad", "Resultado", "Detalle"].map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, rows.map((a) => h("tr", {}, h("td", { class: "small" }, fmt(a.createdAt)), h("td", {}, a.action), h("td", { class: "mono small" }, `${a.entityType}${a.entityId ? " " + short(a.entityId, 14) : ""}`), h("td", {}, h("span", { class: "badge " + (a.outcome === "OK" ? "ok" : "bad") }, icon(a.outcome === "OK" ? "check" : "x"), a.outcome)), h("td", { class: "mono small" }, a.detail || ""))))) : empty("Sin eventos.")));
}

async function pageSecurity() {
  const [roots, sessions] = await Promise.all([data("GET", "/roots"), data("GET", "/auth/sessions")]);
  const err = h("p", { class: "hint err", role: "alert" });
  const form = h("form", { onsubmit: async (e) => { e.preventDefault(); err.textContent = ""; try { await data("POST", "/roots", { path: new FormData(form).get("path") }); toast("Raíz autorizada", "ok"); route(); } catch (ex) { err.textContent = ex.message; } } },
    h("div", { class: "field" }, h("label", { for: "rp" }, "Carpeta a autorizar"), h("input", { id: "rp", name: "path", class: "mono", required: true })), err, h("button", { class: "primary", type: "submit" }, "Autorizar raíz"));
  layout("#/security", head("Seguridad"),
    h("div", { class: "card" }, h("h2", {}, "Raíces autorizadas"), roots.length ? h("ul", { class: "list" }, roots.map((x) => h("li", { class: "row between" }, h("code", {}, x.path),
      h("button", { onclick: async () => { try { await data("PATCH", "/roots/" + x.id, { enabled: !x.enabled }); route(); } catch (e) { fail(e); } } }, x.enabled ? "Deshabilitar" : "Habilitar")))) : empty("No hay raíces. Los repositorios sólo pueden registrarse dentro de una raíz autorizada."), form),
    h("div", { class: "card" }, h("h2", {}, "Sesiones"), h("ul", { class: "list small" }, sessions.map((s) => h("li", {}, `${fmt(s.created_at)} · ${s.ip || "?"}`, s.current ? " · (actual)" : "", s.revoked_at ? " · revocada" : ""))),
      h("button", { onclick: async () => { try { const r = await data("POST", "/auth/revoke-others"); toast(`${r.revoked} sesión(es) revocada(s)`, "ok"); route(); } catch (e) { fail(e); } } }, "Revocar otras sesiones")));
}

// ---------- router ----------
async function route() {
  clearTimeout(skelTimer);
  const hash = location.hash || "#/dashboard";
  const [, a, b, c, d] = hash.split("/");
  if (!me) {
    try { const m = await data("GET", "/auth/me"); csrf = m.csrfToken; me = { username: m.username }; }
    catch (error) {
      if (error.status === 0) {
        layout("", h("h1", {}, "Sin conexión"), h("p", {}, "Conectate a DevPilot para ver los datos actuales."), h("button", { onclick: route }, icon("retry"), "Reintentar"));
        return;
      }
      if (a !== "login") { location.hash = "#/login"; return; }
    }
  }
  if (a === "login") { if (me) { location.hash = "#/dashboard"; return; } return pageLogin(); }
  closeLive();
  // Esqueleto sólo si la carga se demora y cambió la ruta: una recarga tras una acción no parpadea.
  if (shell && root.contains(shell.el) && hash !== lastPath) skelTimer = setTimeout(() => shell.main.replaceChildren(skeleton()), 150);
  try {
    if (a === "dashboard") await pageDashboard();
    else if (a === "projects") await (b ? pageProject(b) : pageProjects());
    else if (a === "context" && b) await pageContext(b, c);
    else if (a === "github" && b) await pageGithub(b, c, d);
    else if (a === "tasks" && b) await pageTask(b);
    else if (a === "runs" && b) await pageRun(b);
    else if (a === "agents") await pageAgents();
    else if (a === "reports") await pageReports();
    else if (a === "audit") await pageAudit();
    else if (a === "security") await pageSecurity();
    else location.hash = "#/dashboard";
  } catch (e) {
    if (e.status === 401) return;
    layout("", h("h1", {}, "No se pudo cargar"), h("div", { class: "warnbox bad", role: "alert" }, icon("alert"), e.message), h("button", { onclick: route }, icon("retry"), "Reintentar"));
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("offline", () => setOnline(false));
setInterval(async () => { try { const r = await fetch("/api/v1/health", { cache: "no-store" }); setOnline(r.ok); } catch { setOnline(false); } }, 10000);
route();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* PWA opcional */ });
