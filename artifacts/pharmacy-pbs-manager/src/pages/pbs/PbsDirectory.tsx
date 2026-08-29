import { useState, useMemo } from 'react';
import { 
  useListMedicineDirectory, getListMedicineDirectoryQueryKey,
  useListMedicineBrands, getListMedicineBrandsQueryKey,
  useListMedicineBrandItems, getListMedicineBrandItemsQueryKey,
  type MedicineDrugSummary, type MedicineBrandSummary, type MedicineBrandItemSummary
} from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { reductionTextClass } from '@/lib/percentage-significance';
import { drugDisplayName } from '@/lib/drug-label';
import { Search, ChevronDown, ChevronRight, ArrowLeft, Pill, Building2, Tag } from 'lucide-react';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
const shortDate = (value: string) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const normalise = (value: string) => value.trim().toLocaleLowerCase();
const priceLabel = (minimum: number, maximum: number) => minimum === maximum
  ? money(minimum)
  : <>{money(minimum)} <span className="opacity-40">-</span> {money(maximum)}</>;
const reductionTypeLabel = (value: string) => {
  const label = value.replace(/^\d+-year\s+/i, '').replaceAll('_', ' ');
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
};
const reductionPercentageLabel = (value: number) => `-${Math.abs(value).toFixed(1).replace(/\.0$/, '')}%`;
const benefitTypeLabel = (code: string | null) =>
  ({ U: 'Unrestricted', R: 'Restricted', A: 'Authority required', S: 'Authority streamlined' } as Record<string, string>)[code ?? '']
  ?? 'Not supplied';

function PriceForecast({
  currentPrice,
  predictedPrice,
  predictedDate,
  confidence,
  significance,
  predictedPercentage,
}: {
  currentPrice: number;
  predictedPrice: number;
  predictedDate: string;
  confidence?: string;
  significance?: string | null;
  predictedPercentage?: number | null;
}) {
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 font-mono text-xs font-bold text-foreground">
      <span>{money(currentPrice)}</span>
      <span className={reductionTextClass(significance)}>→</span>
      <span className={reductionTextClass(significance)}>{money(predictedPrice)}</span>
      <span className="font-sans text-[10px] font-semibold text-muted-foreground">on {shortDate(predictedDate)}</span>
       {predictedPercentage !== null && predictedPercentage !== undefined && (
         <span className={`font-sans text-[10px] font-bold ${reductionTextClass(significance)}`}>
           {reductionPercentageLabel(predictedPercentage)}
         </span>
       )}
       {confidence && <span className="font-sans text-[10px] font-semibold capitalize text-info">{confidence}</span>}
    </span>
  );
}

type Tier = 
  | { level: 'drugs' }
  | { level: 'brands', drug: MedicineDrugSummary }
  | { level: 'items', drugId: number, drugName: string, originatorBrandName: string | null, brand: MedicineBrandSummary | { brandName: string } };

