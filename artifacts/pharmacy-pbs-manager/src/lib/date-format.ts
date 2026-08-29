type DateValue = string | number | Date | null | undefined;

type DateFormatOptions = Intl.DateTimeFormatOptions;

function parseDate(value: DateValue): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function formatDateValue(
  value: DateValue,
  options: DateFormatOptions,
  fallback = '—',
): string {
  const parsed = parseDate(value);
  return parsed ? new Intl.DateTimeFormat('en-AU', options).format(parsed) : fallback;
}

export function formatDateOnly(
  value: string | null | undefined,
  fallback = 'date unavailable',
): string {
  if (!value?.trim()) return fallback;
  return formatDateValue(`${value}T12:00:00Z`, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }, fallback);
}

export function formatDateTime(
  value: DateValue,
  fallback = '—',
): string {
  return formatDateValue(value, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }, fallback);
}