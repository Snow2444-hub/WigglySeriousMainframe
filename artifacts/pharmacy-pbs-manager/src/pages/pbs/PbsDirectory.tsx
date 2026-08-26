import { useState, useMemo } from 'react';
import { 
  useListMedicineDirectory, getListMedicineDirectoryQueryKey,
  useListMedicineBrands, getListMedicineBrandsQueryKey,
  useListMedicineBrandItems, getListMedicineBrandItemsQueryKey,
  type MedicineDrugSummary, type MedicineBrandSummary, type PbsItem
} from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { Search, ChevronRight, ArrowLeft, Pill, Building2, Tag, AlertTriangle } from 'lucide-react';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

type Tier = 
  | { level: 'drugs' }
  | { level: 'brands', drug: MedicineDrugSummary }
  | { level: 'items', drugId: number, drugName: string, brand: MedicineBrandSummary | { brandName: string } };

export function PbsDirectory() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState<Tier>({ level: 'drugs' });

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
      setTier({ level: 'items', drugId: drug.drugId, drugName: drug.drugName, brand: { brandName: drug.matchedBrandName } });
    } else {
      setTier({ level: 'brands', drug });
    }
  };

  const clickBrand = (brand: MedicineBrandSummary, drugName: string) => {
    setTier({ level: 'items', drugId: brand.drugId, drugName, brand });
  };

  return (
    <AppShell>
      <PageHeading eyebrow="Reference library / PBS" title="PBS directory" description="Precise medicine intelligence. Search by drug, brand, ingredient, or code." />
      
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm sm:flex-row">
        <label className="flex min-h-12 flex-1 items-center gap-3 rounded-xl bg-muted/50 px-4 text-muted-foreground focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/20 transition-all">
          <Search className="h-5 w-5 shrink-0" />
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
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-muted-foreground animate-rise-in">
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
                onClick={() => setTier({ level: 'brands', drug: { drugId: tier.drugId, drugName: tier.drugName } as MedicineDrugSummary })} 
                className="hover:text-foreground transition-colors"
              >
                {tier.drugName}
              </button>
              <ChevronRight className="h-4 w-4 opacity-50" />
              <span className="text-foreground">{tier.brand.brandName}</span>
            </>
          ) : (
            <span className="text-foreground">{tier.drug.drugName}</span>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm min-h-[400px]">
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
                  
                  return (
                    <button 
                      key={drug.drugId} 
                      onClick={() => clickDrug(drug)} 
                      className="w-full grid gap-2 px-6 py-5 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[1fr_auto] md:items-center"
                    >
                      <div>
                        {isItem ? (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-primary">
                            <Tag className="h-3 w-3" /> Item Match • {drug.matchedItemCode}
                          </div>
                        ) : isBrand ? (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-primary">
                            <Building2 className="h-3 w-3" /> Brand Match
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                            <Pill className="h-3 w-3" /> Drug / Ingredient
                          </div>
                        )}
                        
                        <div className="text-lg font-bold tracking-tight">
                          {isItem ? (drug.matchedBrandName || drug.drugName) : isBrand ? drug.matchedBrandName : drug.drugName}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground font-medium">
                          {isBrand || isItem ? (
                            <>{drug.drugName} <span className="opacity-50 mx-1.5">•</span> {drug.activeIngredient}</>
                          ) : (
                            drug.activeIngredient
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          <span>{drug.brandCount} brands</span>
                          <span>•</span>
                          <span>{drug.itemCount} items</span>
                          <span>•</span>
                          <span>{drug.formulary}</span>
                          {drug.upcomingPredictedReductionCount > 0 && (
                            <>
                              <span>•</span>
                              <span className="text-primary">{drug.upcomingPredictedReductionCount} upcoming reduction{drug.upcomingPredictedReductionCount === 1 ? '' : 's'}{drug.nextPredictedReductionDate ? ` from ${date(drug.nextPredictedReductionDate)}` : ''}</span>
                            </>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6 mt-4 md:mt-0">
                        {drug.recentHighChangeCount > 0 && (
                          <div className="flex items-center gap-1.5 text-chart-3 font-semibold text-xs bg-chart-3/10 px-2.5 py-1 rounded-md">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {drug.recentHighChangeCount} schedule changes
                          </div>
                        )}
                        <div className="text-right hidden md:block">
                          <div className="text-xs font-semibold text-muted-foreground">Ex-manufacturer / wholesale price range</div>
                          <div className="font-mono text-sm font-bold text-foreground mt-0.5">
                            {money(drug.minimumPrice)} <span className="opacity-40">-</span> {money(drug.maximumPrice)}
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
            <div className="flex justify-between border-b border-border bg-muted/30 px-6 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              <span>Brands for {tier.drug.drugName}</span>
              <span>{brandsQuery.data?.length || 0} brands</span>
            </div>
            {brandsQuery.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> : 
             brandsQuery.isError ? <div className="p-6"><QueryState kind="error" onRetry={() => brandsQuery.refetch()} /></div> : 
             !brandsQuery.data?.length ? <div className="p-6"><QueryState kind="empty" /></div> : (
              <div className="divide-y divide-border">
                {brandsQuery.data.map(brand => (
                  <button 
                    key={brand.brandName} 
                    onClick={() => clickBrand(brand, tier.drug.drugName)} 
                    className="w-full grid gap-2 px-6 py-5 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[1fr_auto] md:items-center"
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        {brand.isInnovator && (
                          <span className="bg-primary/10 text-primary font-mono text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded">Innovator</span>
                        )}
                        <span className="text-muted-foreground font-mono text-[10px] font-bold uppercase tracking-wider">
                          {brand.itemCount} items
                        </span>
                      </div>
                      <div className="text-lg font-bold tracking-tight">{brand.brandName}</div>
                      <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground font-medium">
                        <span>Listed {brand.firstListedDate ? date(brand.firstListedDate) : 'Unknown'}</span>
                        <span>{brand.formulary}</span>
                        {brand.changeCount > 0 && <span>{brand.changeCount} change{brand.changeCount === 1 ? '' : 's'}{brand.latestChangeDate ? ` · latest ${date(brand.latestChangeDate)}` : ''}</span>}
                        {brand.highChangeCount > 0 && (
                          <span className="flex items-center gap-1 text-chart-3"><AlertTriangle className="h-3.5 w-3.5" /> High-impact changes</span>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6 mt-4 md:mt-0">
                      <div className="text-right hidden md:block">
                        <div className="text-xs font-semibold text-muted-foreground">Ex-manufacturer / wholesale price range</div>
                        <div className="font-mono text-sm font-bold text-foreground mt-0.5">
                          {money(brand.minimumPrice)} <span className="opacity-40">-</span> {money(brand.maximumPrice)}
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground/50" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tier.level === 'items' && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="hidden grid-cols-[1.5fr_1fr_1fr_auto] border-b border-border bg-muted/30 px-6 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground md:grid">
              <span>Item details</span>
              <span>Formulary</span>
              <span>Ex-manufacturer / wholesale price</span>
              <span className="text-right">Action</span>
            </div>
            {itemsQuery.isLoading ? <div className="p-6"><QueryState kind="loading" /></div> : 
             itemsQuery.isError ? <div className="p-6"><QueryState kind="error" onRetry={() => itemsQuery.refetch()} /></div> : 
             !itemsQuery.data?.length ? <div className="p-6"><QueryState kind="empty" /></div> : (
              <div className="divide-y divide-border">
                {itemsQuery.data.map(item => (
                  <Link 
                    key={item.itemCode} 
                    href={`/pbs/${item.itemCode}`}
                    className="w-full grid gap-2 px-6 py-4 text-left transition-colors hover:bg-secondary/20 md:grid-cols-[1.5fr_1fr_1fr_auto] md:items-center"
                  >
                    <div>
                      <div className="font-mono text-xs font-bold text-primary mb-1">PBS {item.pbsCode || 'not supplied'}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">LI item {item.liItemId || item.itemCode}</div>
                      <div className="text-sm font-bold">{item.packSize || 'No pack size'}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{item.liForm || item.form || 'Unknown form'}</div>
                    </div>
                    <div>
                      <span className={`inline-flex rounded-md px-2 py-1 font-mono text-[10px] font-bold ${item.formulary === 'F1' ? 'bg-sidebar-primary/10 text-sidebar-primary' : 'bg-chart-2/15 text-chart-2'}`}>
                        {item.formulary}
                      </span>
                    </div>
                    <div className="font-mono text-sm font-bold text-foreground">
                      {money(item.currentAemp)}
                    </div>
                    <div className="text-right flex justify-end">
                      <ChevronRight className="h-5 w-5 text-muted-foreground/50" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
