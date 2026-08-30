import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getListUpcomingPredictedReductionsQueryKey,
  type UpcomingPredictedBrandReductionGroup,
  type UpcomingPredictedReductionGroup,
  useListUpcomingPredictedReductions,
} from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { CalendarDays, ChevronDown, Filter, Info, Layers3 } from 'lucide-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { reductionBorderClass, reductionTextClass } from '@/lib/percentage-significance';
import { neutralBadgeClass } from '@/lib/status-styles';
import { drugDisplayName } from '@/lib/drug-label';
import { formatDateValue } from '@/lib/date-format';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string | null | undefined) => formatDateValue(value, { day: 'numeric', month: 'short', year: 'numeric' });
const percentage = (value: number) => `${Math.abs(value).toFixed(1).replace(/\.0$/, '')}%`;
type ConfidenceFilter = '' | 'high' | 'conditional' | 'indicative' | 'confirmed';

function localDateOnly(dateValue: Date): string {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalMonths(dateValue: Date, months: number): string {
  const result = new Date(dateValue.getFullYear(), dateValue.getMonth() + months, dateValue.getDate());
  return localDateOnly(result);
}

function predictionReductionAmount(event: UpcomingPredictedReductionGroup): number {
  return Math.max(0, event.currentPrice - event.predictedNewPrice);
}

function signedPercentage(value: number) {
  return `${value < 0 ? '-' : ''}${percentage(value)}`;
}

function toggleKey(setter: Dispatch<SetStateAction<string[]>>, key: string) {
  setter((open) => open.includes(key) ? open.filter((value) => value !== key) : [...open, key]);
}

function changeLabel(event: UpcomingPredictedReductionGroup) {
  return `${money(event.currentPrice)} → ${money(event.predictedNewPrice)} (${signedPercentage(event.predictedPercentage)})`;
}

function ListingRows({ brand }: { brand: UpcomingPredictedBrandReductionGroup }) {
  return (
    <div className="divide-y divide-border border-t border-border bg-muted/20">
      {brand.listings.map((listing) => (
        <Link key={listing.itemCode} href={`/pbs/${encodeURIComponent(listing.itemCode)}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-secondary/30">
          <span className="min-w-0 truncate font-medium text-foreground">{listing.strength ?? 'Strength not supplied'} <span className="font-mono font-bold">· PBS {listing.pbsCode ?? listing.itemCode}</span></span>
          <span className="shrink-0 font-mono text-[10px] font-medium text-muted-foreground">{listing.itemCode}</span>
        </Link>
      ))}
    </div>
  );
}

export function UpcomingChangesPage() {
  const [location] = useLocation();
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), [location]);
  const [from, setFrom] = useState(() => initialParams.get('from') ?? '');
  const [to, setTo] = useState(() => initialParams.get('to') ?? '');
  const [year, setYear] = useState(() => initialParams.get('year') ?? '');
  const [confidence, setConfidence] = useState<ConfidenceFilter>('');
  const [openEvents, setOpenEvents] = useState<string[]>([]);
  const [openBrands, setOpenBrands] = useState<string[]>([]);
  const params = useMemo(
    () => ({ from: from || undefined, to: to || undefined, confidence: confidence || undefined }),
    [from, to, confidence],
  );
  const predictions = useListUpcomingPredictedReductions(params, {
    query: { queryKey: getListUpcomingPredictedReductionsQueryKey(params) },
  });
  const yearOptions = useMemo(
    () => [...new Set((predictions.data ?? []).map((event) => event.predictedDate.slice(0, 4)))]
      .filter((value) => /^\d{4}$/.test(value))
      .sort(),
    [predictions.data],
  );
  const visiblePredictions = useMemo(() => {
    const today = new Date();
    const nearTermCutoff = addLocalMonths(today, 12);
    return [...(predictions.data ?? [])]
      .filter((event) => !year || event.predictedDate.slice(0, 4) === year)
      .sort((left, right) => {
        const leftNearTerm = left.predictedDate <= nearTermCutoff;
        const rightNearTerm = right.predictedDate <= nearTermCutoff;
        if (leftNearTerm !== rightNearTerm) return leftNearTerm ? -1 : 1;
        if (leftNearTerm) {
          const amountOrder = predictionReductionAmount(right) - predictionReductionAmount(left);
          if (amountOrder !== 0) return amountOrder;
        }
        return left.predictedDate.localeCompare(right.predictedDate)
          || predictionReductionAmount(right) - predictionReductionAmount(left)
          || left.drugName.localeCompare(right.drugName);
      });
  }, [predictions.data, year]);
  const listingTotal = visiblePredictions.reduce((total, event) => total + event.listingCount, 0);

  return (
    <AppShell>
      <PageHeading
        eyebrow="PBS price intelligence"
        title="Upcoming changes"
        description="Predicted PBS reductions grouped by exact price change. Expand a change to inspect the brands and listings taking it."
      />
        <div className="mb-6 grid gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm md:grid-cols-[1fr_1fr_180px_220px]">
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span>From</span>
          <input value={from} onChange={(event) => setFrom(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-from" />
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span>To</span>
          <input value={to} onChange={(event) => setTo(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-to" />
        </label>
          <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm font-semibold">
            <CalendarDays className="h-4 w-4 text-info" />
            <select value={year} onChange={(event) => setYear(event.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" data-testid="select-upcoming-year">
              <option value="">All years</option>
              {yearOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm font-semibold">
          <Filter className="h-4 w-4 text-info" />
          <select value={confidence} onChange={(event) => setConfidence(event.target.value as ConfidenceFilter)} className="min-w-0 flex-1 bg-transparent outline-none" data-testid="select-upcoming-confidence">
            <option value="">All confidence levels</option><option value="high">High confidence</option><option value="confirmed">Confirmed</option><option value="conditional">Conditional</option><option value="indicative">Indicative</option>
          </select>
        </label>
      </div>
      {predictions.isLoading ? <QueryState kind="loading" /> :
       predictions.isError ? <QueryState kind="error" onRetry={() => predictions.refetch()} /> :
        !visiblePredictions.length ? <QueryState kind="empty" /> : (
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" data-testid="table-upcoming-changes">
          <div className="flex items-center justify-between border-b border-border bg-muted/25 px-5 py-3">
            <span className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground"><Layers3 className="h-3.5 w-3.5 text-info" /> Reduction events</span>
             <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{visiblePredictions.length} events · {listingTotal} listings</span>
          </div>
           <div className="flex items-center gap-2 border-b border-border bg-background px-5 py-2.5 text-xs text-muted-foreground">
             <Info className="h-3.5 w-3.5 shrink-0 text-info" />
             <span><strong className="text-foreground">Confidence</strong> describes how well-supported the prediction is, not the size of the reduction.</span>
           </div>
          <div className="divide-y divide-border">
             {visiblePredictions.map((event) => {
              const eventKey = `${event.drugId}:${event.predictedDate}:${event.currentPrice}:${event.predictedNewPrice}`;
              const expanded = openEvents.includes(eventKey);
              const singleBrand = event.brandCount === 1;
              const singleBrandLabel = [event.brands[0]?.brandName, event.brands[0]?.strength].filter(Boolean).join(' ');
              return (
                <article key={eventKey} className={`border-l-4 ${reductionBorderClass(event.significance)}`} data-testid={`upcoming-event-${eventKey}`}>
                  <button type="button" onClick={() => toggleKey(setOpenEvents, eventKey)} aria-expanded={expanded} className="grid w-full gap-2 px-5 py-4 text-left transition-colors hover:bg-secondary/25 md:grid-cols-[1.25fr_.85fr_1fr_1fr_auto] md:items-center md:gap-4">
                    <div><p className="text-base font-bold text-foreground">{drugDisplayName(event.drugName, event.originatorBrandName)}</p><p className="mt-0.5 text-xs font-semibold text-muted-foreground">{changeLabel(event)} · {singleBrand ? `${singleBrandLabel || '1 brand'} · ` : `${event.brandCount} brands · `}{event.listingCount} listing{event.listingCount === 1 ? '' : 's'}</p></div>
                    <span className="font-mono text-xs font-bold text-foreground">{date(event.predictedDate)}</span>
                    <span className={`text-xs font-semibold ${reductionTextClass(event.significance)}`}>{singleBrand ? 'Single-brand change' : 'Shared price change'}</span>
                    <span className={`justify-self-start rounded-md px-2 py-1 font-mono text-[10px] font-bold uppercase ${neutralBadgeClass}`}>{event.significance}</span>
                    <ChevronDown className={`justify-self-end text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded && (
                    <div className="border-t border-border bg-muted/15 px-3 py-3 md:px-5">
                       <div className="mb-2 flex items-center justify-between gap-3 px-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">
                         <span>Brands and listings</span>
                         <span className="flex items-center gap-1" title="Confidence in the prediction, not the size of the reduction">
                           <Info className="h-3 w-3 text-info" /> Confidence
                         </span>
                       </div>
                       <div className="space-y-2">
                         {event.brands.map((brand) => {
                           const brandKey = `${eventKey}:${brand.brandName}`;
                          const brandExpanded = openBrands.includes(brandKey);
                           if (singleBrand) {
                             return (
                               <div key={brandKey} className="overflow-hidden rounded-xl border border-border bg-card">
                                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                                   <div><p className="text-sm font-bold text-foreground">{brand.brandName}</p><p className="text-xs font-medium text-muted-foreground">{brand.strength ?? 'Multiple strengths'} · {brand.listingCount} listing{brand.listingCount === 1 ? '' : 's'}</p></div>
                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                      <span className={`font-mono text-sm font-bold ${reductionTextClass(brand.significance)}`}>{changeLabel(event)}</span>
                                      <span className={`rounded px-2 py-1 text-[10px] font-bold capitalize ${neutralBadgeClass}`} title="Confidence in the prediction, not the size of the reduction">{brand.confidence}</span>
                                    </div>
                                 </div>
                                 <ListingRows brand={brand} />
                               </div>
                             );
                           }
                          return (
                            <div key={brandKey} className="overflow-hidden rounded-xl border border-border bg-card">
                               <button type="button" onClick={() => toggleKey(setOpenBrands, brandKey)} aria-expanded={brandExpanded} className="grid w-full gap-2 px-4 py-3 text-left hover:bg-secondary/20 md:grid-cols-[1.2fr_.75fr_1fr_.7fr_auto] md:items-center md:gap-4">
                                 <div><p className="text-sm font-bold text-foreground">{brand.brandName}</p><p className="text-xs font-medium text-muted-foreground">{brand.strength ?? 'Multiple strengths'} · {brand.listingCount} listing{brand.listingCount === 1 ? '' : 's'}</p></div>
                                <span className="font-mono text-xs font-bold text-foreground">{money(brand.currentPrice)} <span className={reductionTextClass(brand.significance)}>→ {money(brand.predictedNewPrice)}</span></span>
                                <span className={`font-mono text-sm font-bold ${reductionTextClass(brand.significance)}`}>−{percentage(brand.predictedPercentage)}</span>
                                <span className={`justify-self-start rounded px-2 py-1 text-[10px] font-bold capitalize ${neutralBadgeClass}`}>{brand.confidence}</span>
                                <ChevronDown className={`justify-self-end text-muted-foreground transition-transform ${brandExpanded ? 'rotate-180' : ''}`} />
                              </button>
                              {brandExpanded && (
                                 <ListingRows brand={brand} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </AppShell>
  );
}