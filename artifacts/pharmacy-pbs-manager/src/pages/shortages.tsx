import { useState, useEffect } from "react";
import { 
  AlertTriangle, 
  Search, 
  Activity, 
  ArrowRight, 
  ShieldCheck, 
  Info,
  CalendarDays
} from "lucide-react";
import { 
  useListTgaShortages, 
  type TgaShortage, 
  type TgaShortageSection,
  type TgaShortageListResponse
} from "@workspace/api-client-react";
import { AppShell, PageHeading, QueryState } from "@/components/app-shell";
import { formatDateValue } from "@/lib/date-format";

const TABS: { id: TgaShortageSection; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'anticipated', label: 'Anticipated' },
  { id: 'discontinued', label: 'Discontinued' },
];

function impactRatingClass(rating: string | null | undefined) {
  if (!rating) return 'bg-muted text-muted-foreground border border-border/50';
  const r = rating.toLowerCase();
  if (r.includes('high') || r.includes('critical')) return 'bg-destructive/10 text-destructive border border-destructive/20';
  if (r.includes('medium')) return 'bg-warning/15 text-warning border border-warning/20';
  if (r.includes('low')) return 'bg-success/15 text-success border border-success/20';
  return 'bg-muted text-muted-foreground border border-border/50';
}

function dateOrUnknown(d: string | null | undefined) {
  if (!d) return 'Unknown';
  return formatDateValue(d, { day: 'numeric', month: 'short', year: 'numeric' });
}

function SourceHealthBanner({ health }: { health: TgaShortageListResponse['sourceHealth'] }) {
  if (!health) return null;
  const issues = [];
  if (health.active && health.active.status !== 'OK') issues.push(`Active: ${health.active.status.replace(/_/g, ' ')}`);
  if (health.archive && health.archive.status !== 'OK') issues.push(`Archive: ${health.archive.status.replace(/_/g, ' ')}`);

  if (issues.length === 0) return null;

  return (
    <div className="mb-8 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-foreground animate-rise-in">
      <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
      <div>
        <p className="font-bold text-warning">TGA data synchronization issues</p>
        <p className="mt-1 opacity-90 text-xs">The shortage register may not reflect the latest data from the TGA. {issues.join(' · ')}</p>
      </div>
    </div>
  );
}

