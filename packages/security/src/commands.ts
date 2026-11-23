/**
 * Allowlist de comandos de QA (spec §13.2). Comandos tipados {file,args}; nunca strings de shell.
 * El runner (apps/worker) debe usar spawn con shell:false. En Windows `npm` es `npm.cmd` y Node
 * rechaza lanzar .cmd sin shell: el runner deberá resolver `node <npm-cli.js>` explícitamente.
 */
export type TypedCommand = { readonly file: string; readonly args: readonly string[] };

export const ALLOWLISTED_CHECKS = {
  lint: { file: "npm", args: ["run", "lint"] },
  test: { file: "npm", args: ["run", "test", "--", "--run"] },
  typecheck: { file: "npm", args: ["run", "typecheck"] },
} as const satisfies Record<string, TypedCommand>;

export type CheckId = keyof typeof ALLOWLISTED_CHECKS;

export class CommandDeniedError extends Error {
  constructor(readonly code: "UNKNOWN_COMMAND" | "NOT_ENABLED_FOR_PROJECT") {
    super(code === "UNKNOWN_COMMAND" ? "Comando no permitido" : "Comando no habilitado para este proyecto");
    this.name = "CommandDeniedError";
  }
}

const isCheckId = (id: string): id is CheckId => Object.hasOwn(ALLOWLISTED_CHECKS, id);

/** Resuelve un id de check a un comando tipado. Sólo ids conocidos y habilitados por proyecto. */
export function resolveCheck(commandId: string, projectEnabled: readonly string[]): TypedCommand {
  if (!isCheckId(commandId)) throw new CommandDeniedError("UNKNOWN_COMMAND");
  if (!projectEnabled.includes(commandId)) throw new CommandDeniedError("NOT_ENABLED_FOR_PROJECT");
  const c = ALLOWLISTED_CHECKS[commandId];
  return { file: c.file, args: [...c.args] };
}
