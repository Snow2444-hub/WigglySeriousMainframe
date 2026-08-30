import type { AdminPbsSourceStatus } from '@workspace/api-client-react';
import { formatDateValue } from './date-format';

type SourceHealthDetail = Pick<
  AdminPbsSourceStatus,
  | 'status'
  | 'latestFailureMessage'
  | 'latestFailureStage'
  | 'nextExpectedRefreshDate'
  | 'lastSuccessfulPullAt'
  | 'cadenceType'
  | 'totalRows'
  | 'watchlistUnmatchedRows'
>;

const date = (value: string) =>
  formatDateValue(value, { day: '2-digit', month: 'short', year: 'numeric' });

export function sourceHealthDetail(row: SourceHealthDetail): string {
  if (row.status === 'FAILED') {
    const stage = row.latestFailureStage ? `${row.latestFailureStage} failed` : 'Latest attempt failed';
    return row.latestFailureMessage
      ? `${stage} · ${row.latestFailureMessage}`
      : `${stage} · No failure detail was recorded`;
  }
  if (row.status === 'NO_RELEVANT_ROWS') {
    return `Parsed ${row.totalRows} rows successfully; none matched the tracked local PBS catalogue`;
  }
  if (row.status === 'COVERAGE_GAP') {
    return `${row.watchlistUnmatchedRows} tracked source ${row.watchlistUnmatchedRows === 1 ? 'row is' : 'rows are'} missing from the local PBS catalogue`;
  }
  if (row.status === 'STALE') {
    return row.nextExpectedRefreshDate
      ? `No newer file after ${date(row.nextExpectedRefreshDate)}`
      : 'No newer file has been recorded';
  }
  if (!row.lastSuccessfulPullAt) return 'No successful observation has been recorded yet';
  return row.cadenceType === 'unconfigured'
    ? 'Source is healthy; refresh cadence is not configured'
    : 'Source is healthy';
}