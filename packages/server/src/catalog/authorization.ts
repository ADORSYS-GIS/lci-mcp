import type { RepositoryCatalogRecord } from "./schema.js";
import type { WorkerOperation } from "./workerRegistry.js";

export interface AuthorizationAuditEvent {
  repositoryId: string;
  operation: WorkerOperation;
  principal?: string;
  allowed: boolean;
}

export type AuthorizationAuditSink = (event: AuthorizationAuditEvent) => void;

/** Empty allowlists mean trusted local mode; configured allowlists fail closed. */
export function createRepositoryAuthorizer(audit?: AuthorizationAuditSink) {
  return (repository: RepositoryCatalogRecord, operation: WorkerOperation, principal?: string): boolean => {
    const allowed =
      repository.allowedPrincipals.length === 0 ||
      (principal !== undefined && repository.allowedPrincipals.includes(principal));
    audit?.({ repositoryId: repository.repositoryId, operation, principal, allowed });
    return allowed;
  };
}

export type RepositoryAuthorizer = ReturnType<typeof createRepositoryAuthorizer>;
