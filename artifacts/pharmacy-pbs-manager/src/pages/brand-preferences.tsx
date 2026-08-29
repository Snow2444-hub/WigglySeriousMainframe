import { useMemo, useState } from "react";
import {
  getGetPharmacyBrandPreferencesQueryKey,
  useGetPharmacyBrandPreferences,
  useSetPharmacyBrandPreferences,
} from "@workspace/api-client-react";
import type { PharmacyBrandPreferences } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeading, QueryState } from "@/components/app-shell";
import { ChevronDown, ChevronUp, Eye, EyeOff, ListFilter, Search } from "lucide-react";

type PharmacyBrandPreference = PharmacyBrandPreferences["brands"][0];

type BrandGroup = {
  drugId: number;
  drugName: string;
  brands: PharmacyBrandPreference[];
};

function brandSlug(brandName: string) {
  return brandName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function groupBrands(brands: PharmacyBrandPreference[]): BrandGroup[] {
  const groups = new Map<number, BrandGroup>();
  for (const brand of brands) {
    const existing = groups.get(brand.drugId);
    if (existing) {
      existing.brands.push(brand);
    } else {
      groups.set(brand.drugId, {
        drugId: brand.drugId,
        drugName: brand.drugName,
        brands: [brand],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      brands: [...group.brands].sort((left, right) =>
        Number(right.isInnovator) - Number(left.isInnovator)
        || left.brandName.localeCompare(right.brandName),
      ),
    }))
    .sort((left, right) => left.drugName.localeCompare(right.drugName));
}

function applyLocalPreferences(
  current: PharmacyBrandPreferences,
  changes: Array<{ drugId: number; brandName: string; hidden: boolean }>,
): PharmacyBrandPreferences {
  const changeByKey = new Map(changes.map((change) => [
    `${change.drugId}:${change.brandName.trim().toLocaleLowerCase()}`,
    change.hidden,
  ]));
  const brands = current.brands.map((brand) => ({
    ...brand,
    hidden: changeByKey.get(`${brand.drugId}:${brand.brandName.trim().toLocaleLowerCase()}`) ?? brand.hidden,
  }));
  const hiddenBrands = brands.filter((brand) => brand.hidden);
  return {
    ...current,
    brands,
    hiddenBrandCount: hiddenBrands.length,
    hiddenItemCount: hiddenBrands.reduce((count, brand) => count + brand.itemCount, 0),
  };
}

export function BrandPreferencesPage() {
  const { data, isLoading, isError, refetch } = useGetPharmacyBrandPreferences();
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<number, boolean>>({});
  const [mutationError, setMutationError] = useState("");
  const queryClient = useQueryClient();
  const preferenceQueryKey = getGetPharmacyBrandPreferencesQueryKey();
  const setPreferences = useSetPharmacyBrandPreferences();

  const filteredBrands = useMemo(() => {
    if (!data?.brands) return [];
    if (!search.trim()) return data.brands;
    const lower = search.toLowerCase();
    return data.brands.filter(b => 
      b.brandName.toLowerCase().includes(lower) || 
      b.drugName.toLowerCase().includes(lower)
    );
  }, [data?.brands, search]);

  const groups = useMemo(() => groupBrands(filteredBrands), [filteredBrands]);

  if (isLoading) return (
    <AppShell>
      <PageHeading 
        eyebrow="Preferences" 
        title="Brand visibility" 
        description="Hide brands you do not stock to keep your PBS workspace relevant. This is display-only: PBS ingestion and price calculations retain every brand." 
      />
      <QueryState kind="loading" />
    </AppShell>
  );

  if (isError) return (
     <AppShell>
      <PageHeading 
        eyebrow="Preferences" 
        title="Brand visibility" 
        description="Hide brands you do not stock to keep your PBS workspace relevant. This is display-only: PBS ingestion and price calculations retain every brand." 
      />
      <QueryState kind="error" onRetry={() => refetch()} />
    </AppShell>
  );

  const allBrands = data?.brands ?? [];
  const visibleCount = allBrands.filter((brand) => !brand.hidden).length;
  const hiddenCount = allBrands.length - visibleCount;
  const totalCount = allBrands.length;

  const updateVisibility = (brands: PharmacyBrandPreference[], hidden: boolean) => {
    if (!brands.length || setPreferences.isPending) return;
    const changes = brands.map((brand) => ({
      drugId: brand.drugId,
      brandName: brand.brandName,
      hidden,
    }));
    const previous = queryClient.getQueryData<PharmacyBrandPreferences>(preferenceQueryKey);
    setMutationError("");
    if (previous) {
      queryClient.setQueryData(preferenceQueryKey, applyLocalPreferences(previous, changes));
    }
    setPreferences.mutate(
      { data: { preferences: changes } },
      {
        onSuccess: (summary) => {
          queryClient.setQueryData(preferenceQueryKey, summary);
        },
        onError: (error) => {
          if (previous) queryClient.setQueryData(preferenceQueryKey, previous);
          setMutationError(error instanceof Error ? error.message : "The visibility change could not be saved.");
        },
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: preferenceQueryKey });
        },
      },
    );
  };

  const hideEverything = () => {
    if (!visibleCount || !window.confirm("Hide every brand? You can turn the brands you stock back on one by one.")) return;
    updateVisibility(allBrands, true);
  };

  const showEverything = () => updateVisibility(allBrands, false);

  const toggleGroup = (drugId: number) => {
    setCollapsedGroups((current) => ({ ...current, [drugId]: !current[drugId] }));
  };

  return (
    <AppShell>
      <div className="space-y-6">
      <PageHeading 
        eyebrow="Preferences" 
        title="Brand visibility" 
        description="Hide brands you do not stock to keep your PBS workspace relevant. This is display-only: PBS ingestion and price calculations retain every brand." 
      />
      
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="Search brands or drugs..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="control-input pl-9"
          />
        </div>
        
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="text-brand-visibility-summary">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Eye className="h-4 w-4 text-primary" /> 
            <span><span className="font-mono">{visibleCount}</span> visible</span>
          </div>
          <div className="flex items-center gap-2 font-medium text-muted-foreground">
            <EyeOff className="h-4 w-4" /> 
            <span><span className="font-mono">{hiddenCount}</span> hidden</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-info/20 bg-info/5 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="panel-brand-visibility-starting-mode">
        <div>
          <p className="text-sm font-bold text-foreground">Start with nothing visible</p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">Hide every brand, then turn on only the brands you stock. Your changes affect this display only — shared PBS data remains complete.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={hideEverything} disabled={!visibleCount || setPreferences.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-warning/30 bg-background px-3.5 text-xs font-bold text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-hide-all-brands">
            <EyeOff className="h-3.5 w-3.5" /> Hide everything
          </button>
          <button type="button" onClick={showEverything} disabled={!hiddenCount || setPreferences.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3.5 text-xs font-bold text-muted-foreground hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-show-all-brands">
            <Eye className="h-3.5 w-3.5" /> Show everything
          </button>
        </div>
      </div>

      {mutationError && <p className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-xs font-semibold text-destructive" role="alert" data-testid="status-brand-visibility-error">{mutationError}</p>}

      <div className="rounded-2xl border border-border bg-card shadow-xs animate-rise-in delay-1 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto] gap-4 bg-muted/40 px-5 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          <div>Drug & brands</div>
          <div className="hidden w-36 text-center sm:block">Group actions</div>
        </div>
        {totalCount === 0 ? (
           <div className="px-5 py-12 text-center">
              <ListFilter className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-foreground font-semibold">No brands are available</p>
              <p className="text-sm text-muted-foreground mt-1">Add an enabled PBS watchlist entry to populate brand visibility settings.</p>
           </div>
        ) : groups.length === 0 ? (
           <div className="px-5 py-12 text-center">
              <ListFilter className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-foreground font-semibold">No brands found</p>
              <p className="text-sm text-muted-foreground mt-1">Try a different search term.</p>
           </div>
        ) : (
          <div className="divide-y divide-border">
            {groups.map((group) => {
              const groupVisibleCount = group.brands.filter((brand) => !brand.hidden).length;
              const groupAllVisible = groupVisibleCount === group.brands.length;
              const groupAllHidden = groupVisibleCount === 0;
              const isCollapsed = collapsedGroups[group.drugId] ?? false;
              return (
                <section key={group.drugId} data-testid={`group-brand-${group.drugId}`}>
                  <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <button type="button" onClick={() => toggleGroup(group.drugId)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={!isCollapsed} aria-controls={`brands-for-drug-${group.drugId}`} data-testid={`button-toggle-brand-group-${group.drugId}`}>
                      {isCollapsed ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-foreground">{group.drugName}</span>
                        <span className="mt-1 block text-xs text-muted-foreground"><span className="font-mono">{groupVisibleCount}</span> visible / <span className="font-mono">{group.brands.length - groupVisibleCount}</span> hidden · <span className="font-mono">{group.brands.length}</span> brands</span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">
                      <button type="button" onClick={() => updateVisibility(group.brands, true)} disabled={groupAllHidden || setPreferences.isPending} className="rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] font-bold text-muted-foreground hover:border-warning/40 hover:text-warning disabled:cursor-not-allowed disabled:opacity-45" data-testid={`button-hide-all-brand-group-${group.drugId}`}>Hide all</button>
                      <button type="button" onClick={() => updateVisibility(group.brands, false)} disabled={groupAllVisible || setPreferences.isPending} className="rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] font-bold text-muted-foreground hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-45" data-testid={`button-show-all-brand-group-${group.drugId}`}>Show all</button>
                    </div>
                  </div>
                  {!isCollapsed && <ul id={`brands-for-drug-${group.drugId}`} className="border-t border-border/70 divide-y divide-border/70">
                    {group.brands.map((brand) => (
                      <BrandRow key={`${brand.drugId}-${brand.brandName}`} brand={brand} disabled={setPreferences.isPending} onToggle={() => updateVisibility([brand], !brand.hidden)} />
                    ))}
                  </ul>}
                </section>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </AppShell>
  );
}

function BrandRow({ brand, disabled, onToggle }: { brand: PharmacyBrandPreference; disabled: boolean; onToggle: () => void }) {
  return (
    <li className={`group grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 pl-12 transition-colors hover:bg-muted/30 sm:pl-14 ${brand.hidden ? 'bg-muted/20 opacity-75 grayscale-[0.2]' : ''}`} data-testid={`row-brand-${brand.drugId}-${brandSlug(brand.brandName)}`}>
      <div className="flex min-w-0 flex-col pr-4">
        <div className="flex items-center gap-2">
           <span className="truncate text-sm font-bold text-foreground transition-colors group-hover:text-primary">
             {brand.brandName}
           </span>
           {brand.isInnovator && (
             <span className="status-badge status-info shrink-0">Innovator</span>
           )}
           {brand.hidden && (
             <span className="shrink-0 rounded bg-muted-foreground/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
               Hidden
             </span>
           )}
        </div>
        <span className="mt-1 truncate text-xs text-muted-foreground">
          {brand.drugName} &middot; <span className="font-mono font-medium">{brand.itemCount}</span> items
        </span>
      </div>
      
      <div className="flex w-24 items-center justify-center shrink-0">
        <button 
           onClick={onToggle}
           disabled={disabled}
           aria-pressed={!brand.hidden}
           title={brand.hidden ? "Show brand" : "Hide brand"}
           className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait ${!brand.hidden ? 'bg-primary' : 'bg-muted-foreground/30'}`}
         >
           <span className="sr-only">Toggle visibility for {brand.brandName}</span>
           <span className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${!brand.hidden ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
        </button>
      </div>
    </li>
  );
}
