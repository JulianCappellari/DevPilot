/** Aprobaciones ligadas a operación, run y hash del diff; caducan y no se reutilizan (RN-020, RNF-007). */
export type ApprovalDecision = "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";

export type Approval = {
  readonly id: string;
  readonly runId: string;
  readonly action: string;
  readonly diffHash: string | null;
  readonly expiresAt: Date;
  readonly decision: ApprovalDecision;
  readonly consumedAt: Date | null;
};

export type ApprovalCheck = { runId: string; action: string; currentDiffHash: string | null; now: Date };
export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "NOT_APPROVED" | "EXPIRED" | "WRONG_RUN" | "WRONG_ACTION" | "DIFF_CHANGED" | "ALREADY_USED" };

export function validateApproval(a: Approval, c: ApprovalCheck): ApprovalResult {
  if (a.runId !== c.runId) return { ok: false, reason: "WRONG_RUN" };
  if (a.action !== c.action) return { ok: false, reason: "WRONG_ACTION" }; // "revisar diff" no autoriza push/merge
  if (a.decision !== "APPROVED") return { ok: false, reason: "NOT_APPROVED" };
  if (a.consumedAt !== null) return { ok: false, reason: "ALREADY_USED" };
  if (a.expiresAt.getTime() <= c.now.getTime()) return { ok: false, reason: "EXPIRED" };
  if (a.diffHash !== c.currentDiffHash) return { ok: false, reason: "DIFF_CHANGED" };
  return { ok: true };
}

export const consumeApproval = (a: Approval, now: Date): Approval => ({ ...a, consumedAt: now });
