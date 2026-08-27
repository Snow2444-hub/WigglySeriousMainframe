import { useParams } from 'wouter';
import { 
  useGetPbsItem, getGetPbsItemQueryKey,
  useListPriceHistory, getListPriceHistoryQueryKey,
  useListItemPredictedReductions, getListItemPredictedReductionsQueryKey,
  useListItemScheduleChanges, getListItemScheduleChangesQueryKey,
  useListItemPremiumHistory, getListItemPremiumHistoryQueryKey,
} from '@workspace/api-client-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { reductionTextClass } from '@/lib/percentage-significance';
import { Link } from 'wouter';
import { ArrowLeft, TrendingDown, History, AlertTriangle, Info, CalendarDays, Activity, Building2, ArrowRight } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { format, parseISO } from 'date-fns';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const dateStr = (value: string) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
type PremiumSnapshot = {
  scheduleEffectiveDate: string;
  scheduleCode: number;
  brandPremium: number | null;
  therapeuticGroupPremium: number | null;
  hasTherapeuticExemption: boolean;
  ruleCount: number;
};

const isTherapeuticExemption = (value: string | null) => value?.trim().toUpperCase() === 'Y';

function highestPremium(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
}

function PremiumHistoryPanel({
  title,
  valueKey,
  snapshots,
  loading,
  error,
  className,
}: {
  title: string;
  valueKey: 'brandPremium' | 'therapeuticGroupPremium';
  snapshots: PremiumSnapshot[];
  loading: boolean;
  error: boolean;
  className?: string;
}) {
  const latest = snapshots[0];
  const latestValue = latest?.[valueKey] ?? null;

  return (
    <section className={`overflow-hidden rounded-2xl border border-border bg-card shadow-sm ${className ?? ''}`}>
      <div className="border-b border-border bg-muted/20 px-6 py-5">
        <p className="font-bold text-foreground">{title}</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-2xl font-bold tracking-tight text-foreground">
            {loading ? '…' : latestValue === null ? 'Not published' : money(latestValue)}
          </span>
          {latest?.hasTherapeuticExemption && (
            <span className="rounded bg-info/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-info">
              Exempt — not applicable
            </span>
          )}
        </div>
      </div>
      <div className="max-h-[248px] overflow-auto">
        {loading ? <div className="p-6"><QueryState kind="loading" /></div> :
         error ? <div className="p-6 text-sm font-medium text-destructive">Premium history could not be loaded.</div> :
         !snapshots.length ? <div className="p-6 text-sm font-medium text-muted-foreground">Premium history has not been ingested for this item yet.</div> : (
          <div className="divide-y divide-border">
            {snapshots.map((snapshot) => (
              <div key={`${snapshot.scheduleCode}-${snapshot.scheduleEffectiveDate}`} className="flex items-center justify-between gap-3 px-6 py-3 text-xs">
                <div>
                  <p className="font-semibold text-foreground">{dateStr(snapshot.scheduleEffectiveDate)}</p>
                  <p className="mt-0.5 font-mono text-[10px] font-bold text-muted-foreground">SCH {snapshot.scheduleCode} · {snapshot.ruleCount} rule{snapshot.ruleCount === 1 ? '' : 's'}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono font-bold text-foreground">
                    {snapshot[valueKey] === null ? 'Not published' : money(snapshot[valueKey] as number)}
                  </p>
                  {snapshot.hasTherapeuticExemption && <p className="mt-0.5 text-[10px] font-semibold text-info">Exemption applies</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PremiumSummary({ className }: { className?: string }) {
  return (
    <div className={`rounded-2xl border border-border bg-card px-6 py-4 text-sm font-semibold text-muted-foreground shadow-sm ${className ?? ''}`}>
      Brand premium: none <span className="mx-2 text-border">·</span> Therapeutic group premium: none
    </div>
  );
}

export function PbsItemEvidence() {
  const params = useParams();
  const itemCode = params.itemCode!;

  const itemQuery = useGetPbsItem(itemCode, { query: { enabled: !!itemCode, queryKey: getGetPbsItemQueryKey(itemCode) } });
  const priceHistory = useListPriceHistory(itemCode, { query: { enabled: !!itemCode, queryKey: getListPriceHistoryQueryKey(itemCode) } });
  const predictedReductions = useListItemPredictedReductions(itemCode, { query: { enabled: !!itemCode, queryKey: getListItemPredictedReductionsQueryKey(itemCode) } });
  const scheduleChanges = useListItemScheduleChanges(itemCode, { query: { enabled: !!itemCode, queryKey: getListItemScheduleChangesQueryKey(itemCode) } });
  const premiumHistory = useListItemPremiumHistory(itemCode, { query: { enabled: !!itemCode, queryKey: getListItemPremiumHistoryQueryKey(itemCode) } });

  const item = itemQuery.data;

  const chartData = [...(priceHistory.data || [])]
    .sort((a, b) => new Date(a.priceDate).getTime() - new Date(b.priceDate).getTime())
    .map(p => ({
      date: format(parseISO(p.priceDate), 'MMM yyyy'),
      fullDate: p.priceDate,
      price: p.aemp
    }));
  const medicineContext = item
    ? [item.drugName, item.activeIngredient].filter((value, index, values) =>
        values.findIndex((candidate) => candidate.trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase()) === index,
      )
    : [];
  const hasPredictions = Boolean(predictedReductions.data?.length);
  const premiumSnapshots = Object.values(
    (premiumHistory.data ?? []).reduce<Record<string, PremiumSnapshot>>((bySchedule, record) => {
      const key = `${record.scheduleCode}:${record.scheduleEffectiveDate}`;
      const existing = bySchedule[key] ?? {
        scheduleEffectiveDate: record.scheduleEffectiveDate,
        scheduleCode: record.scheduleCode,
        brandPremium: null,
        therapeuticGroupPremium: null,
        hasTherapeuticExemption: false,
        ruleCount: 0,
      };
      bySchedule[key] = {
        ...existing,
        brandPremium: highestPremium([existing.brandPremium, record.brandPremium]),
        therapeuticGroupPremium: highestPremium([existing.therapeuticGroupPremium, record.therapeuticGroupPremium]),
        hasTherapeuticExemption: existing.hasTherapeuticExemption || isTherapeuticExemption(record.therapeuticExemptionIndicator),
        ruleCount: existing.ruleCount + 1,
      };
      return bySchedule;
    }, {}),
  ).sort((left, right) => right.scheduleEffectiveDate.localeCompare(left.scheduleEffectiveDate));
  const hasPublishedPremium = premiumSnapshots.some(
    (snapshot) => (snapshot.brandPremium ?? 0) > 0 || (snapshot.therapeuticGroupPremium ?? 0) > 0,
  );

  return (
    <AppShell>
      <div className="mb-4 animate-rise-in">
        <Link href="/pbs" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to directory
        </Link>
      </div>

      {itemQuery.isLoading ? <QueryState kind="loading" /> : 
       itemQuery.isError || !item ? <QueryState kind="error" onRetry={() => itemQuery.refetch()} /> : (
         <div className="min-w-0 max-w-full space-y-6">
          <div className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-sm animate-rise-in delay-1">
            <div className="flex flex-col md:flex-row justify-between gap-6 md:items-start">
              <div>
                 <div className="mb-3 flex min-w-0 flex-wrap items-center gap-3">
                  <span className={`rounded-lg px-3 py-1 font-mono text-sm font-bold ${item.formulary === 'F1' ? 'bg-sidebar-primary/10 text-sidebar-primary' : 'bg-chart-2/15 text-chart-2'}`}>
                    {item.formulary}
                  </span>
                </div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-2">
                  {[item.brandName || item.drugName, item.strength].filter(Boolean).join(' · ')}
                </h1>
                <p className="text-lg text-muted-foreground font-medium">
                   {medicineContext.join(' • ')}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Building2 className="h-4 w-4" /> {item.sponsor}</span>
                  <span className="flex items-center gap-1.5"><Info className="h-4 w-4" /> {item.form || 'Unknown form'} <span className="opacity-40 mx-1">•</span> {item.packSize || 'Unknown size'}</span>
                    <span className="font-mono text-[9px] font-medium text-muted-foreground/50" title="Internal PBS listing identifier">Listing ID {item.liItemId || item.itemCode}</span>
                </div>
              </div>
              <div className="text-left md:text-right rounded-xl bg-muted/40 p-5 min-w-[200px] border border-border/50">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground mb-2">Current ex-manufacturer / wholesale price</div>
                <div className="text-4xl font-bold font-mono text-foreground tracking-tighter">
                  {money(item.currentAemp)}
                </div>
                <div className="mt-3 text-xs font-semibold text-muted-foreground flex items-center md:justify-end gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5 text-info" /> Updated {dateStr(item.lastUpdated)}
                </div>
              </div>
            </div>
          </div>

            <div className="space-y-6 animate-rise-in delay-2">
               <div className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="border-b border-border px-6 py-5 flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-foreground">
                  <Activity className="h-5 w-5 text-info" /> Ex-manufacturer / wholesale price history
                </div>
              </div>
                <div className="h-[360px] min-w-0 max-w-full overflow-hidden p-4 sm:p-6">
                {priceHistory.isLoading ? <QueryState kind="loading" /> :
                 !chartData.length ? <div className="h-full flex items-center justify-center text-muted-foreground text-sm font-medium">No price history available.</div> : (
                   <ResponsiveContainer width="100%" height={380}>
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis 
                        dataKey="date" 
                        stroke="hsl(var(--muted-foreground))" 
                        fontSize={12} 
                        tickLine={false} 
                        axisLine={false} 
                        dy={10}
                      />
                      <YAxis 
                        stroke="hsl(var(--muted-foreground))" 
                        fontSize={12} 
                        tickLine={false} 
                        axisLine={false} 
                        tickFormatter={(value) => `$${value}`}
                        domain={['auto', 'auto']}
                        dx={-10}
                      />
                      <RechartsTooltip 
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            return (
                              <div className="rounded-lg border border-border bg-card p-3 shadow-md">
                                <p className="text-xs text-muted-foreground font-semibold mb-1">{dateStr(payload[0].payload.fullDate)}</p>
                                <p className="font-mono text-sm font-bold text-foreground">{money(payload[0].value as number)}</p>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Area 
                        type="stepAfter" 
                        dataKey="price" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2} 
                        fillOpacity={1} 
                        fill="url(#colorPrice)" 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

             <div className="grid gap-6 lg:grid-cols-2">
              {!premiumHistory.isLoading && !premiumHistory.isError && !hasPublishedPremium ? (
                <PremiumSummary className="order-2 lg:col-span-2" />
              ) : (
                <>
              <PremiumHistoryPanel
                title="Brand premium"
                valueKey="brandPremium"
                snapshots={premiumSnapshots}
                loading={premiumHistory.isLoading}
                error={premiumHistory.isError}
                 className="order-2"
              />
              <PremiumHistoryPanel
                title="Therapeutic group premium"
                valueKey="therapeuticGroupPremium"
                snapshots={premiumSnapshots}
                loading={premiumHistory.isLoading}
                error={premiumHistory.isError}
                 className="order-3"
              />
                </>
              )}
                <div className="order-1 rounded-2xl border border-border bg-card shadow-sm flex flex-col lg:col-span-2">
                <div className="border-b border-border px-6 py-5 flex items-center justify-between bg-muted/20">
                  <div className="flex items-center gap-2 font-bold text-foreground">
                    <TrendingDown className="h-5 w-5 text-warning" /> Predicted Reductions
                  </div>
                </div>
                <div className="p-0">
                  {predictedReductions.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> :
                   !predictedReductions.data?.length ? (
                     <div className="p-8 text-center text-sm font-medium text-muted-foreground">No upcoming price reductions predicted.</div>
                   ) : (
                     <div className="divide-y divide-border">
                       {predictedReductions.data.map(pred => (
                         <div key={pred.id} className="p-5">
                           <div className="flex justify-between items-start mb-2">
                             <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{dateStr(pred.predictedDate)}</span>
                               <span className="rounded bg-info/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-info">{pred.subjectToMinisterialDiscretion ? 'Subject to Ministerial discretion' : pred.confidence === 'indicative' ? 'Indicative PBS report' : `${pred.confidence} confidence`}</span>
                           </div>
                           <div className="flex items-baseline gap-2 mb-2">
                              <span className={`text-2xl font-bold tracking-tight ${reductionTextClass(pred.significance)}`}>-{pred.predictedPercentage}%</span>
                             <span className="text-sm font-medium text-muted-foreground line-through">{money(item.currentAemp)}</span>
                             <ArrowRight className="h-3 w-3 text-muted-foreground mx-1" />
                             <span className="text-lg font-mono font-bold text-warning">{money(pred.predictedNewPrice)}</span>
                           </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{pred.sourceNote}</p>
                         </div>
                       ))}
                     </div>
                   )}
                </div>
              </div>

                <div className="order-4 rounded-2xl border border-border bg-card shadow-sm flex flex-col lg:col-span-2">
                <div className="border-b border-border px-6 py-5 flex items-center justify-between bg-muted/20">
                  <div className="flex items-center gap-2 font-bold text-foreground">
                    <History className="h-5 w-5 text-info" /> Schedule Changes
                  </div>
                </div>
                <div className="p-0 flex-1 overflow-auto max-h-[300px]">
                  {scheduleChanges.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> :
                   !scheduleChanges.data?.length ? (
                     <div className="p-8 text-center text-sm font-medium text-muted-foreground">No recent schedule changes.</div>
                   ) : (
                     <div className="divide-y divide-border">
                       {scheduleChanges.data.map(change => (
                         <div key={change.id} className="p-5 text-sm">
                           <div className="flex items-center justify-between mb-1.5">
                             <span className="font-mono text-[10px] font-bold text-muted-foreground">{dateStr(change.effectiveDate)}</span>
                              <span className={`rounded px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${change.significance === 'high' ? 'bg-destructive/10 text-destructive' : change.significance === 'medium' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'}`}>{change.significance}</span>
                           </div>
                           <div className="font-bold text-foreground mb-1 capitalize">{change.changeType.replace('_', ' ')}</div>
                           {change.notes && <p className="text-xs text-muted-foreground leading-relaxed">{change.notes}</p>}
                         </div>
                       ))}
                     </div>
                   )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
