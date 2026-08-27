export type PercentageSignificance = 'normal' | 'medium' | 'high';

export function reductionTextClass(significance: string | null | undefined): string {
  if (significance === 'high') return 'text-destructive';
  if (significance === 'medium') return 'text-warning';
  return 'text-muted-foreground';
}

export function reductionBadgeClass(significance: string | null | undefined): string {
  if (significance === 'high') return 'bg-destructive/10 text-destructive';
  if (significance === 'medium') return 'bg-warning/15 text-warning';
  return 'bg-muted text-muted-foreground';
}

export function reductionBorderClass(significance: string | null | undefined): string {
  if (significance === 'high') return 'border-l-destructive';
  if (significance === 'medium') return 'border-l-warning';
  return 'border-l-transparent';
}