function ShortageCard({ shortage, compact = false }: { shortage: TgaShortage; compact?: boolean }) {
  const isArchive = shortage.sourceKind === 'archive';
  const missingInArchive = <span className="text-muted-foreground italic font-normal text-xs">Not supplied in archive</span>;

  let confidenceText = "";
  if (shortage.matchConfidence === 'exact') confidenceText = "High confidence";
  else if (shortage.matchConfidence === 'high') confidenceText = "Ingredient match / Medium confidence";
  else if (shortage.matchConfidence === 'review') confidenceText = "Brand-only / Review";

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/60 p-4 text-sm transition-shadow hover:bg-card hover:shadow-xs">
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-foreground truncate" title={shortage.artgName}>{shortage.artgName}</h3>
          <p className="text-xs text-muted-foreground truncate">{shortage.activeIngredients} · {shortage.sponsor}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Resolved</div>
          <div className="text-xs font-medium text-foreground">{dateOrUnknown(shortage.lastUpdated)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border bg-card p-5 transition-shadow hover:shadow-md ${shortage.followed ? 'border-primary/40 shadow-sm' : 'border-border shadow-xs'}`}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {shortage.availability ? (
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] bg-foreground text-background px-2.5 py-1 rounded-md shadow-sm">
                {shortage.availability}
              </span>
            ) : isArchive ? (
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] bg-muted text-muted-foreground px-2.5 py-1 rounded-md border border-border/50">
                Not supplied in archive
              </span>
            ) : (
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] bg-muted text-muted-foreground px-2.5 py-1 rounded-md border border-border/50">
                Unknown availability
              </span>
            )}
            {shortage.shortageImpactRating && (
              <span className={`font-mono text-[10px] font-bold uppercase tracking-[0.1em] px-2 py-1 rounded ${impactRatingClass(shortage.shortageImpactRating)}`}>
                {shortage.shortageImpactRating} Impact
              </span>
            )}
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground px-2 py-1 rounded bg-muted/50 border border-border/50">
              ARTG {shortage.artgId}
            </span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
              {isArchive ? 'Archived record' : 'Active record'}
            </span>
          </div>
          <h3 className="text-xl font-bold leading-tight tracking-[-0.03em] truncate" title={shortage.artgName}>{shortage.artgName}</h3>
          <p className="mt-1.5 text-sm font-semibold text-foreground/80 truncate" title={shortage.activeIngredients}>{shortage.activeIngredients}</p>
          <p className="mt-0.5 text-xs text-muted-foreground truncate" title={`${shortage.sponsor} · ${shortage.dosageForm}`}>{shortage.sponsor} · {shortage.dosageForm}</p>
        </div>
        {shortage.followed && (
          <div className="shrink-0 flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-primary">
            <Activity className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Following</span>
          </div>
        )}
      </div>

      <div className="mt-6 grid sm:grid-cols-2 gap-5">
        <div className="space-y-5">
          <div>
            <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5"><CalendarDays className="h-3.5 w-3.5" /> Impact Period</h4>
            <div className="flex items-center gap-2 text-sm font-medium bg-secondary/40 border border-border/50 rounded-lg px-3 py-2 w-fit">
              <span>{dateOrUnknown(shortage.supplyImpactStartDate)}</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <span>{dateOrUnknown(shortage.supplyImpactEndDate)}</span>
            </div>
            {shortage.deletionFromMarket && (
              <p className="mt-2.5 text-xs font-semibold text-destructive flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> Deletion from market: {dateOrUnknown(shortage.deletionFromMarket)}
              </p>
            )}
          </div>
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Reason</h4>
            <p className="text-sm leading-relaxed">{shortage.reason || 'Not specified'}</p>
          </div>
        </div>
        <div className="space-y-5">
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Management Action</h4>
            <div className="text-sm leading-relaxed max-h-[100px] overflow-y-auto pr-2 custom-scrollbar text-muted-foreground">
              {shortage.managementAction || (isArchive ? missingInArchive : 'None specified')}
            </div>
          </div>
        </div>
      </div>
      
      {shortage.followed && shortage.watchedDrugName && (
        <div className="mt-5 rounded-xl bg-accent/5 p-4 border border-accent/15">
          <div className="flex items-center gap-2 mb-1.5">
            <ShieldCheck className="h-4 w-4 text-accent" />
            <span className="text-xs font-bold text-accent-foreground">Matched to watched drug: {shortage.watchedDrugName}</span>
          </div>
          {confidenceText && <p className="text-xs font-semibold text-accent/80 ml-6 mb-1">{confidenceText}</p>}
          {shortage.matchDiagnosticReason && <p className="text-xs text-muted-foreground ml-6 leading-relaxed">{shortage.matchDiagnosticReason}</p>}
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-border/60 flex flex-wrap items-center justify-between gap-3 text-[10px] font-mono text-muted-foreground">
        <span>Last updated: {shortage.lastUpdated ? dateOrUnknown(shortage.lastUpdated) : 'Unknown'}</span>
        <span className="flex items-center gap-1.5"><Info className="h-3 w-3" /> Data via TGA · As of {dateOrUnknown(shortage.sourceAsOf)}</span>
      </div>
    </div>
  );
}

export function ShortagesPage() {
  const [mode, setMode] = useState<'followed' | 'all'>('followed');
  const [section, setSection] = useState<TgaShortageSection>('current');
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 20;

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const handleModeChange = (newMode: 'followed' | 'all') => {
    if (newMode === mode) return;
    setMode(newMode);
    setPage(1);
    setSection('current');
  };

  const handleSectionChange = (newSection: TgaShortageSection) => {
    if (newSection === section) return;
    setSection(newSection);
    setPage(1);
  };

  const { data, isLoading, isError, refetch } = useListTgaShortages({
    mode,
    section,
    search: debouncedSearch || undefined,
    page,
    limit,
  });

  return (
    <AppShell>
      <PageHeading
        eyebrow="TGA Shortages"
        title="Medicine supply & shortages"
        description="Track TGA shortage notifications and anticipated supply interruptions for your watched medicines."
        action={
          <div className="flex bg-muted/40 p-1 rounded-xl border border-border shadow-sm mt-4 md:mt-0">
            <button 
              onClick={() => handleModeChange('followed')} 
              className={`px-4 py-2 text-sm font-bold rounded-lg transition-all ${mode === 'followed' ? 'bg-card shadow-sm border border-border/50 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Following
            </button>
            <button 
              onClick={() => handleModeChange('all')} 
              className={`px-4 py-2 text-sm font-bold rounded-lg transition-all ${mode === 'all' ? 'bg-card shadow-sm border border-border/50 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              All shortages
            </button>
          </div>
        }
      />

      <div className="flex flex-col sm:flex-row gap-4 mb-8">
        <div className="relative flex-1 animate-rise-in delay-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input 
            type="text" 
            className="control-input pl-10 h-12" 
            placeholder="Search by ingredient, brand name or ARTG ID..." 
            value={search} 
            onChange={e => setSearch(e.target.value)} 
          />
        </div>
      </div>

      {data?.sourceHealth && <SourceHealthBanner health={data.sourceHealth} />}

      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-border/60 mb-6 animate-rise-in delay-2">
        <div className="flex items-center gap-6">
          {TABS.map(tab => (
            <button 
              key={tab.id} 
              onClick={() => handleSectionChange(tab.id)} 
              className={`pb-3.5 font-bold text-sm border-b-2 transition-colors relative ${section === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'}`}
            >
              {tab.label}
              {data?.counts?.[tab.id as keyof typeof data.counts] !== undefined && (
                <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-mono ${section === tab.id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {data.counts[tab.id as keyof typeof data.counts]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button 
          onClick={() => handleSectionChange('resolved')} 
          className={`pb-3.5 font-bold text-sm border-b-2 transition-colors relative ${section === 'resolved' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'}`}
        >
          Resolved
          {data?.counts?.resolved !== undefined && (
            <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-mono ${section === 'resolved' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
              {data.counts.resolved}
            </span>
          )}
        </button>
      </div>

      <div className="animate-rise-in delay-3">
        {isLoading ? (
          <div className="space-y-4">
            <QueryState kind="loading" />
            <QueryState kind="loading" />
          </div>
        ) : isError ? (
          <QueryState kind="error" onRetry={refetch} />
        ) : !data || data.rows.length === 0 ? (
          <QueryState kind="empty" />
        ) : (
          <div className="space-y-5">
            {data.rows.map(shortage => (
              <ShortageCard key={shortage.id} shortage={shortage} />
            ))}

            {data.total > 0 && (
              <div className="mt-10 mb-10 flex items-center justify-between border-t border-border/60 pt-6">
                <div className="text-xs font-semibold text-muted-foreground">
                  Showing {((page - 1) * limit) + 1} to {Math.min(page * limit, data.total)} of <span className="text-foreground">{data.total}</span> records
                </div>
                <div className="flex gap-2">
                  <button 
                    disabled={page === 1} 
                    onClick={() => {
                      setPage(p => p - 1);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }} 
                    className="flex h-9 items-center justify-center rounded-xl border border-input bg-background px-4 text-xs font-bold text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-foreground"
                  >
                    Previous
                  </button>
                  <button 
                    disabled={page * limit >= data.total} 
                    onClick={() => {
                      setPage(p => p + 1);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }} 
                    className="flex h-9 items-center justify-center rounded-xl border border-input bg-background px-4 text-xs font-bold text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-foreground"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {mode === 'followed' && data?.recentlyResolved && data.recentlyResolved.length > 0 && (
        <div className="mt-12 animate-rise-in delay-3">
          <div className="mb-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-success/80"></span>
              Recently Resolved (90 Days)
            </h3>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.recentlyResolved.map(shortage => (
              <ShortageCard key={shortage.id} shortage={shortage} compact={true} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-12 text-xs text-muted-foreground border-t border-border/60 pt-4 pb-8 text-center sm:text-left">
        Data sourced from the Therapeutic Goods Administration (TGA). © Commonwealth of Australia.
      </div>
    </AppShell>
  );
}
