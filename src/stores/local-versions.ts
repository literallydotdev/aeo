import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aeoReportCopySchema, type AeoReportCopy } from '../agents/copy-schema';
import { aeoCheckpointDir } from '../lib/paths';
import { aeoAuditConfigSchema, type AeoAuditConfig } from '../schema';
import { hasErrorCode } from './fs-errors';
import {
  StoreConflictError,
  type ApproveOptions,
  type ConfigStore,
  type ConfigVersion,
  type CopyStore,
  type CopyVersion,
  type DraftOptions,
  type StoreTransaction,
  type VersionMetadata,
} from './versions';

type LocalReport = {
  reportKey: string;
  slug: string;
  retiredAt: Date | null;
  copyOwner: 'agent' | 'human';
};

export type LocalVersionState = {
  configs: ConfigVersion[];
  copies: CopyVersion[];
  reports: LocalReport[];
};

// The registry file is written only by this repository, from typed state.
const isLocalVersionState = (value: unknown): value is LocalVersionState => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'configs' in value &&
    Array.isArray(value.configs) &&
    'copies' in value &&
    Array.isArray(value.copies) &&
    'reports' in value &&
    Array.isArray(value.reports)
  );
};

/** One transaction queue per file, including independent store instances. */
const fileQueues = new Map<string, Promise<unknown>>();

export class LocalVersionRepository {
  readonly #file: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #state: LocalVersionState = { configs: [], copies: [], reports: [] };

  constructor(file?: string) {
    this.#file = file;
  }

  async read(): Promise<LocalVersionState> {
    if (!this.#file) {
      return this.#state;
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, 'utf8'));

      if (!isLocalVersionState(parsed)) {
        throw new Error(`Invalid version registry file: ${this.#file}.`);
      }

      // JSON stores dates as strings; revive them in place.
      for (const record of [...parsed.configs, ...parsed.copies]) {
        record.createdAt = new Date(record.createdAt);
        record.approvedAt = record.approvedAt
          ? new Date(record.approvedAt)
          : null;
      }

      this.#state = parsed;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    return this.#state;
  }

  async mutate<T>(fn: (state: LocalVersionState) => T): Promise<T> {
    const file = this.#file;

    const perform = async () => {
      const next = structuredClone(await this.read());
      const result = fn(next);

      if (file) {
        await mkdir(path.dirname(file), { recursive: true });

        const temporary = `${file}.${process.pid}.tmp`;

        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, file);
      }

      this.#state = next;

      return structuredClone(result);
    };

    if (!file) {
      const pending = this.#queue.then(perform);

      this.#queue = pending.catch(() => undefined);

      return pending;
    }

    const pending = (fileQueues.get(file) ?? Promise.resolve()).then(perform);

    fileQueues.set(
      file,
      pending.catch(() => undefined),
    );

    return pending;
  }
}

// What differs between the config and the copy registries.
type VersionKind<T, R> = {
  rows: (state: LocalVersionState) => R[];
  parse: (value: T) => T;
  createRow: (metadata: VersionMetadata, value: T, options: DraftOptions) => R;
  // Called before the report lookup; configs create or check the report here.
  claimReport?: (state: LocalVersionState, value: T) => void;
  // Whether a non-agent draft hands the report's copy to a human.
  tracksCopyOwner: boolean;
};

class LocalVersionStore<
  T extends AeoAuditConfig | AeoReportCopy,
  R extends ConfigVersion | CopyVersion,
