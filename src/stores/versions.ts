import type { TransactionSql } from 'postgres';
import type { AeoAuditConfig } from '../schema';
import type { AeoReportCopy } from '../agents/copy-schema';

// ============================================================================
// Versioned config and copy stores: the port. The hosted Postgres
// implementation is stores/postgres-versions.ts; the engine's file and memory
// stores are stores/local-versions.ts. A transaction is the hosted adapter's
// (`postgres` types only, never loaded here).
// ============================================================================

export type VersionStatus = 'draft' | 'approved' | 'rejected' | 'superseded';
export type VersionSource = 'agent' | 'human' | 'import';

export class StoreConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreConflictError';
  }
}

export type VersionMetadata = {
  reportKey: string;
  version: number;
  status: VersionStatus;
  source: VersionSource;
  authorJobId: string | null;
  pipelineId: string | null;
  flags: unknown[];
  verdict: 'fit' | 'not_a_fit' | null;
  confidence: number | null;
  notes: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
};

export type ConfigVersion = VersionMetadata & { config: AeoAuditConfig };

export type CopyVersion = VersionMetadata & {
  copy: AeoReportCopy;
  basisRunId: string | null;
  provenance: unknown;
  validation: unknown;
};

export type StoreTransaction = {
  tx?: TransactionSql;
  pipelineId?: string;
};

export type DraftOptions = {
  audience?: 'client_private' | 'unlisted_public';
  source: VersionSource;
  authorJobId?: string;
  flags?: unknown[];
  verdict?: 'fit' | 'not_a_fit';
  confidence?: number;
  notes?: string;
  basisRunId?: string;
  provenance?: unknown;
  validation?: unknown;
} & StoreTransaction;

export type ApproveOptions = {
  approvedBy: string;
} & StoreTransaction;

export type ConfigStore = {
  getApproved(reportKey: string): Promise<ConfigVersion | null>;
  getVersion(reportKey: string, version: number): Promise<ConfigVersion | null>;
  getBySlug(slug: string): Promise<ConfigVersion | null>;
  list(reportKey?: string): Promise<ConfigVersion[]>;
  putDraft(
    reportKey: string,
    config: AeoAuditConfig,
    options: DraftOptions,
  ): Promise<ConfigVersion>;
  approve(
    reportKey: string,
    version: number,
    options: ApproveOptions,
  ): Promise<void>;
  reject(
    reportKey: string,
    version: number,
    options?: StoreTransaction,
  ): Promise<void>;
  retire(reportKey: string, options?: StoreTransaction): Promise<void>;
};

export type CopyStore = {
  getApproved(reportKey: string): Promise<CopyVersion | null>;
  getVersion(reportKey: string, version: number): Promise<CopyVersion | null>;
  getBySlug(slug: string): Promise<CopyVersion | null>;
  list(reportKey?: string): Promise<CopyVersion[]>;
  putDraft(
    reportKey: string,
    copy: AeoReportCopy,
    options: DraftOptions,
  ): Promise<CopyVersion>;
  approve(
    reportKey: string,
    version: number,
    options: ApproveOptions,
  ): Promise<void>;
  reject(
    reportKey: string,
    version: number,
    options?: StoreTransaction,
  ): Promise<void>;
  retire(reportKey: string, options?: StoreTransaction): Promise<void>;
};
