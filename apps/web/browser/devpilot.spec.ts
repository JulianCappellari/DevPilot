import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { fixture } from "./server.js";

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([]);
}

async function demoShot(page: Page, step: string, mask: Locator[] = []) {
  const directory = process.env["DEVPILOT_DEMO_DIR"];
  if (directory) await page.screenshot({ path: path.join(directory, step + ".png"), animations: "disabled", mask, maskColor: "#353c49" });
}

async function login(page: Page, url: string, password: string, capture = false) {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
  await accessible(page);
  if (capture) await demoShot(page, "01");
  await page.getByLabel("Usuario").fill("owner");
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Panel" })).toBeVisible();
  await accessible(page);
  if (capture) await demoShot(page, "02");
}

test("registro, tarea, autorización y revisión desde un navegador", async ({ page }) => {
  const demo = await fixture();
  const server = await demo.start();
  try {
    await login(page, server.url, demo.password, true);
    await page.getByRole("link", { name: "Proyectos" }).click();
    await expect(page.getByRole("button", { name: "Registrar repositorio" })).toBeVisible();
    await demoShot(page, "03");
    await page.getByLabel("Nombre", { exact: true }).fill("Proyecto de prueba");
    await page.getByLabel("Ruta del repositorio").fill(demo.repo);
    await page.getByLabel("test", { exact: true }).check();
    await accessible(page);
    await page.getByRole("button", { name: "Registrar repositorio" }).click();
    await expect(page.getByRole("heading", { name: "Proyecto de prueba" })).toBeVisible();
    await accessible(page);
    if (process.env["DEVPILOT_DEMO_DIR"]) await page.getByRole("heading", { name: "Nueva tarea" }).scrollIntoViewIfNeeded();
    await demoShot(page, "04", [page.getByText(demo.repo, { exact: true })]);
    await page.getByLabel("Título", { exact: true }).fill("Documentar el acceso");
    await page.getByLabel("Criterios de aceptación", { exact: false }).fill("Se crea una nota de prueba");
    await page.getByRole("button", { name: "Crear tarea" }).click();
    await page.getByLabel("Proveedor").selectOption("mock-writer");
    await accessible(page);
    await demoShot(page, "05");
    await page.getByRole("button", { name: "Solicitar ejecución" }).click();
    await expect(page.getByRole("button", { name: "Aprobar e iniciar" })).toBeVisible();
    await demoShot(page, "06");
    await page.getByRole("button", { name: "Aprobar e iniciar" }).click();
    await expect(page.getByRole("heading", { name: "Tu decisión" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Todos los checks pasaron con evidencia.")).toBeVisible();
    await accessible(page);
    if (process.env["DEVPILOT_DEMO_DIR"]) await page.getByRole("heading", { name: "Tu decisión" }).scrollIntoViewIfNeeded();
    await demoShot(page, "07");
    await page.getByRole("button", { name: "Aprobar", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Aprobar" }).click();
    await expect(page.getByRole("heading", { name: "Entregado" })).toBeVisible();
    await accessible(page);
    if (process.env["DEVPILOT_DEMO_DIR"]) await page.getByRole("heading", { name: "Entregado" }).scrollIntoViewIfNeeded();
    await demoShot(page, "08");
    await page.getByText("Revisión manual con Claude Code", { exact: true }).click();
    await page.getByRole("button", { name: "Preparar material de revisión" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Preparar material" }).click();
    await expect(page.getByLabel("Material para revisar")).toHaveValue(/Evidencia QA/);
    await accessible(page);
    await page.getByLabel("Hallazgos para guardar").fill("Control manual del fixture");
    await page.getByRole("button", { name: "Guardar hallazgos" }).click();
    await expect(page.getByText("Hallazgos registrados")).toBeVisible();
    await page.getByRole("link", { name: "Informes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Informes", exact: true })).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Descargar informe técnico anonimizado" }).click();
    expect((await downloaded).suggestedFilename()).toBe("devpilot-portfolio.md");
    await accessible(page);
  } finally { await server.stop(); demo.remove(); }
});

test("consulta issues y pull requests con navegación y accesibilidad", async ({ page }) => {
  const demo = await fixture();
  const server = await demo.start({ ENABLE_GITHUB_READ: "true" });
  try {
    await page.route(/\/api\/v1\/projects\/[^/]+\/github\?/, async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const pulls = query.get("kind") === "pulls";
      const pageNumber = Number(query.get("page"));
      await route.fulfill({ json: {
        data: {
          repo: "example/devpilot-test", page: pageNumber, hasMore: pageNumber === 1,
          items: [{ number: pageNumber, title: pulls ? "Cambios del fixture" : "Issue del fixture", state: "open", draft: pulls,
            url: `https://github.com/example/devpilot-test/${pulls ? "pull" : "issues"}/${pageNumber}`, updatedAt: "2026-11-23T12:00:00Z" }],
        }, error: null, meta: {}, correlationId: "browser-github",
      } });
    });
    await login(page, server.url, demo.password);
    await page.getByRole("link", { name: "Proyectos", exact: true }).click();
    await page.getByLabel("Nombre", { exact: true }).fill("Consulta de GitHub");
    await page.getByLabel("Ruta del repositorio").fill(demo.repo);
    await page.getByRole("button", { name: "Registrar repositorio" }).click();
    await page.getByRole("link", { name: "Issues y PR de GitHub", exact: true }).click();
    await expect(page.getByRole("link", { name: "#1 Issue del fixture" })).toBeVisible();
    await accessible(page);
    await page.getByRole("link", { name: "Siguiente" }).click();
    await expect(page.getByRole("link", { name: "#2 Issue del fixture" })).toBeVisible();
    await page.getByRole("link", { name: "Pull requests" }).click();
    await expect(page.getByRole("link", { name: "#1 Cambios del fixture" })).toBeVisible();
    await expect(page.getByText("Borrador", { exact: false })).toBeVisible();
    await accessible(page);
  } finally { await server.stop(); demo.remove(); }
});

test("pantalla móvil: shell PWA sin datos almacenados cuando se pierde la conexión", async ({ browser }) => {
  const demo = await fixture();
  const server = await demo.start();
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  try {
    const page = await context.newPage();
    await login(page, server.url, demo.password);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const manifest = await page.request.get(server.url + "/manifest.webmanifest");
    const { icons } = await manifest.json();
    expect(icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
    await context.setOffline(true);
    await expect(page.getByText("Sin conexión con DevPilot:", { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sin conexión", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Panel" })).toHaveCount(0);
  } finally { await context.close(); await server.stop(); demo.remove(); }
});

test("tema oscuro accesible y cambio manual de tema", async ({ page }) => {
  const demo = await fixture();
  const server = await demo.start();
  try {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await login(page, server.url, demo.password);
    for (const name of ["Proyectos", "Agentes", "Informes", "Auditoría", "Seguridad"]) {
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await accessible(page);
    }
    await page.getByRole("button", { name: "Cambiar a tema claro" }).first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await accessible(page);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } finally { await server.stop(); demo.remove(); }
});
