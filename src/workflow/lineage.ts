import type { Sql, TransactionSql } from 'postgres';

/**
 * lineageDepthLimit is how many retry hops a lineage walk follows before it
 * is cut. A stored chain longer than this (or a corrupted cycle) is bounded
 * here, and the callback contract accepts exactly this many ancestors.
 */
export const lineageDepthLimit = 100;

export type LineagePipeline = {
  pipelineId: string;
  retryOf: string | null;
  reportKey: string;
  submissionId: string | null;
};

/**
 * retryLineage returns the pipeline and every attempt it retries, newest
 * first: the pipeline itself, then its `retryOf`, and so on up to
 * `lineageDepthLimit` hops. Callers apply their own scope (same report, same
 * submission) to the returned rows.
 */
export const retryLineage = async (
  sql: Sql | TransactionSql,
  pipelineId: string,
): Promise<LineagePipeline[]> => {
  return sql<LineagePipeline[]>`
    with recursive lineage as (
      select "pipelineId", "retryOf", "reportKey", "submissionId", 0 as depth
      from "AeoPipeline" where "pipelineId"=${pipelineId}
      union all
      select p."pipelineId", p."retryOf", p."reportKey", p."submissionId", l.depth + 1
      from "AeoPipeline" p join lineage l on p."pipelineId"=l."retryOf"
      where l.depth < ${lineageDepthLimit}
    ) select "pipelineId", "retryOf", "reportKey", "submissionId" from lineage order by depth`;
};
