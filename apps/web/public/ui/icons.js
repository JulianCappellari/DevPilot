// Iconos de trazo (24x24, 1.75 px), dibujados a partir del conjunto Lucide (ISC). Sólo los que usa la interfaz.
const NS = "http://www.w3.org/2000/svg";
const c = (cx, cy, r) => ["circle", { cx, cy, r }];
const r = (x, y, width, height, rx = 1) => ["rect", { x, y, width, height, rx }];
const ICONS = {
  dashboard: [r(3, 3, 7, 9), r(14, 3, 7, 5), r(14, 12, 7, 9), r(3, 16, 7, 5)],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  bot: [r(3, 11, 18, 10, 2), c(12, 5, 2), "M12 7v4", "M8 16h.01", "M16 16h.01"],
  chart: ["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"],
  log: ["M15 12h-5", "M15 8h-5", "M19 17V5a2 2 0 0 0-2-2H4", "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
  sun: [c(12, 12, 4), "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  clock: [c(12, 12, 10), "M12 6v6l4 2"],
  play: ["M6 3l14 9-14 9z"],
  alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
  dot: [c(12, 12, 4)],
  circle: [c(12, 12, 9)],
  help: [c(12, 12, 10), "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
  ban: [c(12, 12, 10), "m4.9 4.9 14.2 14.2"],
  pencil: ["M12 20h9", "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"],
  retry: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  branch: ["M6 3v12", c(18, 6, 3), c(6, 18, 3), "M18 9a9 9 0 0 1-9 9"],
  plus: ["M5 12h14", "M12 5v14"],
  circleCheck: [c(12, 12, 10), "m9 12 2 2 4-4"],
  timer: ["M10 2h4", "M12 14l3-3", c(12, 14, 8)],
  half: [c(12, 12, 10), "M12 2a10 10 0 0 1 0 20z"],
  archive: [r(2, 3, 20, 5), "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
  spinner: ["M21 12a9 9 0 1 1-6.219-8.56"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  git: [c(12, 12, 3), "M12 3v6", "M12 15v6"],
  nav: ["M12 3 20 20l-8-4-8 4z"],
};

export function icon(name, cls = "") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
  for (const part of ICONS[name] || ICONS.dot) {
    const [tag, attrs] = typeof part === "string" ? ["path", { d: part }] : part;
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}
