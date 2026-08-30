import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceHealthDetail } from './source-health';

test('no-relevant-rows status explains that parsing succeeded', () => {
  assert.equal(
    sourceHealthDetail({
      status: 'NO_RELEVANT_ROWS',
      latestFailureMessage: null,
      latestFailureStage: null,
      nextExpectedRefreshDate: '2026-10-01',
      lastSuccessfulPullAt: '2026-08-30T00:00:00.000Z',
      cadenceType: 'price_disclosure_cycle',
      totalRows: 36,
      watchlistUnmatchedRows: 0,
    }),
    'Parsed 36 rows successfully; none matched the tracked local PBS catalogue',
  );
});

test('failed status never falls through to a healthy message', () => {
  assert.equal(
    sourceHealthDetail({
      status: 'FAILED',
      latestFailureMessage: null,
      latestFailureStage: 'parse',
      nextExpectedRefreshDate: null,
      lastSuccessfulPullAt: '2026-08-30T00:00:00.000Z',
      cadenceType: 'price_disclosure_cycle',
      totalRows: 36,
      watchlistUnmatchedRows: 0,
    }),
    'parse failed · No failure detail was recorded',
  );
});

test('coverage-gap status identifies tracked rows missing from the catalogue', () => {
  assert.equal(
    sourceHealthDetail({
      status: 'COVERAGE_GAP',
      latestFailureMessage: null,
      latestFailureStage: null,
      nextExpectedRefreshDate: null,
      lastSuccessfulPullAt: '2026-08-30T00:00:00.000Z',
      cadenceType: 'price_disclosure_cycle',
      totalRows: 36,
      watchlistUnmatchedRows: 2,
    }),
    '2 tracked source rows are missing from the local PBS catalogue',
  );
});