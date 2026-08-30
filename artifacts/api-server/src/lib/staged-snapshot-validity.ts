export const DEFAULT_STAGED_SNAPSHOT_FUTURE_HORIZON_MONTHS = 18;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function stagedRunIdFromRequestKey(requestKey: string): number | undefined {
  const match = /:run-(\d+)$/.exec(requestKey);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
}

function dateOnlyMonthsFrom(date: Date, months: number): string {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
  return result.toISOString().slice(0, 10);
}

export function isAuthoritativeStagedSnapshot(input: {
  requestKey: string;
  effectiveDate: string;
  ingestionRunIds: ReadonlySet<number>;
  now?: Date;
  futureHorizonMonths?: number;
}): boolean {
  const runId = stagedRunIdFromRequestKey(input.requestKey);
  if (runId === undefined || !input.ingestionRunIds.has(runId)) return false;
  if (!DATE_ONLY_PATTERN.test(input.effectiveDate)) return false;

  const futureHorizonMonths =
    input.futureHorizonMonths ?? DEFAULT_STAGED_SNAPSHOT_FUTURE_HORIZON_MONTHS;
  return input.effectiveDate <= dateOnlyMonthsFrom(input.now ?? new Date(), futureHorizonMonths);
}