> {
  readonly #repo: LocalVersionRepository;
  readonly #kind: VersionKind<T, R>;

  constructor(repo: LocalVersionRepository, kind: VersionKind<T, R>) {
    this.#repo = repo;
    this.#kind = kind;
  }

  async list(reportKey?: string): Promise<R[]> {
    const state = await this.#repo.read();
    const rows = structuredClone(
      this.#kind
        .rows(state)
        .filter((row) => !reportKey || row.reportKey === reportKey),
    );

    return rows;
  }

  async getApproved(reportKey: string): Promise<R | null> {
    const rows = await this.list(reportKey);

    return rows.find((row) => row.status === 'approved') ?? null;
  }

  async getVersion(reportKey: string, version: number): Promise<R | null> {
    const rows = await this.list(reportKey);

    return rows.find((row) => row.version === version) ?? null;
  }

  async getBySlug(slug: string): Promise<R | null> {
    const state = await this.#repo.read();
    const report = state.reports.find(
      (candidate) => candidate.slug === slug && !candidate.retiredAt,
    );

    return report ? this.getApproved(report.reportKey) : null;
  }

  async putDraft(
    reportKey: string,
    value: T,
    options: DraftOptions,
  ): Promise<R> {
    const parsed = this.#kind.parse(value);

    if (parsed.reportKey !== reportKey) {
      throw new StoreConflictError('Draft belongs to another report');
    }

    return this.#repo.mutate((state) => {
      this.#kind.claimReport?.(state, parsed);

      const report = state.reports.find(
        (candidate) => candidate.reportKey === reportKey,
      );

      if (!report) {
        throw new StoreConflictError('Unknown report');
      }

      const rows = this.#kind.rows(state);
      const existing = options.authorJobId
        ? rows.find(
            (row) =>
              row.reportKey === reportKey &&
              row.authorJobId === options.authorJobId,
          )
        : undefined;

      if (existing) {
        return existing;
      }

      const version =
        Math.max(
          0,
          ...rows
            .filter((row) => row.reportKey === reportKey)
            .map((row) => row.version),
        ) + 1;
      const metadata: VersionMetadata = {
        reportKey,
        version,
        status: 'draft',
        source: options.source,
        authorJobId: options.authorJobId ?? null,
        pipelineId: options.pipelineId ?? null,
        flags: options.flags ?? [],
        verdict: options.verdict ?? null,
        confidence: options.confidence ?? null,
        notes: options.notes ?? null,
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date(),
      };
      const row = this.#kind.createRow(metadata, parsed, options);

      rows.push(row);

      if (this.#kind.tracksCopyOwner && options.source !== 'agent') {
        report.copyOwner = 'human';
      }

      return row;
    });
  }

  async approve(
    reportKey: string,
    version: number,
    { approvedBy }: ApproveOptions,
  ): Promise<void> {
    if (!approvedBy.trim()) {
      throw new StoreConflictError('Approval requires an actor');
    }

    await this.#repo.mutate((state) => {
      const rows = this.#kind.rows(state);
      const target = rows.find(
        (row) => row.reportKey === reportKey && row.version === version,
      );

      if (!target) {
        throw new StoreConflictError('Unknown version');
      }

      if (target.status === 'approved') {
        return;
      }

      if (target.status !== 'draft') {
        throw new StoreConflictError('Only a draft can be approved');
      }

      for (const row of rows) {
        if (row.reportKey === reportKey && row.status === 'approved') {
          row.status = 'superseded';
        }
      }

      target.status = 'approved';
      target.approvedBy = approvedBy;
      target.approvedAt = new Date();
    });
  }

  async reject(
    reportKey: string,
    version: number,
    _options?: StoreTransaction,
  ): Promise<void> {
    await this.#repo.mutate((state) => {
      const row = this.#kind
        .rows(state)
        .find(
          (candidate) =>
            candidate.reportKey === reportKey && candidate.version === version,
        );

      if (row?.status !== 'draft') {
        throw new StoreConflictError('Only a draft can be rejected');
      }

      row.status = 'rejected';
    });
  }

  async retire(reportKey: string, _options?: StoreTransaction): Promise<void> {
    await this.#repo.mutate((state) => {
      const report = state.reports.find(
        (candidate) => candidate.reportKey === reportKey,
      );

      if (!report) {
        throw new StoreConflictError('Unknown report');
      }

      report.retiredAt = new Date();

      for (const row of [...state.configs, ...state.copies]) {
        if (row.reportKey === reportKey && row.status === 'approved') {
          row.status = 'superseded';
        }
      }
    });
  }
}

const configKind: VersionKind<AeoAuditConfig, ConfigVersion> = {
  rows: (state) => state.configs,
  parse: (value) => aeoAuditConfigSchema.parse(value),
  createRow: (metadata, config) => ({ ...metadata, config }),
  tracksCopyOwner: false,
  claimReport: (state, config) => {
    const report = state.reports.find(
      (candidate) => candidate.reportKey === config.reportKey,
    );

    if (report && report.slug !== config.slug) {
      throw new StoreConflictError('Config must preserve the report slug');
    }

    if (report) {
      return;
    }

    if (state.reports.some((candidate) => candidate.slug === config.slug)) {
      throw new StoreConflictError('Report slug already exists');
    }

    state.reports.push({
      reportKey: config.reportKey,
      slug: config.slug,
      retiredAt: null,
      copyOwner: 'agent',
    });
  },
};

const copyKind: VersionKind<AeoReportCopy, CopyVersion> = {
  rows: (state) => state.copies,
  parse: (value) => aeoReportCopySchema.parse(value),
  createRow: (metadata, copy, options) => ({
    ...metadata,
    copy,
    basisRunId: options.basisRunId ?? null,
    provenance: options.provenance ?? null,
    validation: options.validation ?? null,
  }),
  tracksCopyOwner: true,
};

export class MemoryConfigStore
  extends LocalVersionStore<AeoAuditConfig, ConfigVersion>
  implements ConfigStore
{
  constructor(repo = new LocalVersionRepository()) {
    super(repo, configKind);
  }
}

export class MemoryCopyStore
  extends LocalVersionStore<AeoReportCopy, CopyVersion>
  implements CopyStore
{
  constructor(repo = new LocalVersionRepository()) {
    super(repo, copyKind);
  }
}

export const memoryVersionStores = (repo = new LocalVersionRepository()) => {
  const stores = {
    configStore: new MemoryConfigStore(repo),
    copyStore: new MemoryCopyStore(repo),
  };

  return stores;
};

export const openFileVersionStores = (
  directory = path.join(aeoCheckpointDir, 'configs'),
) => {
  return memoryVersionStores(
    new LocalVersionRepository(path.join(directory, 'registry.json')),
  );
};
