import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getListUpcomingPredictedReductionsQueryKey,
  type UpcomingPredictedBrandReductionGroup,
  type UpcomingPredictedReductionGroup,
  useListUpcomingPredictedReductions,
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { CalendarDays, ChevronDown, Filter, Layers3 } from 'lucide-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { reductionBadgeClass, reductionBorderClass, reductionTextClass } from '@/lib/percentage-significance';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const percentage = (value: number) => `${Math.abs(value).toFixed(1).replace(/\.0$/, '')}%`;
type ConfidenceFilter = '' | 'high' | 'conditional' | 'indicative' | 'confirmed';

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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
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
  const listingTotal = predictions.data?.reduce((total, event) => total + event.listingCount, 0) ?? 0;

  return (
    <AppShell>
      <PageHeading
        eyebrow="PBS price intelligence"
        title="Upcoming changes"
        description="Predicted PBS reductions grouped by exact price change. Expand a change to inspect the brands and listings taking it."
      />
      <div className="mb-6 grid gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm md:grid-cols-[1fr_1fr_220px]">
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span>From</span>
          <input value={from} onChange={(event) => setFrom(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-from" />
        </label>
        <label className="flex h-11 items-center gap-2 rounded-xl bg-muted/55 px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span>To</span>
          <input value={to} onChange={(event) => setTo(event.target.value)} type="date" className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-upcoming-to" />
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
       !predictions.data?.length ? <QueryState kind="empty" /> : (
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" data-testid="table-upcoming-changes">
          <div className="flex items-center justify-between border-b border-border bg-muted/25 px-5 py-3">
            <span className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground"><Layers3 className="h-3.5 w-3.5 text-info" /> Reduction events</span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{predictions.data.length} events · {listingTotal} listings</span>
          </div>
          <div className="divide-y divide-border">
            {predictions.data.map((event) => {
              const eventKey = `${event.drugId}:${event.predictedDate}:${event.currentPrice}:${event.predictedNewPrice}`;
              const expanded = openEvents.includes(eventKey);
              const singleBrand = event.brandCount === 1;
              const singleBrandLabel = [event.brands[0]?.brandName, event.brands[0]?.strength].filter(Boolean).join(' ');
              return (
                <article key={eventKey} className={`border-l-4 ${reductionBorderClass(event.significance)}`} data-testid={`upcoming-event-${eventKey}`}>
                  <button type="button" onClick={() => toggleKey(setOpenEvents, eventKey)} aria-expanded={expanded} className="grid w-full gap-2 px-5 py-4 text-left transition-colors hover:bg-secondary/25 md:grid-cols-[1.25fr_.85fr_1fr_1fr_auto] md:items-center md:gap-4">
                    <div><p className="text-base font-bold text-foreground">{event.drugName}</p><p className="mt-0.5 text-xs font-semibold text-muted-foreground">{changeLabel(event)} · {singleBrand ? `${singleBrandLabel || '1 brand'} · ` : `${event.brandCount} brands · `}{event.listingCount} listing{event.listingCount === 1 ? '' : 's'}</p></div>
                    <span className="font-mono text-xs font-bold text-foreground">{date(event.predictedDate)}</span>
                    <span className={`text-xs font-semibold ${reductionTextClass(event.significance)}`}>{singleBrand ? 'Single-brand change' : 'Shared price change'}</span>
                    <span className={`justify-self-start rounded-md px-2 py-1 font-mono text-[10px] font-bold uppercase ${reductionBadgeClass(event.significance)}`}>{event.significance}</span>
                    <ChevronDown className={`justify-self-end text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded && (
                    <div className="border-t border-border bg-muted/15 px-3 py-3 md:px-5">
                       <div className="space-y-2">
                         {event.brands.map((brand) => {
                           const brandKey = `${eventKey}:${brand.brandName}`;
                          const brandExpanded = openBrands.includes(brandKey);
                           if (singleBrand) {
                             return (
                               <div key={brandKey} className="overflow-hidden rounded-xl border border-border bg-card">
                                 <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                                   <div><p className="text-sm font-bold text-foreground">{brand.brandName}</p><p className="text-xs font-medium text-muted-foreground">{brand.strength ?? 'Multiple strengths'} · {brand.listingCount} listing{brand.listingCount === 1 ? '' : 's'}</p></div>
                                   <span className={`font-mono text-sm font-bold ${reductionTextClass(brand.significance)}`}>{changeLabel(event)}</span>
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
                                <span className="justify-self-start rounded bg-info/10 px-2 py-1 text-[10px] font-bold capitalize text-info">{brand.confidence}</span>
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