import { useState, useMemo } from "react";
import {
  useGetPharmacyBrandPreferences,
  useSetPharmacyBrandPreference,
} from "@workspace/api-client-react";
import type { PharmacyBrandPreferences } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeading, QueryState } from "@/components/app-shell";
import { Search, Eye, EyeOff, ListFilter } from "lucide-react";

type PharmacyBrandPreference = PharmacyBrandPreferences["brands"][0];

export function BrandPreferencesPage() {
  const { data, isLoading, isError, refetch } = useGetPharmacyBrandPreferences();
  const [search, setSearch] = useState("");
  
  const filteredBrands = useMemo(() => {
    if (!data?.brands) return [];
    if (!search.trim()) return data.brands;
    const lower = search.toLowerCase();
    return data.brands.filter(b => 
      b.brandName.toLowerCase().includes(lower) || 
      b.drugName.toLowerCase().includes(lower)
    );
  }, [data?.brands, search]);

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

  const visibleCount = data?.brands.filter(b => !b.hidden).length ?? 0;

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
        
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Eye className="h-4 w-4 text-primary" /> 
            <span><span className="font-mono">{visibleCount}</span> visible</span>
          </div>
          <div className="flex items-center gap-2 font-medium text-muted-foreground">
            <EyeOff className="h-4 w-4" /> 
            <span><span className="font-mono">{data?.hiddenBrandCount ?? 0}</span> hidden</span>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card shadow-xs animate-rise-in delay-1 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto] gap-4 bg-muted/40 px-5 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          <div>Brand & Drug</div>
          <div className="w-24 text-center">Visibility</div>
        </div>
        {filteredBrands.length === 0 ? (
           <div className="px-5 py-12 text-center">
              <ListFilter className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-foreground font-semibold">No brands found</p>
              <p className="text-sm text-muted-foreground mt-1">Try a different search term.</p>
           </div>
        ) : (
          <ul className="divide-y divide-border">
            {filteredBrands.map(brand => (
              <BrandRow key={`${brand.drugId}-${brand.brandName}`} brand={brand} />
            ))}
          </ul>
        )}
      </div>
      </div>
    </AppShell>
  );
}

function BrandRow({ brand }: { brand: PharmacyBrandPreference }) {
  const queryClient = useQueryClient();
  const setPreference = useSetPharmacyBrandPreference();
  
  const handleToggle = () => {
    // If the mutation is already pending, do nothing
    if (setPreference.isPending) return;
    
    setPreference.mutate(
      { data: { drugId: brand.drugId, brandName: brand.brandName, hidden: !brand.hidden } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries();
        }
      }
    );
  };

  return (
    <li className={`group grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/30 ${brand.hidden ? 'bg-muted/20 opacity-75 grayscale-[0.2]' : ''}`}>
      <div className="flex min-w-0 flex-col pr-4">
        <div className="flex items-center gap-2">
           <span className="truncate text-sm font-bold text-foreground transition-colors group-hover:text-primary">
             {brand.brandName}
           </span>
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
           onClick={handleToggle}
           disabled={setPreference.isPending}
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
