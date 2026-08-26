import { useMemo, useState } from 'react';
import {
  type ScheduleChange,
  type ListScheduleChangesChangeType,
  type ListScheduleChangesSignificance,
  useListScheduleChanges,
  useGetDrugScheduleTimeline,
  useListDrugs,
  getListScheduleChangesQueryKey,
  getGetDrugScheduleTimelineQueryKey
} from '@workspace/api-client-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { Filter, X, History, ArrowRight, AlertCircle, AlertTriangle, Activity } from 'lucide-react';

const money = (value: unknown) => {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
};

const date = (value: string) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
};

const typeLabels: Record<string, string> = {
  new_item: 'New item',
  new_brand: 'New brand',
  delisted: 'Delisted',
  price_change: 'Price update',
  formulary_change: 'Formulary change'
};

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function ChangeDetails({ change }: { change: ScheduleChange }) {
  if (change.changeType === 'price_change') {
    const oldVal = change.oldValue as Record<string, number> | null;
    const newVal = change.newValue as Record<string, number> | null;
    const oldPrice = oldVal?.determined_price;
    const newPrice = newVal?.determined_price;
    const percentage = newVal?.percentage_change;
    return (
      <span className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className="text-muted-foreground line-through opacity-70">{money(oldPrice)}</span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-bold text-foreground">{money(newPrice)}</span>
        {typeof percentage === 'number' && <span className="text-[11px] font-bold text-destructive">{percentage.toFixed(2)}%</span>}
      </span>
    );
  }
  if (change.changeType === 'delisted') {
    const previous = objectValue(change.oldValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-destructive">Removed</span>
        {textValue(previous.brand_name) && <span>{textValue(previous.brand_name)}</span>}
        {typeof previous.determined_price === 'number' && <span className="font-mono">{money(previous.determined_price)}</span>}
        {textValue(previous.formulary) && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{textValue(previous.formulary)}</span>}
        {textValue(previous.pbs_code) && <span className="font-mono text-[10px] text-muted-foreground">{textValue(previous.pbs_code)}</span>}
      </span>
    );
  }
  if (change.changeType === 'new_item') {
    const added = objectValue(change.newValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-chart-3">Added</span>
        {textValue(added.brand_name) && <span>{textValue(added.brand_name)}</span>}
        {typeof added.determined_price === 'number' && <span className="font-mono">{money(added.determined_price)}</span>}
        {textValue(added.formulary) && <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{textValue(added.formulary)}</span>}
        {textValue(added.pbs_code) && <span className="font-mono text-[10px] text-muted-foreground">{textValue(added.pbs_code)}</span>}
      </span>
    );
  }
  if (change.changeType === 'new_brand') {
    const added = objectValue(change.newValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-chart-3">Brand added</span>
        {textValue(added.brand_name) && <span>{textValue(added.brand_name)}</span>}
        {textValue(added.li_item_id) && <span className="font-mono text-[10px] text-muted-foreground">{textValue(added.li_item_id)}</span>}
      </span>
    );
  }
  if (change.changeType === 'formulary_change') {
    const oldVal = change.oldValue as Record<string, string> | null;
    const newVal = change.newValue as Record<string, string> | null;
    return (
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{oldVal?.formulary || '—'}</span> 
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /> 
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{newVal?.formulary || '—'}</span>
      </span>
    );
  }
  return <span className="text-sm text-muted-foreground">—</span>;
}

