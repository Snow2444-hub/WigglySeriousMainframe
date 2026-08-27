import { useMemo, useState } from 'react';
import {
  getListUpcomingPredictedReductionsQueryKey,
  useListUpcomingPredictedReductions,
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { CalendarDays, Filter, TrendingDown } from 'lucide-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const percentage = (value: number) => `${Math.abs(value).toFixed(1).replace(/\.0$/, '')}%`;
type ConfidenceFilter = '' | 'high' | 'conditional' | 'indicative' | 'confirmed';

export function UpcomingChangesPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [confidence, setConfidence] = useState<ConfidenceFilter>('');
  const params = useMemo(
    () => ({ from: from || undefined, to: to || undefined, confidence: confidence || undefined }),
    [from, to, confidence],
  );
  const predictions = useListUpcomingPredictedReductions(params, {
    query: { queryKey: getListUpcomingPredictedReductionsQueryKey(params) },
  });

  return (
    <AppShell>
      <PageHeading
        eyebrow="PBS price intelligence"
        title="Upcoming changes"
        description="Every upcoming predicted PBS reduction for your watchlist, ordered by effective date and then reduction size."
      />
      <div className="mb-6 grid gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm md:grid-cols-[1fr_1fr_220px]">
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" />
          <span>From</span>
          <input value={from} onChange={(event) => setFrom(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-from" />
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" />
          <span>To</span>
          <input value={to} onChange={(event) => setTo(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-to" />
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm font-semibold">
          <Filter className="h-4 w-4 text-info" />
          <select value={confidence} onChange={(event) => setConfidence(event.target.value as ConfidenceFilter)} className="min-w-0 flex-1 bg-transparent outline-none" data-testid="select-upcoming-confidence">
            <option value="">All confidence levels</option>
            <option value="high">High confidence</option>
            <option value="confirmed">Confirmed</option>
            <option value="conditional">Conditional</option>
            <option value="indicative">Indicative</option>
          </select>
        </label>
      </div>
      {predictions.isLoading ? <QueryState kind="loading" /> :
       predictions.isError ? <QueryState kind="error" onRetry={() => predictions.refetch()} /> :
       !predictions.data?.length ? <QueryState kind="empty" /> : (
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" data-testid="table-upcoming-changes">
          <div className="flex items-center justify-between border-b border-border bg-muted/25 px-5 py-3">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Predicted reductions</span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{predictions.data.length} upcoming</span>
          </div>
          <div className="hidden grid-cols-[1.25fr_1fr_.95fr_1.2fr_.55fr_.75fr] gap-4 border-b border-border bg-muted/15 px-5 py-2.5 font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-muted-foreground md:grid">
            <span>Drug / brand</span><span>Strength</span><span>Effective</span><span className="text-right">Current → predicted</span><span className="text-right">Change</span><span>Confidence</span>
          </div>
          <div className="divide-y divide-border">
            {predictions.data.map((prediction) => (
              <Link key={`${prediction.itemCode}-${prediction.predictedDate}-${prediction.reductionType}`} href={`/pbs/${encodeURIComponent(prediction.itemCode)}`} className="grid gap-2 px-5 py-4 transition-colors hover:bg-secondary/25 md:grid-cols-[1.25fr_1fr_.95fr_1.2fr_.55fr_.75fr] md:items-center md:gap-4" data-testid={`row-upcoming-${prediction.itemCode}`}>
                <div><p className="text-sm font-bold text-foreground">{prediction.brandName}</p><p className="mt-0.5 text-xs font-medium text-muted-foreground">{prediction.drugName}</p></div>
                <span className="text-xs font-semibold text-muted-foreground">{prediction.strength ?? 'Strength not supplied'}</span>
                <span className="font-mono text-xs font-bold text-foreground">{date(prediction.predictedDate)}</span>
                <span className="text-right font-mono text-sm font-bold"><span>{money(prediction.currentPrice)}</span> <span className="text-info">→ {money(prediction.predictedNewPrice)}</span></span>
                <span className="text-right font-mono text-sm font-bold text-info">−{percentage(prediction.predictedPercentage)}</span>
                <span className="justify-self-start rounded-md bg-info/10 px-2 py-1 text-[10px] font-bold capitalize text-info">{prediction.confidence}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}