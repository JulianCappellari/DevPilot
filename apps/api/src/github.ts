import { githubDestination, pushDeliveredBranch, runCommand } from "@devpilot/runner";
import { z } from "zod";
import { AppError } from "./errors.js";
import { redactSecrets } from "@devpilot/security";

const prSchema = z.object({ number: z.number().int().positive(), html_url: z.string(), head: z.object({ sha: z.string() }) });
type Pull = z.infer<typeof prSchema>;
export type PrTarget = { slug: string; url: string };
export type PrPublisher = {
  destination: typeof githubDestination;
  publish(repo: string, target: PrTarget, runId: string, sha: string, title: string): Promise<{ number: number; url: string }>;
};

const itemSchema = z.object({
  number: z.number().int().positive(), title: z.string().max(500), state: z.enum(["open", "closed"]),
  updated_at: z.string(), draft: z.boolean().optional(), pull_request: z.object({}).optional(),
});
type ItemList = { items: { number: number; title: string; state: "open" | "closed"; updatedAt: string; url: string; draft: boolean }[]; hasMore: boolean };
export type GithubReader = (cwd: string, slug: string, kind: "issues" | "pulls", page: number, state: "open" | "closed" | "all") => Promise<ItemList>;

async function api(cwd: string, method: string, endpoint: string, body?: object, fields?: string): Promise<unknown> {
  const result = await runCommand({ file: "gh", args: ["api", "--hostname", "github.com", "--method", method, endpoint,
    ...(fields ? ["--jq", fields] : []),
    ...(body ? ["--input", "-"] : [])], cwd, timeoutMs: 30_000, env: { GH_PROMPT_DISABLED: "1" },
    ...(body ? { input: JSON.stringify(body) } : {}) });
  if (result.exitCode !== 0) {
    const forbidden = /HTTP (401|403|404)/.test(result.stderr);
    throw new AppError(forbidden ? "FORBIDDEN" : "PROVIDER_UNAVAILABLE", forbidden
      ? "GitHub no autorizó el acceso. Revisá las credenciales y los permisos del repositorio."
      : "GitHub CLI no respondió. Verificá gh auth status y la conexión.");
  }
  return JSON.parse(result.stdout) as unknown;
}

export const readGithub: GithubReader = async (cwd, slug, kind, page, state) => {
  const response = await api(cwd, "GET", `repos/${slug}/${kind}?state=${state}&per_page=20&page=${page}`, undefined,
    "[.[] | {number,title,state,updated_at} + (if .pull_request then {pull_request:{}} else {} end) + (if .draft then {draft:true} else {} end)]");
  const parsed = z.array(itemSchema).max(20).safeParse(response);
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "GitHub devolvió una lista con formato inesperado");
  return {
    items: parsed.data.filter((item) => kind === "pulls" || !item.pull_request).map((item) => ({
      number: item.number, title: redactSecrets(item.title), state: item.state, updatedAt: item.updated_at, draft: Boolean(item.draft),
      url: `https://github.com/${slug}/${kind === "pulls" ? "pull" : "issues"}/${item.number}`,
    })),
    hasMore: parsed.data.length === 20,
  };
};

function verifyPr(pr: Pull, target: PrTarget, sha: string) {
  const url = `https://github.com/${target.slug}/pull/${pr.number}`;
  if (pr.head.sha !== sha || pr.html_url.toLowerCase() !== url.toLowerCase())
    throw new AppError("INVALID_STATE", "El PR de esta rama apunta a un destino o commit distinto");
  return { number: pr.number, url };
}

export const githubPublisher: PrPublisher = {
  destination: githubDestination,
  async publish(repo, target, runId, sha, title) {
    const endpoint = `repos/${target.slug}`;
    const branch = `devpilot/${runId}`;
    const metadata = z.object({ default_branch: z.string(), permissions: z.object({ push: z.boolean() }).optional() })
      .parse(await api(repo, "GET", endpoint));
    if (metadata.permissions?.push === false) throw new AppError("FORBIDDEN", "GitHub no otorgó permiso para publicar en este repositorio");
    const head = encodeURIComponent(`${target.slug.split("/")[0]}:${branch}`);
    const existing = z.array(prSchema).parse(await api(repo, "GET", `${endpoint}/pulls?state=all&head=${head}`))[0];
    if (existing) return verifyPr(existing, target, sha);
    try {
      await pushDeliveredBranch(repo, target.url, runId, sha);
    } catch (error) {
      throw new AppError("INVALID_STATE", error instanceof Error ? error.message : "No se pudo publicar la rama");
    }
    const created = prSchema.parse(await api(repo, "POST", `${endpoint}/pulls`, {
      base: metadata.default_branch, head: branch, title, draft: true, body: `Cambios revisados en DevPilot. Ejecución: ${runId}.`,
    }));
    return verifyPr(created, target, sha);
  },
};