export function PbsDirectory() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState<Tier>({ level: 'drugs' });
  const [expandedStrengths, setExpandedStrengths] = useState<string[]>([]);

  const drugParams = useMemo(() => ({ search: search || undefined }), [search]);
  const drugsQuery = useListMedicineDirectory(drugParams, {
    query: { enabled: tier.level === 'drugs', queryKey: getListMedicineDirectoryQueryKey(drugParams) }
  });

  const activeDrugId = tier.level === 'brands' ? tier.drug.drugId : tier.level === 'items' ? tier.drugId : 0;
  const brandsQuery = useListMedicineBrands(activeDrugId, {
    query: { enabled: tier.level === 'brands', queryKey: getListMedicineBrandsQueryKey(activeDrugId) }
  });

  const activeBrandName = tier.level === 'items' ? tier.brand.brandName : '';
  const itemsQuery = useListMedicineBrandItems(activeDrugId, activeBrandName, {
    query: { enabled: tier.level === 'items', queryKey: getListMedicineBrandItemsQueryKey(activeDrugId, activeBrandName) }
  });

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (tier.level !== 'drugs') setTier({ level: 'drugs' });
  };

  const clickDrug = (drug: MedicineDrugSummary) => {
    if (drug.searchMatchLevel === 'item' && drug.matchedItemCode) {
      setLocation(`/pbs/${drug.matchedItemCode}`);
    } else if (drug.searchMatchLevel === 'brand' && drug.matchedBrandName) {
      setTier({ level: 'items', drugId: drug.drugId, drugName: drug.drugName, originatorBrandName: drug.originatorBrandName, brand: { brandName: drug.matchedBrandName } });
    } else {
      setTier({ level: 'brands', drug });
    }
  };

  const clickBrand = (brand: MedicineBrandSummary, drugName: string, originatorBrandName: string | null) => {
    setTier({ level: 'items', drugId: brand.drugId, drugName, originatorBrandName, brand });
  };

  return (
    <AppShell>
      {tier.level === 'drugs' ? (
        <PageHeading eyebrow="Reference library / PBS" title="PBS directory" description="Precise medicine intelligence. Search by drug, brand, ingredient, or code." />
      ) : (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-info" /> Reference library / PBS
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.045em] text-foreground">PBS directory</h1>
        </div>
      )}
      
      <div className={`flex flex-col rounded-2xl border border-border bg-card shadow-sm sm:flex-row ${tier.level === 'drugs' ? 'mb-6 gap-3 p-3' : 'mb-3 p-1.5'}`}>
        <label className={`flex flex-1 items-center rounded-xl bg-muted/50 px-4 text-muted-foreground transition-all focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/20 ${tier.level === 'drugs' ? 'min-h-12 gap-3' : 'min-h-9 gap-2'}`}>
          <Search className={tier.level === 'drugs' ? 'h-5 w-5 shrink-0' : 'h-4 w-4 shrink-0'} />
          <input 
            value={search} 
            onChange={(e) => handleSearchChange(e.target.value)} 
            className="w-full bg-transparent text-[15px] font-medium text-foreground outline-none placeholder:text-muted-foreground/70" 
            placeholder="Search ingredient, brand name, or PBS code..." 
            data-testid="input-pbs-search" 
          />
        </label>
      </div>

      {tier.level !== 'drugs' && (
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground animate-rise-in">
          <button 
            onClick={() => setTier({ level: 'drugs' })} 
            className="hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" /> Directory
          </button>
          <ChevronRight className="h-4 w-4 opacity-50" />
          {tier.level === 'items' ? (
            <>
              <button 
                onClick={() => setTier({ level: 'brands', drug: { drugId: tier.drugId, drugName: tier.drugName, originatorBrandName: tier.originatorBrandName } as MedicineDrugSummary })}
                className="hover:text-foreground transition-colors"
              >
                 {drugDisplayName(tier.drugName, tier.originatorBrandName)}
              </button>
              <ChevronRight className="h-4 w-4 opacity-50" />
              <span className="text-foreground">{tier.brand.brandName}</span>
            </>
          ) : (
             <span className="text-foreground">{drugDisplayName(tier.drug.drugName, tier.drug.originatorBrandName)}</span>
          )}
        </div>
      )}

       <div className={`overflow-hidden rounded-2xl border border-border bg-card shadow-sm ${tier.level === 'drugs' ? 'min-h-[400px]' : ''}`}>
        {tier.level === 'drugs' && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex justify-between border-b border-border bg-muted/30 px-6 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              <span>Medicines & Matches</span>
              <span>{drugsQuery.data?.length || 0} results</span>
            </div>
            {drugsQuery.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> : 
             drugsQuery.isError ? <div className="p-6"><QueryState kind="error" onRetry={() => drugsQuery.refetch()} /></div> : 
             !drugsQuery.data?.length ? <div className="p-6"><QueryState kind="empty" /></div> : (
              <div className="divide-y divide-border">
                {drugsQuery.data.map(drug => {
                  const isBrand = drug.searchMatchLevel === 'brand';
                  const isItem = drug.searchMatchLevel === 'item';
                  const ingredientDiffers = normalise(drug.activeIngredient) !== normalise(drug.drugName);
                   const displayDrugName = drugDisplayName(drug.drugName, drug.originatorBrandName);
                   const secondaryLabel = isBrand || isItem
                    ? ingredientDiffers
                       ? <>{displayDrugName} <span className="mx-1.5 opacity-50">•</span> {drug.activeIngredient}</>
                       : displayDrugName
                    : ingredientDiffers
                      ? drug.activeIngredient
                      : null;
                  
                  return (
                    <button 
                      key={drug.drugId} 
                      onClick={() => clickDrug(drug)} 
                      className="w-full grid gap-2 px-6 py-5 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[1fr_auto] md:items-center"
                    >
                      <div>
                        {isItem ? (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-info">
                            <Tag className="h-3 w-3" /> Item Match • {drug.matchedItemCode}
                          </div>
                        ) : isBrand ? (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-info">
                            <Building2 className="h-3 w-3" /> Brand Match
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                            <Pill className="h-3 w-3" /> Drug / Ingredient
                          </div>
                        )}
                        
                        <div className="text-lg font-bold tracking-tight">
                          {isItem ? (drug.matchedBrandName || displayDrugName) : isBrand ? drug.matchedBrandName : displayDrugName}
                        </div>
                         {secondaryLabel && (
                           <div className="mt-1 text-sm font-medium text-muted-foreground">
                             {secondaryLabel}
                           </div>
                         )}
                         <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                           <span>{drug.brandCount} brand{drug.brandCount === 1 ? '' : 's'}</span>
                          <span>•</span>
                          <span>{drug.itemCount} items</span>
                          <span>•</span>
                          <span>{drug.formulary}</span>
                           {drug.nextPredictedReductionDate && drug.nextPredictedReductionType && drug.nextPredictedReductionPercentage !== null && (
                            <>
                              <span>•</span>
                                <span className="font-semibold normal-case tracking-normal text-muted-foreground">
                                   {drug.nextPredictedReductionConfidence === 'indicative' ? 'Indicative price disclosure' : reductionTypeLabel(drug.nextPredictedReductionType)} {shortDate(drug.nextPredictedReductionDate)}, <span className={reductionTextClass(drug.nextPredictedReductionSignificance)}>{reductionPercentageLabel(drug.nextPredictedReductionPercentage)}</span>
                               </span>
                            </>
                          )}
                            {drug.subjectToPriceDisclosure && drug.priceDisclosureCycles.length > 0 && (
                              <span
                                className="rounded bg-info/10 px-2 py-0.5 font-semibold normal-case tracking-normal text-info"
                                title={drug.priceDisclosureCycles.map((cycle) => `${cycle.cycleLabel}: submit by ${shortDate(cycle.submissionDeadline)}`).join(' · ')}
                              >
                                Price disclosure · {drug.priceDisclosureCycles.map((cycle) => cycle.cycleLabel).join(', ')}
                              </span>
                            )}
                           {drug.hasTakenFirstNewBrandReduction && drug.firstNewBrandReductionDate && (
                             <span className="rounded bg-muted px-2 py-0.5 font-semibold normal-case tracking-normal text-muted-foreground">
                               FNB reduction recorded {shortDate(drug.firstNewBrandReductionDate)}
                             </span>
                           )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6 mt-4 md:mt-0">
                        {drug.recentHighChangeCount > 0 && (
                          <div
                            className="rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground"
                            title="High-impact schedule changes recorded in the last 90 days"
                          >
                            {drug.recentHighChangeCount} high-impact changes in 90 days
                          </div>
                        )}
                        <div className="text-right hidden md:block">
                          <div className="text-xs font-semibold text-muted-foreground">Ex-manufacturer / wholesale price range</div>
                          <div className="font-mono text-sm font-bold text-foreground mt-0.5">
                             {priceLabel(drug.minimumPrice, drug.maximumPrice)}
                          </div>
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground/50" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tier.level === 'brands' && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            {brandsQuery.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> :
             brandsQuery.isError ? <div className="p-6"><QueryState kind="error" onRetry={() => brandsQuery.refetch()} /></div> :
             !brandsQuery.data?.length ? <div className="p-6"><QueryState kind="empty" /></div> :
             (() => {
              const brands = brandsQuery.data ?? [];
               const innovators = brands
                 .filter((brand) => brand.isInnovator)
                 .sort((left, right) => left.brandName.localeCompare(right.brandName));
               const generics = brands
                 .filter((brand) => !brand.isInnovator)
                 .sort((left, right) => {
                   const dateOrder = (right.firstListedDate ?? '').localeCompare(left.firstListedDate ?? '');
                   return dateOrder !== 0 ? dateOrder : left.brandName.localeCompare(right.brandName);
                 });
              const formularyCounts = brands.reduce((counts, brand) => {
                counts.set(brand.formulary, (counts.get(brand.formulary) ?? 0) + 1);
                return counts;
              }, new Map<string, number>());
              const primaryFormulary = [...formularyCounts.entries()]
                .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
              const allShareFormulary = formularyCounts.size === 1;
               const allSharePrice = brands.every(
                 (brand) => brand.minimumPrice === brands[0].minimumPrice && brand.maximumPrice === brands[0].maximumPrice,
               );
               const sharedMinimumPrice = Math.min(...brands.map((brand) => brand.minimumPrice));
               const sharedMaximumPrice = Math.max(...brands.map((brand) => brand.maximumPrice));
                const predictionKey = (brand: MedicineBrandSummary) => JSON.stringify([
                  brand.nextPredictedReductionDate,
                  brand.nextPredictedCurrentPrice,
                  brand.nextPredictedNewPrice,
                  brand.nextPredictedReductionPercentage,
                  brand.nextPredictedReductionSignificance,
                ]);
                const predictionBuckets = [...brands.reduce((buckets, brand) => {
                  if (brand.nextPredictedReductionDate && brand.nextPredictedCurrentPrice !== null && brand.nextPredictedNewPrice !== null) {
                    const key = predictionKey(brand);
                    const bucket = buckets.get(key) ?? { key, brand, count: 0 };
                    bucket.count += 1;
                    buckets.set(key, bucket);
                  }
                  return buckets;
                }, new Map<string, { key: string; brand: MedicineBrandSummary; count: number }>()).values()];
                const commonPrediction = predictionBuckets.sort((left, right) => right.count - left.count)[0];
                const hasSharedPrediction = Boolean(commonPrediction && commonPrediction.count > 1);
              const renderBrandSection = (label: string, sectionBrands: MedicineBrandSummary[]) => (
                sectionBrands.length > 0 && (
                  <section aria-label={label}>
                    <div className="border-b border-border/70 bg-muted/20 px-6 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/70">
                      {label}
                    </div>
                    <div className="divide-y divide-border/70">
                      {sectionBrands.map((brand) => (
                        <button
                          key={brand.brandName}
                        onClick={() => clickBrand(brand, tier.drug.drugName, tier.drug.originatorBrandName)}
                          className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[minmax(0,1.25fr)_auto_auto_auto_auto] md:px-6 md:py-1.5"
                        >
                            <span className="flex min-w-0 flex-col gap-1">
                             <span className="truncate text-sm font-bold tracking-tight">{brand.brandName}</span>
                              {(!hasSharedPrediction || predictionKey(brand) !== commonPrediction?.key) && brand.nextPredictedReductionDate && brand.nextPredictedCurrentPrice !== null && brand.nextPredictedNewPrice !== null && (
                               <span className="md:hidden">
                                 <PriceForecast
                                   currentPrice={brand.nextPredictedCurrentPrice}
                                   predictedPrice={brand.nextPredictedNewPrice}
                                   predictedDate={brand.nextPredictedReductionDate}
                                   confidence={brand.nextPredictedReductionConfidence ?? undefined}
                                   significance={brand.nextPredictedReductionSignificance}
                                   predictedPercentage={brand.nextPredictedReductionPercentage}
                                 />
                               </span>
                             )}
                          </span>
                          <span className="hidden whitespace-nowrap text-xs font-medium text-muted-foreground md:inline">
                            {brand.itemCount} item{brand.itemCount === 1 ? '' : 's'}
                          </span>
                          <span className="hidden whitespace-nowrap text-xs font-medium text-muted-foreground md:inline">
                            {brand.firstListedDate ? `Listed ${date(brand.firstListedDate)}` : 'Listed unknown'}
                          </span>
                           <span className="hidden min-w-[205px] text-right md:inline">
                              {hasSharedPrediction && predictionKey(brand) === commonPrediction?.key ? (
                                <span className="text-xs font-medium text-muted-foreground">Shared value above</span>
                              ) : brand.nextPredictedReductionDate && brand.nextPredictedCurrentPrice !== null && brand.nextPredictedNewPrice !== null ? (
                                <span className="inline-flex items-center gap-2">
                                  <PriceForecast
                                    currentPrice={brand.nextPredictedCurrentPrice}
                                    predictedPrice={brand.nextPredictedNewPrice}
                                    predictedDate={brand.nextPredictedReductionDate}
                                    confidence={brand.nextPredictedReductionConfidence ?? undefined}
                                    significance={brand.nextPredictedReductionSignificance}
                                    predictedPercentage={brand.nextPredictedReductionPercentage}
                                  />
                                  {hasSharedPrediction && <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-warning">Exception</span>}
                                </span>
                              ) : brand.nextPredictedReductionDate ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-muted-foreground">Forecast differs</span>
                                  <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-warning">Exception</span>
                                </span>
                             ) : (
                               <span className="text-xs font-medium text-muted-foreground">No forecast</span>
                             )}
                           </span>
                           <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                        </button>
                      ))}
                    </div>
                  </section>
                )
              );

              return (
                <>
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-6 py-3">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                       Brands for {drugDisplayName(tier.drug.drugName, tier.drug.originatorBrandName)}
                    </span>
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/70">
                      {brands.length} brand{brands.length === 1 ? '' : 's'}
                    </span>
                  </div>
                   <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border/70 px-6 py-2 text-xs font-medium text-muted-foreground">
                     <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">Shared across brands</span>
                     <span>Formulary: <span className="font-mono font-bold text-foreground">{allShareFormulary ? primaryFormulary : 'varies'}</span></span>
                     <span>Ex-manufacturer / wholesale price: <span className="font-mono font-bold text-foreground">{allSharePrice ? priceLabel(brands[0].minimumPrice, brands[0].maximumPrice) : priceLabel(sharedMinimumPrice, sharedMaximumPrice)}</span></span>
                     {hasSharedPrediction && commonPrediction && (
                       <span className="flex items-center gap-2">
                         Shared upcoming change ({commonPrediction.count} brands):
                         <PriceForecast
                           currentPrice={commonPrediction.brand.nextPredictedCurrentPrice as number}
                           predictedPrice={commonPrediction.brand.nextPredictedNewPrice as number}
                           predictedDate={commonPrediction.brand.nextPredictedReductionDate as string}
                           confidence={commonPrediction.brand.nextPredictedReductionConfidence ?? undefined}
                           significance={commonPrediction.brand.nextPredictedReductionSignificance}
                           predictedPercentage={commonPrediction.brand.nextPredictedReductionPercentage}
                         />
                       </span>
                     )}
                   </div>
                   <div className="hidden grid-cols-[minmax(0,1.25fr)_auto_auto_auto_auto] items-center gap-3 border-b border-border bg-muted/20 px-6 py-2 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70 md:grid">
                    <span>Brand</span>
                    <span>Items</span>
                    <span>Listed</span>
                     <span className="text-right">Current → predicted</span>
                     <span />
                  </div>
                  {renderBrandSection('Innovator', innovators)}
                  {renderBrandSection('Generics', generics)}
                </>
              );
            })()}
          </div>
        )}

        {tier.level === 'items' && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            {itemsQuery.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> : 
             itemsQuery.isError ? <div className="p-6"><QueryState kind="error" onRetry={() => itemsQuery.refetch()} /></div> : 
             !itemsQuery.data?.length ? <div className="p-6"><QueryState kind="empty" /></div> : (
              (() => {
                const items = itemsQuery.data;
                const formularyCounts = items.reduce((counts, item) => {
                  counts.set(item.formulary, (counts.get(item.formulary) ?? 0) + 1);
                  return counts;
                }, new Map<string, number>());
                const primaryFormulary = [...formularyCounts.entries()]
                  .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
                const allShareFormulary = formularyCounts.size === 1;
                const strengthGroups = [...items.reduce((groups, item: MedicineBrandItemSummary) => {
                  const key = item.strength ?? 'Unknown strength';
                  const group = groups.get(key) ?? { strength: item.strength, items: [] as MedicineBrandItemSummary[] };
                  group.items.push(item);
                  groups.set(key, group);
                  return groups;
                }, new Map<string, { strength: string | null; items: MedicineBrandItemSummary[] }>()).values()]
                  .sort((left, right) => (left.strength ?? '').localeCompare(right.strength ?? '', undefined, { numeric: true }));

                return (
                  <>
                    <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2 md:px-6">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                        Listings for {tier.brand.brandName}
                      </span>
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
                        {items.length} listing{items.length === 1 ? '' : 's'}
                        {primaryFormulary && <> · {allShareFormulary ? 'Formulary' : 'Default'} {primaryFormulary}</>}
                      </span>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border bg-muted/20 px-4 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-muted-foreground/70 md:grid-cols-[1fr_auto_minmax(240px,1.2fr)_auto] md:px-6">
                      <span>Strength</span>
                      <span className="hidden md:block">Listings</span>
                      <span className="text-right">Ex-manufacturer / wholesale price</span>
                      <span className="w-4" />
                    </div>
                    <div className="divide-y divide-border/70">
                       {strengthGroups.map((group) => {
                         const representative = group.items[0];
                         const groupKey = `${tier.drugId}:${tier.brand.brandName}:${group.strength ?? 'unknown'}`;
                         const expanded = expandedStrengths.includes(groupKey);
                         return (
                           <div key={groupKey}>
                             <button
                               type="button"
                               onClick={() => setExpandedStrengths((current) => current.includes(groupKey) ? current.filter((key) => key !== groupKey) : [...current, groupKey])}
                               aria-expanded={expanded}
                               className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[1fr_auto_minmax(240px,1.2fr)_auto] md:px-6"
                             >
                               <span className="whitespace-nowrap text-sm font-bold tracking-tight text-foreground">{group.strength || 'Unknown strength'}</span>
                               <span className="hidden whitespace-nowrap text-xs font-medium text-muted-foreground md:inline">{group.items.length} listing{group.items.length === 1 ? '' : 's'}</span>
                               <span className="flex justify-end text-right">
                                 {representative.upcomingPrediction ? (
                                   <PriceForecast
                                     currentPrice={representative.currentAemp}
                                     predictedPrice={representative.upcomingPrediction.predictedNewPrice}
                                     predictedDate={representative.upcomingPrediction.predictedDate}
                                     confidence={representative.upcomingPrediction.confidence}
                                     significance={representative.upcomingPrediction.significance}
                                     predictedPercentage={representative.upcomingPrediction.predictedPercentage}
                                   />
                                 ) : money(representative.currentAemp)}
                               </span>
                               <ChevronDown className={`h-4 w-4 text-muted-foreground/50 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                             </button>
                             {expanded && (
                               <div className="border-t border-border/70 bg-muted/20 px-4 py-2 md:px-6">
                                 <div className="hidden grid-cols-[1fr_1fr_1.2fr_1fr_auto] gap-3 px-2 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground/70 md:grid">
                                   <span>PBS code</span><span>Pack size</span><span>Benefit</span><span>Max quantity</span><span />
                                 </div>
                                 <div className="divide-y divide-border/70">
                                   {group.items.map((item) => (
                                     <Link key={item.itemCode} href={`/pbs/${item.itemCode}`} className="grid gap-1.5 px-2 py-2.5 text-xs transition-colors hover:bg-secondary/30 md:grid-cols-[1fr_1fr_1.2fr_1fr_auto] md:items-center md:gap-3" title={`Open listing details · Internal listing ID: ${item.liItemId ?? item.itemCode}`}>
                                       <span className="font-mono font-bold text-foreground">PBS {item.pbsCode || 'not supplied'}</span>
                                       <span className="font-medium text-muted-foreground">{item.packSize ? `Pack of ${item.packSize}` : 'Pack not supplied'}</span>
                                       <span className="font-medium text-muted-foreground">{benefitTypeLabel(item.benefitTypeCode)}</span>
                                       <span className="font-medium text-muted-foreground">Maximum {item.maximumQuantityUnits ?? 'not supplied'}</span>
                                       <ChevronRight className="hidden h-4 w-4 text-muted-foreground/40 md:block" />
                                     </Link>
                                   ))}
                                 </div>
                               </div>
                             )}
                           </div>
                         );
                       })}
                    </div>
                  </>
                );
              })()
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
