import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDateOnly, formatDateTime, formatDateValue } from './date-format';

test('date formatters return fallbacks for missing and invalid values', () => {
  assert.equal(formatDateValue(null, { year: 'numeric' }), '—');
  assert.equal(formatDateValue(undefined, { year: 'numeric' }), '—');
  assert.equal(formatDateValue('not-a-date', { year: 'numeric' }), '—');
  assert.equal(formatDateValue(new Date(Number.NaN), { year: 'numeric' }), '—');
  assert.equal(formatDateValue(Number.POSITIVE_INFINITY, { year: 'numeric' }), '—');
  assert.equal(formatDateOnly(null), 'date unavailable');
  assert.equal(formatDateTime(null), '—');
});