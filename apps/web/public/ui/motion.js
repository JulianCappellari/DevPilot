// Movimiento de la interfaz: Motion (animate sobre WAAPI) para toasts, diálogos y feedback de estado.
// Todo respeta prefers-reduced-motion: sin preferencia explícita no se anima nada.
import { animate } from "../vendor/motion.js";

const ease = [0.22, 1, 0.36, 1];
export const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function enter(el, { y = 8, duration = 0.2 } = {}) {
  if (reduced()) return Promise.resolve();
  return animate(el, { opacity: [0, 1], transform: [`translateY(${y}px) scale(0.98)`, "translateY(0) scale(1)"] }, { duration, ease }).finished.catch(() => {});
}
export function leave(el, { y = 6, duration = 0.14 } = {}) {
  if (reduced()) return Promise.resolve();
  return animate(el, { opacity: [1, 0], transform: ["translateY(0) scale(1)", `translateY(${y}px) scale(0.98)`] }, { duration, ease: "easeIn" }).finished.then(() => { el.style.opacity = "0"; }).catch(() => {});
}
// Destaca un cambio de estado en vivo sin mover el layout.
export function pulse(el) {
  if (reduced()) return;
  animate(el, { transform: ["scale(1)", "scale(1.08)", "scale(1)"], opacity: [0.6, 1] }, { duration: 0.35, ease }).finished.catch(() => {});
}