export function ChangesPage() {
  const [drugId, setDrugId] = useState<number | ''>('');
  const [changeType, setChangeType] = useState<ListScheduleChangesChangeType | ''>('');
  const [significance, setSignificance] = useState<ListScheduleChangesSignificance | ''>('');
  
  const [timelineDrugId, setTimelineDrugId] = useState<number | null>(null);
  const [timelineDrugName, setTimelineDrugName] = useState<string>('');

  const params = useMemo(() => ({
    drugId: drugId || undefined,
    changeType: changeType || undefined,
    significance: significance || undefined,
    limit: 100
  }), [drugId, changeType, significance]);

  const query = useListScheduleChanges(params, {
    query: { queryKey: getListScheduleChangesQueryKey(params) }
  });

  const drugIndex = useListDrugs({ limit: 100 });
  
  const timeline = useGetDrugScheduleTimeline(timelineDrugId!, {
    query: {
      enabled: timelineDrugId !== null,
      queryKey: timelineDrugId ? getGetDrugScheduleTimelineQueryKey(timelineDrugId) : ['timeline-noop']
    }
  });

  const changes = query.data ?? [];

  return (
    <AppShell>
      <PageHeading 
        eyebrow="Alert desk / Schedule" 
        title="PBS updates" 
        description="Monitor schedule movements, pricing changes, and delistings across the PBS network." 
      />
      
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-xs sm:flex-row">
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <select 
            value={drugId} 
            onChange={(e) => setDrugId(e.target.value ? Number(e.target.value) : '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-drug"
          >
            <option value="">All medicines</option>
            {drugIndex.data?.map(drug => (
              <option key={drug.id} value={drug.id}>{drug.name}</option>
            ))}
          </select>
        </label>
        
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20">
          <Filter className="h-4 w-4 text-primary" />
          <select 
            value={changeType} 
            onChange={(e) => setChangeType(e.target.value as ListScheduleChangesChangeType | '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-type"
          >
            <option value="">All change types</option>
            <option value="new_item">New items</option>
            <option value="new_brand">New brands</option>
            <option value="delisted">Delisted</option>
            <option value="price_change">Price changes</option>
            <option value="formulary_change">Formulary changes</option>
          </select>
        </label>
        
        <label className="flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm focus-within:border-destructive focus-within:ring-1 focus-within:ring-destructive/20">
          <AlertTriangle className={`h-4 w-4 ${significance === 'high' ? 'text-destructive' : 'text-muted-foreground'}`} />
          <select 
            value={significance} 
            onChange={(e) => setSignificance(e.target.value as ListScheduleChangesSignificance | '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-significance"
          >
            <option value="">All impact levels</option>
            <option value="high">High impact</option>
            <option value="normal">Normal impact</option>
          </select>
        </label>
      </div>

      {query.isLoading ? (
        <QueryState kind="loading" />
      ) : query.isError ? (
        <QueryState kind="error" onRetry={() => query.refetch()} />
      ) : changes.length === 0 ? (
        <QueryState kind="empty" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
          <div className="hidden grid-cols-[.7fr_1.5fr_1fr_1fr_.5fr] gap-4 border-b border-border bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid">
            <span>Date</span>
            <span>Medicine</span>
            <span>Event</span>
            <span>Details</span>
            <span />
          </div>
          <div className="divide-y divide-border">
            {changes.map((change) => (
              <div 
                key={change.id} 
                className={`grid gap-3 px-5 py-4 transition-colors hover:bg-secondary/30 md:grid-cols-[.7fr_1.5fr_1fr_1fr_.5fr] md:items-center md:gap-4 ${change.significance === 'high' ? 'bg-destructive/5' : ''}`} 
                data-testid={`row-change-${change.id}`}
              >
                <div>
                  <p className="font-mono text-sm font-bold">{date(change.effectiveDate)}</p>
                  {change.scheduleCode && <p className="mt-0.5 font-mono text-[10px] font-bold text-muted-foreground">SCH {change.scheduleCode}</p>}
                </div>
                <div>
                  <p className="text-sm font-bold leading-tight">{change.brandName || change.drugName}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary">{change.pbsCode || change.liItemId}</span>
                    {change.brandName && <span className="truncate text-[11px] font-semibold text-muted-foreground">{change.drugName}</span>}
                  </div>
                </div>
                <div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                    change.significance === 'high' ? 'bg-destructive text-destructive-foreground' : 
                    change.changeType.startsWith('new_') ? 'bg-chart-3/15 text-chart-3' :
                    change.changeType === 'delisted' ? 'border border-destructive/30 text-destructive' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {change.significance === 'high' && <AlertCircle className="h-3 w-3" />}
                    {typeLabels[change.changeType] || change.changeType}
                  </span>
                </div>
                <div>
                  <ChangeDetails change={change} />
                </div>
                <div className="flex md:justify-end">
                  <button 
                    type="button" 
                    onClick={() => { setTimelineDrugId(change.drugId); setTimelineDrugName(change.drugName); }} 
                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-primary hover:bg-primary/10"
                    data-testid={`button-timeline-${change.id}`}
                  >
                    <History className="h-3.5 w-3.5" />
                    <span className="hidden lg:inline">Timeline</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {timelineDrugId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-sidebar/35 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" data-testid="dialog-timeline">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => setTimelineDrugId(null)} aria-label="Close timeline" data-testid="button-close-timeline-backdrop" />
          <div className="relative flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl sm:rounded-3xl">
            <div className="flex shrink-0 items-start justify-between border-b border-border bg-muted/20 px-6 py-5">
              <div className="pr-8">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-primary">Schedule Timeline</span>
                <h2 className="mt-1.5 text-2xl font-bold tracking-[-0.04em]">{timelineDrugName}</h2>
              </div>
              <button type="button" onClick={() => setTimelineDrugId(null)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close" data-testid="button-close-timeline-modal">
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="flex-1 overflow-auto p-6">
              {timeline.isLoading ? (
                <div className="py-12"><QueryState kind="loading" /></div>
              ) : timeline.isError || !timeline.data ? (
                <div className="py-12"><QueryState kind="error" onRetry={() => timeline.refetch()} /></div>
              ) : timeline.data.length === 0 ? (
                <p className="py-12 text-center text-sm font-semibold text-muted-foreground">No historical changes found for this medicine.</p>
              ) : (
                <div className="relative ml-4 space-y-8 border-l-2 border-border/60 pb-6 pt-2">
                  {timeline.data.map((change) => (
                    <div key={change.id} className="relative pl-7" data-testid={`timeline-item-${change.id}`}>
                      <span className={`absolute -left-[9px] top-1.5 h-4 w-4 rounded-full border-4 border-card ${
                        change.significance === 'high' ? 'bg-destructive' : 
                        change.changeType.startsWith('new_') ? 'bg-chart-3' :
                        change.changeType === 'delisted' ? 'bg-muted-foreground' :
                        'bg-primary'
                      }`} />
                      
                      <div className="mb-2 flex items-baseline justify-between gap-4">
                        <p className="font-mono text-sm font-bold text-foreground">{date(change.effectiveDate)}</p>
                        {change.significance === 'high' && (
                          <span className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-destructive">
                            <AlertCircle className="h-3 w-3" /> High impact
                          </span>
                        )}
                      </div>
                      
                      <div className="rounded-2xl border border-border bg-card p-5 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <span className="font-bold text-foreground">{typeLabels[change.changeType] || change.changeType}</span>
                          {(change.brandName || change.pbsCode) && (
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                              {change.pbsCode && <span className="rounded bg-muted px-1 font-mono text-[10px]">{change.pbsCode}</span>}
                              {change.brandName}
                            </span>
                          )}
                        </div>
                        
                        <div className="mt-4 flex items-center gap-4 rounded-xl bg-muted/40 p-3">
                          <ChangeDetails change={change} />
                        </div>
                        
                        {change.notes && (
                          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{change.notes}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
