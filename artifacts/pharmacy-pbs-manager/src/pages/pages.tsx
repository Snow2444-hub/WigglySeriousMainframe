import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetCurrentAdminIngestionRunQueryKey,
  getGetArtgImportStatusQueryKey,
  getGetScheduleChangeSettingsQueryKey,
  getGetDashboardQueryKey,
  getListAdminArtgImportRunsQueryKey,
  getListAdminIngestionRunsQueryKey,
  getListAdminPbsSourceStatusQueryKey,
  getListArtgEntriesQueryKey,
  getListPbsWatchlistEntriesQueryKey,
  getListPbsItemsQueryKey,
  getListStockQueryKey,
  type AdminIngestionRun,
  type AdminPbsSourceStatus,
  type ArtgEntry,
  type ArtgImportRun,
  type DashboardPeriodSummary,
  type PbsItem,
  type PbsWatchlistEntry,
  type PharmacyStock,
  type StockExposureLine,
  type StockExposureResponse,
  uploadAdminArtgExport,
  useCreatePbsWatchlistEntry,
  useCreateStock,
  useCancelAdminIngestionRun,
  useDeletePbsWatchlistEntry,
  useDeleteStock,
  useGetCurrentAdminIngestionRun,
  useGetArtgImportStatus,
  useGetScheduleChangeSettings,
  useGetDashboard,
  useListAdminIngestionRuns,
  useListAdminPbsSourceStatus,
  useListAdminArtgImportRuns,
  useListArtgEntries,
  useListPbsItems,
  useListPbsWatchlistEntries,
  useListStock,
  useTriggerAdminIngestion,
  useUploadAdminArtgExport,
  useUpdatePbsWatchlistEntry,
  useUpdateScheduleChangeSettings,
  useUpdateStock,
} from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, BarChart3, Bell, BookOpen, Boxes, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clock3, DatabaseZap, Filter, History, LoaderCircle, PackagePlus, Pencil, Play, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, Trash2, TrendingDown, X, XCircle } from 'lucide-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { formatDateOnly, formatDateTime, formatDateValue } from '@/lib/date-format';
import { sourceHealthDetail } from '@/lib/source-health';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string | null | undefined) => formatDateValue(value, { day: '2-digit', month: 'short', year: 'numeric' });

function watchlistFilterTypeLabel(value: PbsWatchlistEntry['filterType']) {
  return value.replaceAll('_', ' ');
}

function watchlistDisplayValue(entry: PbsWatchlistEntry) {
  return ['atc_code', 'pbs_code', 'program_code'].includes(entry.filterType)
    ? entry.filterValue.toLocaleUpperCase()
    : entry.filterValue;
}

function daysSinceLabel(days: number) {
  if (days < 31) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function artgStatusClass(status: string) {
  const normalized = status.trim().toLocaleUpperCase();
  if (normalized.includes('CANCEL')) return 'status-error';
  if (normalized.includes('REGISTER') || normalized === 'ACTIVE') return 'status-success';
  return 'status-neutral';
}

type ArtgProductGroup = {
  groupKey: string;
  brandName: string;
  primary: ArtgEntry;
  entries: ArtgEntry[];
  strengths: Array<{ entry: ArtgEntry; label: string }>;
  pbsListed: boolean;
  needsPbsReview: boolean;
  pbsBrandNames: string[];
  statuses: string[];
};

function artgBrandName(productName: string) {
  return productName.trim().split(/\s+/)[0] || 'Unbranded product';
}

function artgStrengthLabel(entry: ArtgEntry) {
  const strength = `${entry.activeIngredient} ${entry.productName}`.match(/\b(\d+(?:[.,]\d+)?)\s*mg\b/i)?.[1];
  return strength ? `${strength.replace(',', '.')} mg` : 'Strength not supplied';
}

function artgBaseIngredient(activeIngredient: string) {
  return activeIngredient.replace(/,\s*quantity:.*$/i, '').trim();
}

function artgProductDescription(productName: string, brandName: string) {
  return productName.slice(brandName.length).replace(/\b\d+(?:[.,]\d+)?\s*mg\b/gi, '').replace(/\s+/g, ' ').trim();
}

function groupArtgEntries(entries: ArtgEntry[]): ArtgProductGroup[] {
  const groups = new Map<string, ArtgProductGroup>();
  for (const entry of entries) {
    const brandName = artgBrandName(entry.productName);
    const groupKey = [
      brandName.toLocaleLowerCase(),
      entry.matchedDrugId ?? 'unmatched',
      entry.sponsor.trim().toLocaleLowerCase(),
      entry.registrationDate,
    ].join('|');
    const existing = groups.get(groupKey);
    if (existing) {
      existing.entries.push(entry);
      existing.strengths.push({ entry, label: artgStrengthLabel(entry) });
      continue;
    }
    groups.set(groupKey, {
      groupKey,
      brandName,
      primary: entry,
      entries: [entry],
      strengths: [{ entry, label: artgStrengthLabel(entry) }],
      pbsListed: entry.pbsListed,
      needsPbsReview: entry.status.toLocaleUpperCase().includes('REGISTER') && !entry.pbsListed,
      pbsBrandNames: [...entry.pbsBrandNames],
      statuses: [entry.status],
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      strengths: [...group.strengths].sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { numeric: true })
        || left.entry.artgId.localeCompare(right.entry.artgId),
      ),
      pbsListed: group.entries.every((entry) => entry.pbsListed),
      needsPbsReview: group.entries.some((entry) =>
        entry.status.toLocaleUpperCase().includes('REGISTER') && !entry.pbsListed,
      ),
      pbsBrandNames: [...new Set(group.entries.flatMap((entry) => entry.pbsBrandNames))],
      statuses: [...new Set(group.entries.map((entry) => entry.status))],
    }))
    .sort((left, right) =>
      Number(right.needsPbsReview) - Number(left.needsPbsReview)
      || left.brandName.localeCompare(right.brandName),
    );
}

function benefitTypeLabel(code: string | null) {
  return ({ U: 'Unrestricted', R: 'Restricted', A: 'Authority required', S: 'Authority required (streamlined)' } as Record<string, string>)[code ?? ''] ?? 'Benefit type not supplied';
}

function StatCard({ label, value, detail, icon: Icon, tone = 'neutral', href }: { label: string; value: string | number; detail: string; icon: typeof BarChart3; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; href?: string }) {
  const toneClass = {
    neutral: 'bg-muted text-muted-foreground',
    info: 'bg-info/10 text-info',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-destructive/10 text-destructive',
  } as const;
  const content = <>
    <div className={`mb-7 flex h-9 w-9 items-center justify-center rounded-xl ${toneClass[tone]}`}><Icon className="h-4 w-4" /></div>
    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
    <div className="mt-1 flex items-baseline gap-2"><span className="text-3xl font-bold tabular-nums tracking-[-0.06em]" data-testid={`text-stat-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</span><span className="text-xs text-muted-foreground">{detail}</span></div>
  </>;
  const className = "group relative block overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-xs hover:border-info/35 hover:shadow-md";
  const testId = `card-stat-${label.toLowerCase().replaceAll(' ', '-')}`;
  return href
    ? <Link href={href} className={className} data-testid={testId} aria-label={`${label}: ${value}. Open relevant page`}>{content}</Link>
    : <div className={className} data-testid={testId}>{content}</div>;
}

function dashboardDate(value: string | null) {
  return formatDateOnly(value);
}

function dashboardFutureDate(period: DashboardPeriodSummary) {
  if (period.key === 'this_schedule') return undefined;
  const value = new Date();
  value.setUTCMonth(value.getUTCMonth() + (period.key === 'three_months' ? 3 : 12));
  return value.toISOString().slice(0, 10);
}

function dashboardHref(
  period: DashboardPeriodSummary,
  kind: 'new' | 'price' | 'delisted' | 'formulary' | 'amended' | 'upcoming' | 'artg',
  scheduleCode: number | null,
) {
  const params = new URLSearchParams();
  if (kind === 'upcoming') {
    params.set('from', new Date().toISOString().slice(0, 10));
    const to = dashboardFutureDate(period);
    if (to) params.set('to', to);
    return `/upcoming?${params.toString()}`;
  }
  if (kind === 'artg') {
    if (period.from) params.set('from', period.from);
    if (period.to) params.set('to', period.to);
    params.set('pbs', 'unlisted');
    return `/artg?${params.toString()}`;
  }
  if (period.key === 'this_schedule' && scheduleCode !== null) params.set('scheduleCode', String(scheduleCode));
  else {
    if (period.from) params.set('from', period.from);
    if (period.to) params.set('to', period.to);
  }
  params.set('changeType', kind === 'new' ? 'new_brand' : kind === 'price' ? 'price_change' : kind === 'delisted' ? 'delisted' : kind === 'formulary' ? 'formulary_change' : 'listing_amendment');
  if (kind === 'price') params.set('direction', 'decrease');
  return `/changes?${params.toString()}`;
}

function Dashboard() {
  const dashboard = useGetDashboard();
  const [periodKey, setPeriodKey] = useState<DashboardPeriodSummary['key']>('this_schedule');
  if (dashboard.isLoading) return <AppShell><PageHeading eyebrow="Workspace overview" title="Checking the current schedule…" description="Loading PBS movements, upcoming reductions, and ARTG registration context." /><QueryState kind="loading" /></AppShell>;
  if (dashboard.isError || !dashboard.data) return <AppShell><PageHeading eyebrow="Workspace overview" title="Schedule monitor unavailable" description="The dashboard could not confirm the current PBS reference snapshot." /><QueryState kind="error" onRetry={() => dashboard.refetch()} /></AppShell>;
  const summary = dashboard.data;
  const period = summary.periods.find((entry) => entry.key === periodKey) ?? summary.periods[0];
  const scheduleCode = summary.currentSchedule.scheduleCode;
  const totalChanges = period.counts.newBrands + period.counts.priceReductions + period.counts.delistings + period.counts.formularyChanges + period.counts.amendedListings;
  const title = !period.available
    ? summary.currentSchedule.status === 'in_progress' ? 'PBS update in progress' : 'PBS schedule data unavailable'
    : period.nextUpcomingReductionDate
      ? `Next reduction ${dashboardDate(period.nextUpcomingReductionDate)}`
      : `${totalChanges} changes in ${period.label.toLocaleLowerCase()}`;
  const description = !period.available
    ? 'Headline counts will appear after a complete current PBS reference snapshot is available.'
    : `Monitoring ${period.label.toLocaleLowerCase()} across PBS movements, predicted reductions, and ARTG registrations.`;
  const tiles = [
    { label: 'New brands', key: 'newBrands', detail: 'PBS additions', icon: PackagePlus, tone: 'success', kind: 'new' },
    { label: 'Price reductions', key: 'priceReductions', detail: 'downward changes', icon: TrendingDown, tone: 'info', kind: 'price' },
    { label: 'Delistings', key: 'delistings', detail: 'removed listings', icon: XCircle, tone: 'danger', kind: 'delisted' },
    { label: 'Formulary changes', key: 'formularyChanges', detail: 'access updates', icon: Filter, tone: 'warning', kind: 'formulary' },
    { label: 'Amended listings', key: 'amendedListings', detail: 'listing updates', icon: Pencil, tone: 'neutral', kind: 'amended' },
    { label: 'Upcoming reductions', key: 'upcomingReductions', detail: 'predicted events', icon: CalendarDays, tone: 'info', kind: 'upcoming' },
    { label: 'ARTG not PBS-listed', key: 'artgNotPbsListed', detail: 'registered products', icon: DatabaseZap, tone: 'warning', kind: 'artg' },
  ] as const;
  return <AppShell>
    <PageHeading eyebrow="Workspace overview" title={title} description={description} action={<Link href="/changes" className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md" data-testid="link-view-pbs-updates"><Bell className="h-4 w-4" /> View PBS updates</Link>} />
    <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
      <div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Reporting period</p><p className="mt-1 text-sm font-semibold text-foreground">{period.available ? `${period.label} · ${totalChanges} PBS change${totalChanges === 1 ? '' : 's'}` : 'Reference snapshot unavailable'}</p></div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Reporting period">
        {summary.periods.map((entry) => <button key={entry.key} type="button" onClick={() => setPeriodKey(entry.key)} className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-colors ${entry.key === period.key ? 'bg-primary text-primary-foreground' : 'border border-border bg-background text-muted-foreground hover:bg-muted'}`} data-testid={`button-dashboard-period-${entry.key}`}>{entry.label}</button>)}
      </div>
    </div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => <StatCard key={tile.label} label={tile.label} value={period.available ? period.counts[tile.key] : '—'} detail={period.available ? tile.detail : 'unavailable'} icon={tile.icon} tone={tile.tone} href={period.available ? dashboardHref(period, tile.kind, scheduleCode) : undefined} />)}
    </div>
    <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-recent-stock">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Private workspace</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Recent stock records</h2></div><Link href="/stock" className="flex items-center gap-1 text-xs font-bold text-info hover:gap-2" data-testid="link-view-all-stock">View all <ArrowRight className="h-3.5 w-3.5" /></Link></div>
        {summary.recentStock?.length ? <div className="divide-y divide-border">{summary.recentStock.slice(0, 5).map((item, index) => <div key={item.id} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/45" data-testid={`row-recent-stock-${item.id}`}><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary font-mono text-xs font-bold text-secondary-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{[item.brandName, item.strength, item.packSize ? `pack ${item.packSize}` : null].filter(Boolean).join(' · ')}</p><p className="mt-0.5 text-[11px] text-muted-foreground" title={`Internal listing ID: ${item.itemCode}`}>PBS {item.pbsCode ?? 'code not supplied'} · added {date(item.purchaseDate)}</p></div><div className="text-right"><p className="font-mono text-sm font-bold">{item.quantity} units</p><p className="mt-0.5 text-xs text-muted-foreground">{money(item.purchasePrice)} each</p></div></div>)}</div> : <div className="p-12"><QueryState kind="empty" /></div>}
      </section>
       <section className="rounded-2xl border border-border bg-sidebar p-6 text-sidebar-foreground shadow-sm" data-testid="card-reference-note">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><ShieldCheck className="h-5 w-5" /></div>
        <p className="mt-7 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-foreground/55">Snapshot context</p>
        <h2 className="mt-2 text-2xl font-bold tracking-[-0.05em]">{summary.currentSchedule.status === 'available' ? `Schedule ${summary.currentSchedule.scheduleCode}` : 'Reference context pending'}</h2>
        <p className="mt-3 text-sm leading-relaxed text-sidebar-foreground/65">{summary.currentSchedule.effectiveDate ? `Effective ${dashboardDate(summary.currentSchedule.effectiveDate)}. Counts are filtered to the period above.` : 'A complete PBS schedule snapshot is required before headline counts can be trusted.'}</p>
        <p className="mt-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-sidebar-foreground/45"><span className={`h-1.5 w-1.5 rounded-full ${summary.currentSchedule.status === 'available' ? 'bg-success' : summary.currentSchedule.status === 'in_progress' ? 'bg-warning' : 'bg-destructive'}`} />{summary.currentSchedule.status === 'available' ? 'Complete snapshot' : summary.currentSchedule.status === 'in_progress' ? 'Ingestion in progress' : 'Snapshot unavailable'}</p>
        <Link href="/pbs" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-sidebar-primary px-4 py-3 text-sm font-bold text-sidebar-primary-foreground hover:-translate-y-0.5" data-testid="link-reference-desk"><Search className="h-4 w-4" /> Open PBS directory</Link>
      </section>
    </div>
  </AppShell>;
}

function ArtgUploadControl() {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    if (!files.length) {
      setError('Choose a CSV or Excel export from the TGA ARTG search before uploading.');
      return;
    }
    const invalidFiles = files.filter((file) => !/\.(csv|xlsx|xls)$/i.test(file.name));
    if (invalidFiles.length) {
      setError(`Unsupported file${invalidFiles.length === 1 ? '' : 's'}: ${invalidFiles.map((file) => file.name).join(', ')}. Upload only .csv, .xlsx, or .xls TGA exports.`);
      return;
    }
    setNotice('');
    setError('');
    setIsUploading(true);
    setCompletedCount(0);
    let acceptedRecords = 0;
    let completed = 0;
    const failedFiles: string[] = [];
    try {
      for (const file of files) {
        try {
          const run = await uploadAdminArtgExport(file, {
            headers: { 'X-ARTG-File-Name': encodeURIComponent(file.name) },
          });
          acceptedRecords += run.recordsAccepted;
        } catch (uploadError) {
          failedFiles.push(`${file.name}: ${mutationError(uploadError, 'import failed').slice(0, 160)}`);
        } finally {
          completed += 1;
          setCompletedCount(completed);
        }
      }
      setFiles([]);
      if (completed > failedFiles.length) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListArtgEntriesQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetArtgImportStatusQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListAdminArtgImportRunsQueryKey() }),
        ]);
      }
      if (failedFiles.length) {
        setError(`${completed - failedFiles.length} file${completed - failedFiles.length === 1 ? '' : 's'} imported, but ${failedFiles.length} failed: ${failedFiles.join(', ')}. Successful imports were retained.`);
      } else {
        setNotice(`${files.length} file${files.length === 1 ? '' : 's'} imported: ${acceptedRecords.toLocaleString('en-AU')} tracked record${acceptedRecords === 1 ? '' : 's'} saved.`);
      }
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-info/20 bg-info/5 shadow-xs" data-testid="section-artg-upload">
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-info">ARTG data source</p>
          <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Upload a TGA export</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Add one or more CSV or Excel exports with ARTG ID, active ingredient, sponsor, start date, and product or good name.</p>
        </div>
        <div className="grid w-full min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end lg:w-[560px]">
          <label className="block min-w-0">
            <span className="sr-only">TGA ARTG export file</span>
            <input type="file" multiple accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setError(''); setNotice(''); }} className="block w-full cursor-pointer rounded-xl border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-info/10 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-info hover:file:bg-info/15" data-testid="input-artg-register-export-file" />
          </label>
          <button type="button" onClick={submit} disabled={!files.length || isUploading} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-upload-artg-register-export">{isUploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}{isUploading ? `Importing ${completedCount}/${files.length}…` : files.length > 1 ? `Import ${files.length} files` : 'Import export'}</button>
        </div>
      </div>
      {(notice || error || files.length > 0) && <div className="border-t border-info/15 px-5 py-3">{files.length > 0 && !isUploading && <p className="mb-2 text-xs font-semibold text-muted-foreground">{files.length} file{files.length === 1 ? '' : 's'} selected</p>}{error && <p className="flex items-start gap-2 text-xs font-semibold text-destructive" role="alert"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error} <Link href="/admin" className="ml-1 shrink-0 underline">Open Data updates</Link></p>}{notice && !error && <p className="flex items-start gap-2 text-xs font-semibold text-success" role="status"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</p>}</div>}
    </section>
  );
}

function ArtgDirectory() {
  const [location] = useLocation();
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), [location]);
  const [search, setSearch] = useState(() => initialParams.get('search') ?? '');
  const [status, setStatus] = useState(() => initialParams.get('status') ?? '');
  const [sponsor, setSponsor] = useState(() => initialParams.get('sponsor') ?? '');
  const [from, setFrom] = useState(() => initialParams.get('from') ?? '');
  const [to, setTo] = useState(() => initialParams.get('to') ?? '');
  const [pbsState, setPbsState] = useState<'all' | 'listed' | 'unlisted'>(() => {
    const value = initialParams.get('pbs');
    return value === 'listed' || value === 'unlisted' ? value : 'all';
  });
  const params = useMemo(() => ({ search: search || undefined, status: status || undefined, sponsor: sponsor || undefined, from: from || undefined, to: to || undefined, pbs: pbsState }), [search, status, sponsor, from, to, pbsState]);
  const query = useListArtgEntries(params);
  const importStatus = useGetArtgImportStatus({
    query: {
      queryKey: getGetArtgImportStatusQueryKey(),
      refetchOnWindowFocus: true,
    },
  });
  const entries = (query.data ?? []).filter((entry) =>
    pbsState === 'all' || (pbsState === 'listed' ? entry.pbsListed : !entry.pbsListed),
  );
  const productGroups = useMemo(() => groupArtgEntries(entries), [entries]);
  return <AppShell><PageHeading eyebrow="Reference library / ARTG" title="ARTG register" description="Review registered products against current PBS brand listings. Data is maintained through reviewed TGA CSV or Excel uploads." />
    {importStatus.data?.isStale && importStatus.data.lastSuccessfulImportAt && <div className="mb-5 flex items-start gap-3 rounded-2xl border-2 border-amber-700/45 bg-amber-50 px-5 py-4 text-amber-900 shadow-sm dark:border-warning/40 dark:bg-warning/10 dark:text-warning" role="alert" data-testid="warning-artg-stale"><Clock3 className="mt-0.5 h-5 w-5 shrink-0" /><div><h2 className="text-sm font-bold">ARTG data may be out of date</h2><p className="mt-1 text-xs font-medium leading-relaxed">The last successful import was <strong>{formatDateTime(importStatus.data.lastSuccessfulImportAt)}</strong>, more than 45 days ago. Import a current TGA export before relying on registration results.</p></div></div>}
    <ArtgUploadControl />
     <div className="control-row mb-5"><label className="flex h-11 flex-1 items-center gap-3 rounded-xl bg-muted/60 px-3 text-muted-foreground focus-within:ring-2 focus-within:ring-primary/15"><Search className="h-4 w-4" /><input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70" placeholder="Search ARTG ID, ingredient, sponsor or product" data-testid="input-artg-search" /></label><label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-primary/15"><Filter className="h-4 w-4 text-info" /><select value={status} onChange={(e) => setStatus(e.target.value)} className="h-full bg-transparent pr-5 text-sm font-semibold outline-none" data-testid="select-artg-status"><option value="">All statuses</option><option value="REGISTERED">Registered</option><option value="CANCELLED">Cancelled</option></select></label><label className="flex h-11 min-w-40 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-primary/15"><input value={sponsor} onChange={(e) => setSponsor(e.target.value)} className="h-full min-w-0 w-full bg-transparent text-sm font-semibold outline-none placeholder:text-muted-foreground" placeholder="Filter sponsor" aria-label="Filter by sponsor" data-testid="input-artg-sponsor" /></label><label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:ring-2 focus-within:ring-primary/15"><select value={pbsState} onChange={(e) => setPbsState(e.target.value as typeof pbsState)} className="h-full bg-transparent pr-5 text-sm font-semibold outline-none" data-testid="select-artg-pbs-status"><option value="all">All PBS matches</option><option value="unlisted">Not PBS-listed</option><option value="listed">PBS-listed</option></select></label><label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-xs font-semibold text-muted-foreground"><CalendarDays className="h-4 w-4 text-info" /><span className="hidden lg:inline">From</span><input value={from} onChange={(e) => setFrom(e.target.value)} type="date" className="min-w-0 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-artg-from" /></label><label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-xs font-semibold text-muted-foreground"><CalendarDays className="h-4 w-4 text-info" /><span className="hidden lg:inline">To</span><input value={to} onChange={(e) => setTo(e.target.value)} type="date" className="min-w-0 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-artg-to" /></label></div>
     {query.isLoading ? <QueryState kind="loading" /> : query.isError ? <QueryState kind="error" onRetry={() => query.refetch()} /> : !productGroups.length ? (
      importStatus.isLoading ? <QueryState kind="loading" /> : importStatus.isError ? <div className="rounded-2xl border border-dashed border-border p-10 text-center" data-testid="empty-artg-status-error"><h2 className="text-lg font-bold">ARTG data status is unavailable</h2><p className="mt-2 text-sm text-muted-foreground">We could not confirm whether an ARTG export has been imported.</p><button type="button" onClick={() => importStatus.refetch()} className="mt-4 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-bold hover:bg-muted">Try again</button></div> : !importStatus.data?.hasSuccessfulImport ? <div className="rounded-2xl border border-dashed border-info/30 bg-info/5 p-10 text-center" data-testid="empty-artg-no-import"><DatabaseZap className="mx-auto h-9 w-9 text-info" /><h2 className="mt-4 text-lg font-bold">No ARTG import has succeeded yet</h2><p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">The ARTG register is empty because no data-bearing TGA export has been imported. Use the upload control above to add the first reviewed register snapshot.</p><Link href="/admin" className="mt-5 inline-flex items-center gap-2 rounded-xl border border-info/25 bg-background px-4 py-2.5 text-sm font-bold text-info hover:bg-info/5" data-testid="link-artg-upload-screen">Open Data updates <ArrowRight className="h-4 w-4" /></Link></div> : <QueryState kind="empty" />
     ) : <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs"><div className="hidden grid-cols-[.95fr_1.35fr_1fr_1fr_.95fr_.8fr] gap-4 border-b border-border bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground lg:grid"><span>Product</span><span>Strengths / ARTG IDs</span><span>Ingredient</span><span>Sponsor</span><span>Registration / PBS</span><span>Status</span></div><div className="divide-y divide-border">{productGroups.map((group) => <div key={group.groupKey} className={`grid gap-4 px-5 py-5 transition-colors hover:bg-secondary/30 lg:grid-cols-[.95fr_1.35fr_1fr_1fr_.95fr_.8fr] lg:items-start lg:gap-5 ${group.needsPbsReview ? 'border-l-4 border-l-warning pl-4' : ''}`} data-testid={`group-artg-${group.brandName.toLocaleLowerCase().replaceAll(' ', '-')}`}><div className="min-w-0"><p className="text-base font-bold tracking-[-0.02em]">{group.brandName}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{artgProductDescription(group.primary.productName, group.brandName)}</p><p className="mt-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{group.entries.length} registered strength{group.entries.length === 1 ? '' : 's'}</p></div><div className="flex flex-wrap gap-2">{group.strengths.map(({ entry, label }) => <div key={entry.artgId} className="rounded-lg border border-border bg-background px-2.5 py-2" data-testid={`row-artg-${entry.artgId}`}><p className="font-mono text-xs font-bold text-info">{label}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">ARTG {entry.artgId}</p></div>)}</div><div className="min-w-0"><p className="text-sm font-semibold">{artgBaseIngredient(group.primary.activeIngredient)}</p></div><p className="min-w-0 text-xs text-muted-foreground lg:text-sm">{group.primary.sponsor}</p><div>{group.needsPbsReview ? <span className="status-badge border border-amber-700/45 bg-amber-50 text-amber-900 dark:border-warning/45 dark:bg-transparent dark:text-warning">NOT PBS-LISTED</span> : group.pbsListed ? <span className="status-badge status-success">PBS-LISTED</span> : <span className="status-badge status-neutral">NO PBS MATCH</span>}<p className="mt-2 inline-flex flex-wrap items-center gap-x-1.5 rounded-full border border-amber-700/45 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 dark:border-warning/45 dark:bg-transparent dark:text-warning">Registered {date(group.primary.registrationDate)} · {daysSinceLabel(group.primary.daysSinceRegistration)}</p>{group.pbsListed && group.pbsBrandNames.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">{group.pbsBrandNames.join(', ')}</p>}</div><div className="flex flex-wrap gap-2">{group.statuses.map((statusLabel) => <span key={statusLabel} className={`status-badge ${artgStatusClass(statusLabel)}`}>{statusLabel}</span>)}</div></div>)}</div></div>}
  </AppShell>;
}

type StockForm = { itemCode: string; quantity: string; purchasePrice: string; purchaseDate: string; invoiceReference: string };
const blankStock: StockForm = { itemCode: '', quantity: '0', purchasePrice: '0', purchaseDate: new Date().toISOString().slice(0, 10), invoiceReference: '' };

function itemLabel(item: Pick<PbsItem, 'brandName' | 'strength' | 'packSize'>) {
  return [item.brandName, item.strength, item.packSize ? `pack ${item.packSize}` : null].filter(Boolean).join(' · ');
}

function mutationError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function StockDialog({ initial, existingRows, onClose, onSaved }: { initial?: StockExposureLine; existingRows: StockExposureLine[]; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [form, setForm] = useState<StockForm>(initial ? { itemCode: initial.itemCode, quantity: String(initial.quantity), purchasePrice: String(initial.purchasePrice), purchaseDate: initial.purchaseDate.slice(0, 10), invoiceReference: initial.invoiceReference ?? '' } : blankStock);
  const [itemSearch, setItemSearch] = useState(initial ? itemLabel(initial) : '');
  const [selectedItem, setSelectedItem] = useState<Pick<PbsItem, 'itemCode' | 'liItemId' | 'pbsCode' | 'brandName' | 'strength' | 'packSize' | 'benefitTypeCode' | 'maximumQuantityUnits'> | null>(initial ? { itemCode: initial.itemCode, liItemId: initial.itemCode, pbsCode: initial.pbsCode, brandName: initial.brandName, strength: initial.strength, packSize: initial.packSize, benefitTypeCode: initial.benefitTypeCode, maximumQuantityUnits: initial.maximumQuantityUnits } : null);
  const [showItemResults, setShowItemResults] = useState(false);
  const [error, setError] = useState('');
  const create = useCreateStock();
  const update = useUpdateStock();
  const itemQuery = useListPbsItems(
    { search: itemSearch.trim(), limit: 20 },
    { query: { queryKey: getListPbsItemsQueryKey({ search: itemSearch.trim(), limit: 20 }), enabled: itemSearch.trim().length >= 2 } },
  );
  const pending = create.isPending || update.isPending;
  const duplicateBatch = !initial && Boolean(form.itemCode.trim()) && existingRows.some((row) =>
    row.itemCode === form.itemCode.trim()
    && row.purchasePrice === Number(form.purchasePrice)
    && row.purchaseDate.slice(0, 10) === form.purchaseDate,
  );
  const set = (key: keyof StockForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => {
    if (!form.itemCode.trim() || Number(form.quantity) < 0 || Number(form.purchasePrice) < 0 || !form.purchaseDate) { setError('Choose a PBS item, then enter a non-negative quantity and price with a purchase date.'); return; }
    const baseData = { itemCode: form.itemCode.trim(), quantity: Number(form.quantity), purchasePrice: Number(form.purchasePrice), purchaseDate: form.purchaseDate };
    const options = {
      onSuccess: async () => {
        setForm(blankStock);
        setItemSearch('');
        await onSaved(initial ? 'Stock record updated. Exposure recalculated.' : 'Stock record added. Exposure calculated.');
        onClose();
      },
      onError: (mutationFailure: unknown) => setError(mutationError(mutationFailure, 'The record could not be saved. Please try again.')),
    };
    if (initial) update.mutate({ id: initial.id, data: { ...baseData, invoiceReference: form.invoiceReference.trim() || null } }, options);
    else create.mutate({ data: { ...baseData, ...(form.invoiceReference.trim() ? { invoiceReference: form.invoiceReference.trim() } : {}) } }, options);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-sidebar/35 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" data-testid="dialog-stock-form">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close form" data-testid="button-close-stock-backdrop" />
      <div className="relative max-h-[94dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-border bg-card p-6 shadow-2xl sm:rounded-3xl">
        <button type="button" onClick={onClose} className="absolute right-5 top-5 rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="Close" data-testid="button-close-stock-form"><X className="h-4 w-4" /></button>
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{initial ? 'Edit private record' : 'New private record'}</p>
        <h2 className="mt-2 pr-8 text-2xl font-bold tracking-[-0.05em]">{initial ? 'Update stock' : 'Add stock'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Only your signed-in pharmacy can see these records.</p>
        <div className="mt-6 space-y-4">
          <div className="relative">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold">PBS item</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <input value={itemSearch} onFocus={() => setShowItemResults(true)} onChange={(e) => { setItemSearch(e.target.value); set('itemCode', ''); setSelectedItem(null); setShowItemResults(true); }} placeholder="Search brand, drug, strength or PBS code" className="control-input pl-9" data-testid="input-stock-item-search" />
              </div>
            </label>
            {showItemResults && itemSearch.trim().length >= 2 && (
              <div className="absolute left-0 right-0 top-[4.75rem] z-10 max-h-60 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
                {itemQuery.isLoading ? <p className="px-3 py-4 text-xs text-muted-foreground">Searching PBS items…</p> : itemQuery.isError ? <p className="px-3 py-4 text-xs text-destructive">PBS item search is unavailable.</p> : !itemQuery.data?.length ? <p className="px-3 py-4 text-xs text-muted-foreground">No matching PBS items.</p> : itemQuery.data.map((item) => (
                   <button type="button" key={item.itemCode} onClick={() => { set('itemCode', item.itemCode); setSelectedItem(item); setItemSearch(itemLabel(item)); setShowItemResults(false); setError(''); }} className="block w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted" data-testid={`option-stock-item-${item.itemCode}`} title={`Internal listing ID: ${item.liItemId ?? item.itemCode}`}>
                     <span className="block text-sm font-bold">{itemLabel(item)}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><span>PBS {item.pbsCode ?? 'code not supplied'} · {benefitTypeLabel(item.benefitTypeCode)}</span><span className="rounded-md bg-info/10 px-1.5 py-0.5 font-mono font-bold text-info">Max {item.maximumQuantityUnits ?? '—'} units</span></span>
                  </button>
                ))}
              </div>
            )}
              {form.itemCode && selectedItem && <div className="mt-2 rounded-xl border border-info/15 bg-info/5 px-3 py-2.5" title={`Internal listing ID: ${selectedItem.liItemId ?? selectedItem.itemCode}`}><p className="text-sm font-bold">{itemLabel(selectedItem)}</p><div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><span>PBS {selectedItem.pbsCode ?? 'code not supplied'} · {benefitTypeLabel(selectedItem.benefitTypeCode)}</span><span className="rounded-md bg-info/10 px-1.5 py-0.5 font-mono font-bold text-info">Max {selectedItem.maximumQuantityUnits ?? '—'} units</span></div></div>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="field-label">Quantity</span><input type="number" min="0" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} className="control-input" data-testid="input-stock-quantity" /></label>
            <label className="block"><span className="field-label">Purchase price (AUD)</span><input type="number" min="0" step="0.01" value={form.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} className="control-input" data-testid="input-stock-price" /></label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="field-label">Purchase date</span><input type="date" value={form.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} className="control-input" data-testid="input-stock-date" /></label>
            <label className="block"><span className="field-label">Invoice reference <span className="font-normal text-muted-foreground">(optional)</span></span><div className="relative"><ReceiptText className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input value={form.invoiceReference} onChange={(e) => set('invoiceReference', e.target.value)} maxLength={120} placeholder="e.g. INV-2048" className="control-input pl-9" data-testid="input-stock-invoice-reference" /></div></label>
          </div>
        </div>
        {duplicateBatch && <p className="mt-4 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs font-semibold text-warning" role="status" data-testid="status-stock-duplicate-warning">An identical purchase batch already exists for this item, price and date. You can still save it if this is intentional.</p>}
        {error && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" data-testid="status-stock-form-error">{error}</p>}
        <div className="mt-7 flex justify-end gap-3"><button type="button" onClick={onClose} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-bold text-muted-foreground hover:bg-muted" data-testid="button-cancel-stock">Cancel</button><button type="button" onClick={submit} disabled={pending} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-save-stock">{pending && <LoaderCircle className="h-4 w-4 animate-spin" />}{initial ? 'Save changes' : 'Add record'}</button></div>
      </div>
    </div>
  );
}

function DeleteStockDialog({ row, pending, error, onClose, onConfirm }: { row: StockExposureLine; pending: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-sidebar/35 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="alertdialog" aria-modal="true" aria-labelledby="delete-stock-title" data-testid="dialog-delete-stock">
    <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} disabled={pending} aria-label="Close delete confirmation" data-testid="button-close-delete-stock-backdrop" />
    <div className="relative w-full max-w-md rounded-t-3xl border border-border bg-card p-6 shadow-2xl sm:rounded-3xl">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"><Trash2 className="h-5 w-5" /></div>
      <p className="mt-5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-destructive">Remove purchase batch</p>
      <h2 id="delete-stock-title" className="mt-2 text-2xl font-bold tracking-[-0.05em]">Delete this stock record?</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">This permanently removes the selected purchase batch from your private stock workspace. The grouped quantity and exposure will be recalculated.</p>
      <div className="mt-5 rounded-xl border border-border bg-muted/45 px-3 py-2.5"><p className="text-sm font-bold">{itemLabel(row)}</p><p className="mt-1 text-xs text-muted-foreground">PBS {row.pbsCode ?? 'code not supplied'} · {row.quantity} units · {money(row.purchasePrice)} each</p></div>
      {error && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" role="alert">{error}</p>}
      <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={pending} className="rounded-xl px-4 py-2.5 text-sm font-bold text-muted-foreground hover:bg-muted disabled:opacity-50" data-testid="button-cancel-delete-stock">Keep record</button>
        <button type="button" onClick={onConfirm} disabled={pending} className="inline-flex items-center justify-center gap-2 rounded-xl bg-destructive px-5 py-2.5 text-sm font-bold text-destructive-foreground hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-confirm-delete-stock">{pending && <LoaderCircle className="h-4 w-4 animate-spin" />}Delete record</button>
      </div>
    </div>
  </div>;
}

function DeleteWatchlistDialog({ entry, pending, error, onClose, onConfirm }: { entry: PbsWatchlistEntry; pending: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-sidebar/35 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="alertdialog" aria-modal="true" aria-labelledby="delete-watchlist-title" data-testid="dialog-delete-watchlist">
    <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} disabled={pending} aria-label="Close delete confirmation" data-testid="button-close-delete-watchlist-backdrop" />
    <div className="relative w-full max-w-md rounded-t-3xl border border-border bg-card p-6 shadow-2xl sm:rounded-3xl">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"><Trash2 className="h-5 w-5" /></div>
      <p className="mt-5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-destructive">Remove watchlist filter</p>
      <h2 id="delete-watchlist-title" className="mt-2 text-2xl font-bold tracking-[-0.05em]">Remove this watchlist filter?</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">This removes the filter from future PBS ingestion runs. Existing reference data and previous ingestion runs will not be changed.</p>
      <div className="mt-5 rounded-xl border border-border bg-muted/45 px-3 py-2.5"><p className="text-sm font-bold">{entry.filterValue}</p><p className="mt-1 text-xs text-muted-foreground">{entry.filterType} · {entry.enabled ? 'Enabled' : 'Disabled'}</p></div>
      {error && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" role="alert">{error}</p>}
      <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={pending} className="rounded-xl px-4 py-2.5 text-sm font-bold text-muted-foreground hover:bg-muted disabled:opacity-50" data-testid="button-cancel-delete-watchlist">Keep filter</button>
        <button type="button" onClick={onConfirm} disabled={pending} className="inline-flex items-center justify-center gap-2 rounded-xl bg-destructive px-5 py-2.5 text-sm font-bold text-destructive-foreground hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-confirm-delete-watchlist">{pending && <LoaderCircle className="h-4 w-4 animate-spin" />}Remove filter</button>
      </div>
    </div>
  </div>;
}

function StockQuantityControl({ row, onSaved, onFailed }: { row: StockExposureLine; onSaved: (message: string) => Promise<void>; onFailed: (message: string) => void }) {
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [soldQuantity, setSoldQuantity] = useState('');
  const update = useUpdateStock();

  useEffect(() => setQuantity(String(row.quantity)), [row.quantity]);

  const saveQuantity = (nextQuantity: number, message = 'Quantity updated. Exposure recalculated.') => {
    if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
      setQuantity(String(row.quantity));
      onFailed('Quantity must be a whole number of zero or more.');
      return;
    }
    if (nextQuantity === row.quantity) {
      setQuantity(String(row.quantity));
      return;
    }
    update.mutate(
      { id: row.id, data: { quantity: nextQuantity } },
      {
        onSuccess: async () => {
          setQuantity(String(nextQuantity));
          await onSaved(message);
        },
        onError: (mutationFailure) => {
          setQuantity(String(row.quantity));
          onFailed(mutationError(mutationFailure, 'The quantity could not be updated.'));
        },
      },
    );
  };

  const sold = (amount: number) => {
    const currentQuantity = Number(quantity);
    if (!Number.isFinite(currentQuantity)) {
      onFailed('Enter a valid quantity before recording a sale.');
      return;
    }
    const nextQuantity = Math.max(0, Math.trunc(currentQuantity) - amount);
    saveQuantity(nextQuantity, `${Math.min(amount, Math.trunc(currentQuantity))} sold. Exposure recalculated.`);
  };

  const recordCustomSale = () => {
    const amount = Number(soldQuantity);
    if (!Number.isInteger(amount) || amount < 1) {
      onFailed('Enter a whole number of at least 1 to record a sale.');
      return;
    }
    sold(amount);
    setSoldQuantity('');
  };

  return <div className="rounded-xl bg-muted/55 p-3 lg:bg-transparent lg:p-0">
    <label className="block text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground" htmlFor={`quantity-${row.id}`}>Quantity</label>
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <input id={`quantity-${row.id}`} type="number" min="0" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} onBlur={() => saveQuantity(Number(quantity))} onKeyDown={(event) => { if (event.key === 'Enter') { event.currentTarget.blur(); } }} disabled={update.isPending} className="h-9 w-20 rounded-lg border border-input bg-background px-2 font-mono text-sm font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50" aria-label={`Quantity for ${row.brandName}`} data-testid={`input-stock-quantity-${row.id}`} />
      <button type="button" onClick={() => sold(1)} disabled={update.isPending || Number(quantity) <= 0} className="h-9 rounded-lg border border-border bg-background px-2.5 text-[11px] font-bold text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40" data-testid={`button-sold-one-${row.id}`}>Sold 1</button>
      <button type="button" onClick={() => sold(20)} disabled={update.isPending || Number(quantity) <= 0} className="h-9 rounded-lg border border-border bg-background px-2.5 text-[11px] font-bold text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40" data-testid={`button-sold-twenty-${row.id}`}>Sold 20</button>
       <div className="flex items-center gap-1">
         <input type="number" min="1" step="1" value={soldQuantity} onChange={(event) => setSoldQuantity(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') recordCustomSale(); }} disabled={update.isPending || Number(quantity) <= 0} placeholder="Qty to sell" className="h-9 w-24 rounded-lg border border-input bg-background px-2 text-xs font-bold outline-none placeholder:font-normal focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground" aria-label={`Custom sale quantity for ${row.brandName}`} data-testid={`input-stock-sold-quantity-${row.id}`} />
         <button type="button" onClick={recordCustomSale} disabled={update.isPending || Number(quantity) <= 0 || !soldQuantity.trim()} className="h-9 rounded-lg border border-primary bg-primary px-2.5 text-[11px] font-bold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground" data-testid={`button-record-sale-${row.id}`}>Record sale</button>
      </div>
      {update.isPending && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" />}
    </div>
  </div>;
}

type StockItemGroup = {
  itemCode: string;
  exemplar: StockExposureLine;
  batches: StockExposureLine[];
  totalQuantity: number;
  totalExposure: number;
};

function groupStockRows(rows: StockExposureLine[]): StockItemGroup[] {
  const grouped = new Map<string, StockItemGroup>();
  for (const row of rows) {
    const existing = grouped.get(row.itemCode);
    if (existing) {
      existing.batches.push(row);
      existing.totalQuantity += row.quantity;
      existing.totalExposure = Number((existing.totalExposure + row.totalExposure).toFixed(2));
    } else {
      grouped.set(row.itemCode, {
        itemCode: row.itemCode,
        exemplar: row,
        batches: [row],
        totalQuantity: row.quantity,
        totalExposure: row.totalExposure,
      });
    }
  }
  return [...grouped.values()].sort((left, right) =>
    right.totalExposure - left.totalExposure
    || left.exemplar.brandName.localeCompare(right.exemplar.brandName)
    || (left.exemplar.pbsCode ?? '').localeCompare(right.exemplar.pbsCode ?? ''),
  );
}

type PredictionState = 'loss' | 'change' | 'none';

function predictionState(prediction: StockExposureLine['prediction'], totalExposure: number): PredictionState {
  if (!prediction) return 'none';
  return totalExposure > 0 ? 'loss' : 'change';
}

function PredictionStatus({ prediction, purchasePrice, totalExposure }: { prediction: StockExposureLine['prediction']; purchasePrice: string; totalExposure: number }) {
  const state = predictionState(prediction, totalExposure);
  const styles = {
    loss: 'border-destructive/25 bg-destructive/8 text-destructive',
    change: 'border-info/20 bg-info/6 text-info',
    none: 'border-border bg-muted/45 text-muted-foreground',
  } as const;
  const labels = {
    loss: 'Predicted loss',
    change: 'Predicted change · no loss',
    none: 'No prediction',
  } as const;
  return <div className={`rounded-lg border px-2.5 py-2 ${styles[state]}`} data-testid={`status-prediction-${state}`}>
    <p className="text-[10px] font-bold uppercase tracking-[0.08em]">{labels[state]}</p>
    {prediction ? <><p className="mt-1 text-xs font-bold tabular-nums">{date(prediction.predictedDate)}: {purchasePrice} → {money(prediction.predictedNewPrice)}</p>{state === 'loss' && <p className="mt-1 text-[11px] font-semibold">Exposure: {money(totalExposure)}</p>}</> : <p className="mt-1 text-xs">No future price comparison available</p>}
  </div>;
}

function StockPage() {
  const queryClient = useQueryClient();
  const stock = useListStock();
  const remove = useDeleteStock();
  const [dialog, setDialog] = useState<'new' | StockExposureLine | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<StockExposureLine | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [notice, setNotice] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);
  const [expandedItemCodes, setExpandedItemCodes] = useState<Set<string>>(() => new Set());
  const response = stock.data as StockExposureResponse | undefined;
  const rows = response?.rows ?? [];
  const summary = response?.summary;
  const itemGroups = useMemo(() => groupStockRows(rows), [rows]);
  const atRiskBatchCount = rows.filter((row) => row.totalExposure > 0).length;
  const totalUnits = rows.reduce((total, row) => total + row.quantity, 0);
  const showNotice = (message: string, tone: 'success' | 'error') => {
    setNotice({ message, tone });
    window.setTimeout(() => setNotice(null), 4200);
  };
  const saved = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListStockQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    ]);
    showNotice(message, 'success');
  };
  const failed = (message: string) => showNotice(message, 'error');
  const deleteRow = (row: StockExposureLine) => {
    setDeleteError('');
    setDeleteCandidate(row);
  };
  const confirmDelete = () => {
    if (!deleteCandidate) return;
    setDeleteError('');
    remove.mutate(
      { id: deleteCandidate.id },
      {
        onSuccess: async () => {
          setDeleteCandidate(null);
          await saved('Stock record deleted. Exposure recalculated.');
        },
        onError: (mutationFailure) => {
          const message = mutationError(mutationFailure, 'The stock record could not be deleted.');
          setDeleteError(message);
          failed(message);
        },
      },
    );
  };
  const toggleItem = (itemCode: string) => setExpandedItemCodes((current) => {
    const next = new Set(current);
    if (next.has(itemCode)) next.delete(itemCode);
    else next.add(itemCode);
    return next;
  });
  const renderDateGroup = (predictedDate: string, lineCount: number, totalExposure: number) => <div key={predictedDate} className="flex min-w-[220px] items-center gap-3 rounded-xl border border-border bg-background px-4 py-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><CalendarDays className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-bold">{date(predictedDate)}</p><p className="text-xs text-muted-foreground">{lineCount} predicted purchase {lineCount === 1 ? 'batch' : 'batches'}</p></div><p className={`font-mono text-sm font-bold ${totalExposure > 0 ? 'text-destructive' : 'text-primary'}`}>{totalExposure > 0 ? money(totalExposure) : 'No loss'}</p></div>;
  const renderBatch = (row: StockExposureLine) => <div key={row.id} className="grid gap-4 border-t border-border/70 bg-muted/20 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto_.9fr_auto] lg:items-center" data-testid={`row-stock-${row.id}`}><div><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Purchase batch</p><p className="mt-1 text-sm font-bold">{money(row.purchasePrice)} each · {date(row.purchaseDate)}</p><p className="mt-1 text-xs text-muted-foreground">{row.invoiceReference ? <span className="inline-flex items-center gap-1"><ReceiptText className="h-3 w-3" />{row.invoiceReference}</span> : 'No invoice reference'}</p></div><StockQuantityControl row={row} onSaved={saved} onFailed={failed} /><PredictionStatus prediction={row.prediction} purchasePrice={money(row.purchasePrice)} totalExposure={row.totalExposure} /><div className="flex gap-1 lg:justify-end"><button type="button" onClick={() => setDialog(row)} className="rounded-lg p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary" aria-label={`Edit ${row.brandName} purchase batch`} data-testid={`button-edit-stock-${row.id}`}><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => deleteRow(row)} disabled={remove.isPending} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50" aria-label={`Delete ${row.brandName} purchase batch`} data-testid={`button-delete-stock-${row.id}`}><Trash2 className="h-4 w-4" /></button></div></div>;
  const renderItemGroup = (group: StockItemGroup) => {
    const item = group.exemplar;
    const isExpanded = expandedItemCodes.has(group.itemCode);
    const purchasePrices = group.batches.map((batch) => batch.purchasePrice);
    const minimumPurchasePrice = Math.min(...purchasePrices);
    const maximumPurchasePrice = Math.max(...purchasePrices);
    const purchasePriceLabel = minimumPurchasePrice === maximumPurchasePrice ? money(minimumPurchasePrice) : `${money(minimumPurchasePrice)}–${money(maximumPurchasePrice)}`;
     return <article key={group.itemCode} data-testid={`group-stock-${group.itemCode}`}><button type="button" onClick={() => toggleItem(group.itemCode)} className="grid w-full gap-4 px-5 py-5 text-left hover:bg-secondary/20 lg:grid-cols-[minmax(0,1.35fr)_.55fr_.95fr_auto] lg:items-center" aria-expanded={isExpanded} title={`Internal listing ID: ${group.itemCode}`}><div className="min-w-0"><p className="text-base font-bold">{[item.brandName, item.strength, item.packSize ? `pack ${item.packSize}` : null, item.maximumQuantityUnits !== null && item.maximumQuantityUnits !== undefined ? `max qty ${item.maximumQuantityUnits}` : null].filter(Boolean).join(' · ')}</p><p className="mt-1 text-xs text-muted-foreground">{item.drugName} · PBS {item.pbsCode ?? 'code not supplied'} · {benefitTypeLabel(item.benefitTypeCode)}</p><p className="mt-1 text-[11px] text-muted-foreground">{item.formulary}</p></div><div><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">On hand</p><p className="mt-1 text-lg font-bold tabular-nums">{group.totalQuantity}</p><p className="text-[11px] text-muted-foreground">{group.batches.length} purchase {group.batches.length === 1 ? 'batch' : 'batches'}</p></div><div><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Price outlook</p><PredictionStatus prediction={item.prediction} purchasePrice={purchasePriceLabel} totalExposure={group.totalExposure} /></div><ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} /></button>{isExpanded && <div>{group.batches.map(renderBatch)}</div>}</article>;
  };
  return <AppShell>
    <PageHeading eyebrow="Private workspace / stock" title="Stock exposure" description="See which private stock lines are most exposed to upcoming PBS price reductions." action={<button type="button" onClick={() => setDialog('new')} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md" data-testid="button-add-stock"><Plus className="h-4 w-4" /> Add stock</button>} />
    {notice && <div className={`mb-5 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${notice.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400' : 'border-destructive/25 bg-destructive/10 text-destructive'}`} role={notice.tone === 'success' ? 'status' : 'alert'} data-testid={`status-stock-${notice.tone}`}>{notice.tone === 'success' ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}{notice.message}</div>}
    {stock.isLoading ? <QueryState kind="loading" /> : stock.isError ? <QueryState kind="error" onRetry={() => stock.refetch()} /> : !rows.length ? <div className="grid-paper rounded-2xl border border-dashed border-border p-10 sm:p-16"><div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-info/10 text-info"><Boxes className="h-6 w-6" /></div><h2 className="mt-5 text-xl font-bold tracking-[-0.04em]">Your stock workspace is clear.</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Add a private PBS stock record to see quantities, predictions, and potential exposure in one place.</p><button type="button" onClick={() => setDialog('new')} className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground hover:-translate-y-0.5" data-testid="button-add-first-stock"><Plus className="h-4 w-4" /> Add first record</button></div></div> : <>
       <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Total exposure" value={money(summary?.totalExposure ?? 0)} detail="potential loss" icon={TrendingDown} tone={(summary?.totalExposure ?? 0) > 0 ? 'danger' : 'neutral'} /><StatCard label="At-risk batches" value={summary?.totalAtRiskLines ?? atRiskBatchCount} detail="purchase records" icon={CircleAlert} tone={(summary?.totalAtRiskLines ?? atRiskBatchCount) > 0 ? 'warning' : 'neutral'} /><StatCard label="Stock units" value={totalUnits} detail="on hand" icon={Boxes} tone="info" /><StatCard label="Prediction dates" value={summary?.exposureByDate.length ?? 0} detail="upcoming dates" icon={CalendarDays} tone="info" /></div>
       <section className="mt-6 rounded-xl border border-border bg-card shadow-xs" data-testid="section-exposure-by-date">
         <div className="flex flex-wrap items-center gap-3 px-4 py-3">
           <div className="mr-2 shrink-0"><span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Predictions by date</span><span className="ml-2 text-xs text-muted-foreground">Forward view</span></div>
           <div className="flex min-w-0 flex-1 flex-wrap gap-2">{summary?.exposureByDate.length ? summary.exposureByDate.map((group) => renderDateGroup(group.predictedDate, group.lineCount, group.totalExposure)) : <p className="text-xs text-muted-foreground">No future predictions are linked to current stock.</p>}</div>
         </div>
      </section>
      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-stock-exposure"><div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Consolidated inventory</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Stock items</h2></div><p className="text-xs text-muted-foreground">{itemGroups.length} PBS {itemGroups.length === 1 ? 'item' : 'items'} · {rows.length} purchase {rows.length === 1 ? 'batch' : 'batches'}</p></div><div className="divide-y divide-border">{itemGroups.map(renderItemGroup)}</div></section>
    </>}
     {dialog && <StockDialog initial={dialog === 'new' ? undefined : dialog} existingRows={rows} onClose={() => setDialog(null)} onSaved={saved} />}
    {deleteCandidate && <DeleteStockDialog row={deleteCandidate} pending={remove.isPending} error={deleteError} onClose={() => { if (!remove.isPending) { setDeleteCandidate(null); setDeleteError(''); } }} onConfirm={confirmDelete} />}
  </AppShell>;
}

function IngestionStatus({ status }: { status: AdminIngestionRun['status'] }) {
  const styles = {
    queued: 'status-neutral',
    running: 'status-running',
    completed: 'status-success',
    failed: 'status-error',
    cancelled: 'status-warning',
  } as const;
  return <span className={`status-badge ${styles[status]}`}>{status}</span>;
}

function sourceHealthStatusClass(status: AdminPbsSourceStatus['status']) {
  return status === 'OK'
    ? 'status-success'
    : status === 'NO_RELEVANT_ROWS'
      ? 'status-neutral'
      : status === 'COVERAGE_GAP'
        ? 'status-error'
      : status === 'STALE'
        ? 'status-warning'
        : 'status-error';
}

function sourceHealthIcon(status: AdminPbsSourceStatus['status']) {
  return status === 'OK'
    ? CheckCircle2
    : status === 'NO_RELEVANT_ROWS'
      ? CircleAlert
      : status === 'COVERAGE_GAP'
        ? CircleAlert
      : status === 'STALE'
        ? Clock3
        : XCircle;
}

function sourceHealthDate(value: string | null | undefined) {
  return value ? date(value) : 'Not recorded';
}

function PbsSourceHealthPanel({ ingestionActive }: { ingestionActive: boolean }) {
  const sourceStatuses = useListAdminPbsSourceStatus({
    query: {
      queryKey: getListAdminPbsSourceStatusQueryKey(),
      refetchInterval: ingestionActive ? 15_000 : false,
      refetchOnWindowFocus: true,
    },
  });
  const rows = sourceStatuses.data ?? [];
  const counts = {
    OK: rows.filter((row) => row.status === 'OK').length,
    NO_RELEVANT_ROWS: rows.filter((row) => row.status === 'NO_RELEVANT_ROWS').length,
    COVERAGE_GAP: rows.filter((row) => row.status === 'COVERAGE_GAP').length,
    STALE: rows.filter((row) => row.status === 'STALE').length,
    FAILED: rows.filter((row) => row.status === 'FAILED').length,
  };

  return <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" aria-live="polite" data-testid="section-pbs-source-health">
    <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Published PBS sources</p>
        <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Source health</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Freshness and parser health for every published file that can inform the workspace.</p>
      </div>
      {!sourceStatuses.isLoading && !sourceStatuses.isError && <div className="flex flex-wrap gap-2 text-[11px] font-bold">
        <span className="status-badge status-success">{counts.OK} OK</span>
        <span className="status-badge status-neutral">{counts.NO_RELEVANT_ROWS} no relevant rows</span>
        <span className="status-badge status-error">{counts.COVERAGE_GAP} coverage gaps</span>
        <span className="status-badge status-warning">{counts.STALE} stale</span>
        <span className="status-badge status-error">{counts.FAILED} failed</span>
      </div>}
    </div>
    {sourceStatuses.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : sourceStatuses.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => sourceStatuses.refetch()} /></div> : !rows.length ? <div className="p-8 text-sm text-muted-foreground">No published PBS source definitions are available.</div> : <div className="divide-y divide-border">
      <div className="hidden grid-cols-[1.2fr_.85fr_.8fr_.8fr_1.25fr] gap-4 bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground lg:grid">
        <span>Source</span><span>Last successful pull</span><span>Published</span><span>Next expected</span><span>Status / detail</span>
      </div>
      {rows.map((row) => {
        const Icon = sourceHealthIcon(row.status);
        return <div key={row.sourceKey} className="grid gap-3 px-5 py-4 transition-colors hover:bg-muted/25 lg:grid-cols-[1.2fr_.85fr_.8fr_.8fr_1.25fr] lg:items-center lg:gap-4" data-testid={`row-pbs-source-health-${row.sourceKey}`}>
          <div className="min-w-0">
            <div className="flex items-start gap-2">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${row.status === 'OK' ? 'text-success' : row.status === 'STALE' ? 'text-warning' : row.status === 'FAILED' || row.status === 'COVERAGE_GAP' ? 'text-destructive' : 'text-muted-foreground'}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{row.label}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.sourceFamily} · {row.cadenceLabel}</p>
              </div>
            </div>
            <p className="mt-2 truncate pl-6 font-mono text-[10px] text-muted-foreground" title={row.lastSuccessfulFileSha256 ?? row.latestFileSha256 ?? undefined}>{row.lastSuccessfulFileName ?? row.latestFileName ?? 'No file identity recorded'}</p>
          </div>
          <div className="pl-6 lg:pl-0"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground lg:hidden">Last successful pull</p><p className="mt-0.5 text-xs font-semibold">{sourceHealthDate(row.lastSuccessfulPullAt)}</p><p className="mt-0.5 text-[10px] text-muted-foreground">Parsed {sourceHealthDate(row.lastSuccessfulParseAt)}</p></div>
          <div className="pl-6 lg:pl-0"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground lg:hidden">Published</p><p className="mt-0.5 text-xs font-semibold">{sourceHealthDate(row.publicationDate)}</p></div>
          <div className="pl-6 lg:pl-0"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground lg:hidden">Next expected</p><p className="mt-0.5 text-xs font-semibold">{sourceHealthDate(row.nextExpectedRefreshDate)}</p>{row.staleAfterDate && <p className="mt-0.5 text-[10px] text-muted-foreground">Stale after {date(row.staleAfterDate)}</p>}</div>
          <div className="pl-6 lg:pl-0"><span className={`status-badge ${sourceHealthStatusClass(row.status)}`}>{row.status === 'NO_RELEVANT_ROWS' ? 'NO RELEVANT ROWS' : row.status === 'COVERAGE_GAP' ? 'COVERAGE GAP' : row.status}</span><p className={`mt-1 text-xs leading-relaxed ${row.status === 'FAILED' || row.status === 'COVERAGE_GAP' ? 'text-destructive' : row.status === 'STALE' ? 'text-warning' : 'text-muted-foreground'}`}>{sourceHealthDetail(row)}</p>{row.latestAttemptAt && <p className="mt-1 text-[10px] text-muted-foreground">Latest attempt {formatDateTime(row.latestAttemptAt)}</p>}</div>
        </div>;
      })}
    </div>}
  </section>;
}

function AdminPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [maxPages, setMaxPages] = useState('');
  const [ingestionMode, setIngestionMode] = useState<'current' | 'backfill'>('current');
  const [inputError, setInputError] = useState('');
  const [watchlistType, setWatchlistType] = useState<PbsWatchlistEntry['filterType']>('drug_name');
  const [watchlistValue, setWatchlistValue] = useState('');
  const [watchlistDeleteCandidate, setWatchlistDeleteCandidate] = useState<PbsWatchlistEntry | null>(null);
  const [watchlistDeleteError, setWatchlistDeleteError] = useState('');
  const [mediumThreshold, setMediumThreshold] = useState('');
  const [highThreshold, setHighThreshold] = useState('');
  const [firstNewBrandHighSignificance, setFirstNewBrandHighSignificance] = useState(true);
  const [firstNewBrandReductionPercentage, setFirstNewBrandReductionPercentage] = useState('25');
  const [artgFile, setArtgFile] = useState<File | null>(null);
  const [artgNotice, setArtgNotice] = useState('');
  const [artgError, setArtgError] = useState('');
  const [showAllArtgImports, setShowAllArtgImports] = useState(false);
  const runs = useListAdminIngestionRuns({
    query: {
      queryKey: getListAdminIngestionRunsQueryKey(),
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
    },
  });
  const current = useGetCurrentAdminIngestionRun({
    query: {
      queryKey: getGetCurrentAdminIngestionRunQueryKey(),
      refetchInterval: 5_000,
      refetchOnWindowFocus: true,
    },
  });
  const trigger = useTriggerAdminIngestion();
  const cancelIngestion = useCancelAdminIngestionRun();
  const artgImports = useListAdminArtgImportRuns({
    query: {
      queryKey: getListAdminArtgImportRunsQueryKey(),
      refetchOnWindowFocus: true,
    },
  });
  const uploadArtg = useUploadAdminArtgExport({
    request: {
      headers: {
        'X-ARTG-File-Name': encodeURIComponent(artgFile?.name ?? 'unknown-artg-export'),
      },
    },
  });
  const watchlist = useListPbsWatchlistEntries({
    query: { queryKey: getListPbsWatchlistEntriesQueryKey(), refetchOnWindowFocus: true },
  });
  const createWatchlistEntry = useCreatePbsWatchlistEntry();
  const updateWatchlistEntry = useUpdatePbsWatchlistEntry();
  const deleteWatchlistEntry = useDeletePbsWatchlistEntry();
  const significanceSettings = useGetScheduleChangeSettings({
    query: { queryKey: getGetScheduleChangeSettingsQueryKey() },
  });
  const updateSignificanceSettings = useUpdateScheduleChangeSettings();
  const activeRun = current.data?.currentRun;
  const artgImportRows = artgImports.data ?? [];
  const visibleArtgImports = showAllArtgImports ? artgImportRows : artgImportRows.slice(0, 3);
  const hiddenArtgImportCount = Math.max(0, artgImportRows.length - visibleArtgImports.length);

  useEffect(() => {
    if (!significanceSettings.data) return;
    setMediumThreshold(String(significanceSettings.data.mediumReductionPercentage));
    setHighThreshold(String(significanceSettings.data.highReductionPercentage));
    setFirstNewBrandHighSignificance(significanceSettings.data.firstNewBrandHighSignificance);
    setFirstNewBrandReductionPercentage(String(significanceSettings.data.firstNewBrandReductionPercentage));
  }, [significanceSettings.data]);

  const refresh = () => {
    void Promise.all([
      runs.refetch(),
      current.refetch(),
      watchlist.refetch(),
      artgImports.refetch(),
      queryClient.invalidateQueries({ queryKey: getListAdminPbsSourceStatusQueryKey() }),
    ]);
  };

  const refreshWatchlist = () => {
    void queryClient.invalidateQueries({ queryKey: getListPbsWatchlistEntriesQueryKey() });
  };

  const addWatchlistEntry = () => {
    const filterValue = watchlistValue.trim();
    if (!filterValue) {
      setInputError('Enter a PBS watchlist value before adding it.');
      return;
    }
    setInputError('');
    createWatchlistEntry.mutate(
      { data: { filterType: watchlistType, filterValue, enabled: true } },
      {
        onSuccess: () => {
          setWatchlistValue('');
          refreshWatchlist();
        },
        onError: () => setInputError('The PBS watchlist entry could not be saved.'),
      },
    );
  };

  const toggleWatchlistEntry = (entry: PbsWatchlistEntry) => {
    updateWatchlistEntry.mutate(
      { id: entry.id, data: { enabled: !entry.enabled } },
      {
        onSuccess: refreshWatchlist,
        onError: () => setInputError('The PBS watchlist entry could not be updated.'),
      },
    );
  };

  const removeWatchlistEntry = (entry: PbsWatchlistEntry) => {
    setWatchlistDeleteError('');
    setWatchlistDeleteCandidate(entry);
  };

  const confirmWatchlistRemoval = () => {
    if (!watchlistDeleteCandidate) return;
    deleteWatchlistEntry.mutate(
      { id: watchlistDeleteCandidate.id },
      {
        onSuccess: () => {
          setWatchlistDeleteCandidate(null);
          setWatchlistDeleteError('');
          refreshWatchlist();
        },
        onError: () => setWatchlistDeleteError('The PBS watchlist entry could not be removed.'),
      },
    );
  };

  const startIngestion = () => {
    setNotice('');
    setInputError('');
    const requestedMaxPages = maxPages.trim() ? Number(maxPages) : undefined;
    if (requestedMaxPages !== undefined && (!Number.isInteger(requestedMaxPages) || requestedMaxPages < 1 || requestedMaxPages > 10_000)) {
      setInputError('Enter a whole number from 1 to 10,000, or leave the cap blank for the full schedule.');
      return;
    }

    trigger.mutate({ data: {
      mode: ingestionMode,
      ...(requestedMaxPages === undefined ? {} : { maxPages: requestedMaxPages }),
    } }, {
      onSuccess: (run) => {
        setNotice(requestedMaxPages === undefined
          ? `${ingestionMode === 'backfill' ? 'Backfill' : 'Current-schedule'} ingestion run #${run.id} has been queued for the enabled watchlist.`
          : `Test ingestion run #${run.id} has been queued with a ${requestedMaxPages}-page cap.`);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListAdminIngestionRunsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetCurrentAdminIngestionRunQueryKey() }),
        ]);
      },
    });
  };

  const stopIngestion = () => {
    if (!activeRun || activeRun.cancelRequestedAt || cancelIngestion.isPending) return;
    setNotice('');
    setInputError('');
    cancelIngestion.mutate(
      { id: activeRun.id },
      {
        onSuccess: (run) => {
          setNotice(
            run.status === 'cancelled'
              ? `Ingestion run #${run.id} was cancelled and its staged data was discarded.`
              : `Cancellation requested for ingestion run #${run.id}. It will stop at the next safe point.`,
          );
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: getListAdminIngestionRunsQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetCurrentAdminIngestionRunQueryKey() }),
          ]);
        },
        onError: () => setInputError('The ingestion run could not be cancelled. Refresh and try again.'),
      },
    );
  };

  const uploadArtgExport = () => {
    if (!artgFile) {
      setArtgError('Choose a CSV or Excel export from the TGA ARTG search before uploading.');
      return;
    }
    if (!/\.(csv|xlsx|xls)$/i.test(artgFile.name)) {
      setArtgError('Upload a .csv, .xlsx, or .xls file exported from the TGA ARTG search.');
      return;
    }
    setArtgError('');
    setArtgNotice('');
    uploadArtg.mutate(
      { data: artgFile },
      {
        onSuccess: (run) => {
          setArtgFile(null);
          setArtgNotice(
            run.recordsAccepted
              ? `ARTG import complete: ${run.recordsAccepted.toLocaleString('en-AU')} tracked record${run.recordsAccepted === 1 ? '' : 's'} saved; ${run.pbsUnlistedRecords.toLocaleString('en-AU')} registered product${run.pbsUnlistedRecords === 1 ? '' : 's'} not PBS-listed.`
              : 'ARTG import completed with no matching active tracked ingredients. Existing ARTG records were retained.',
          );
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: getListAdminArtgImportRunsQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListArtgEntriesQueryKey() }),
          ]);
        },
        onError: (error) => setArtgError(mutationError(error, 'The ARTG import failed. Existing ARTG records were retained.')),
      },
    );
  };

  const saveSignificanceSettings = () => {
    const mediumReductionPercentage = Number(mediumThreshold);
    const highReductionPercentage = Number(highThreshold);
    const firstNewBrandReduction = Number(firstNewBrandReductionPercentage);
    if (
      !Number.isFinite(mediumReductionPercentage) ||
      !Number.isFinite(highReductionPercentage) ||
      mediumReductionPercentage <= 0 ||
      highReductionPercentage <= mediumReductionPercentage ||
      highReductionPercentage > 100
      || !Number.isFinite(firstNewBrandReduction)
      || firstNewBrandReduction <= 0
      || firstNewBrandReduction > 100
    ) {
      setInputError('Use positive percentages with the medium threshold lower than the high threshold.');
      return;
    }
    setInputError('');
    updateSignificanceSettings.mutate(
      { data: { mediumReductionPercentage, highReductionPercentage, firstNewBrandHighSignificance, firstNewBrandReductionPercentage: firstNewBrandReduction } },
      {
        onSuccess: (settings) => {
          setMediumThreshold(String(settings.mediumReductionPercentage));
          setHighThreshold(String(settings.highReductionPercentage));
           setFirstNewBrandHighSignificance(settings.firstNewBrandHighSignificance);
           setFirstNewBrandReductionPercentage(String(settings.firstNewBrandReductionPercentage));
           setNotice('Schedule-change significance settings updated and historical changes recalculated.');
          void queryClient.invalidateQueries({ queryKey: getGetScheduleChangeSettingsQueryKey() });
        },
        onError: () => setInputError('The significance thresholds could not be updated.'),
      },
    );
  };

  return <AppShell>
    <PageHeading
      eyebrow="Administration / reference data"
      title="PBS data updates"
      description="Start a controlled schedule fetch and monitor the raw reference-data ingestion lifecycle."
      action={<div className="w-full lg:w-[690px]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[170px_185px_auto] lg:items-end">
        <label className="min-w-0">
          <span className="field-label-muted">Run mode</span>
          <select value={ingestionMode} onChange={(event) => setIngestionMode(event.target.value as 'current' | 'backfill')} disabled={trigger.isPending || Boolean(activeRun)} className="control-input font-semibold" data-testid="select-ingestion-mode">
            <option value="current">Current schedule</option>
            <option value="backfill">Past 12 months</option>
          </select>
        </label>
        <label className="min-w-0">
          <span className="field-label-muted">Test page cap</span>
           <input type="number" min="1" max="10000" step="1" value={maxPages} onChange={(event) => setMaxPages(event.target.value)} disabled={trigger.isPending || Boolean(activeRun)} placeholder="No cap / fetch all pages" aria-describedby="max-pages-help" className="control-input font-semibold" data-testid="input-max-pages" />
        </label>
         <div className="flex flex-wrap gap-2">
          <button type="button" onClick={refresh} disabled={runs.isFetching || current.isFetching} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-bold text-foreground hover:-translate-y-0.5 hover:shadow-sm disabled:opacity-55" data-testid="button-refresh-ingestion-runs"><RefreshCw className={`h-4 w-4 ${runs.isFetching || current.isFetching ? 'animate-spin' : ''}`} /> Refresh</button>
          <button type="button" onClick={startIngestion} disabled={trigger.isPending || Boolean(activeRun)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-55" data-testid="button-trigger-ingestion"><Play className="h-4 w-4" />{trigger.isPending ? 'Starting…' : activeRun ? 'Run in progress' : 'Start ingestion'}</button>
        </div>
        </div>
        <p id="max-pages-help" className="mt-1.5 text-[10px] text-muted-foreground">Leave the page cap blank to fetch every matching page.</p>
      </div>}
    />

    {notice && <div className="mb-5 flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-4 py-3 text-sm font-semibold text-success" role="status" data-testid="status-ingestion-success"><Check className="h-4 w-4" />{notice}</div>}
    {(inputError || trigger.isError) && <div className="mb-5 flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm font-semibold text-destructive" role="alert" data-testid="status-ingestion-error"><CircleAlert className="h-4 w-4" />{inputError || trigger.error?.message || 'The ingestion run could not be started.'}</div>}
     <PbsSourceHealthPanel ingestionActive={Boolean(activeRun)} />

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-significance-settings">
      <div className="border-b border-border px-5 py-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Schedule-change alerts</p>
        <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Price reduction significance</h2>
        <p className="mt-1 text-sm text-muted-foreground">A reduction above the medium threshold is flagged medium; above the high threshold is flagged high.</p>
      </div>
       {significanceSettings.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : significanceSettings.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => significanceSettings.refetch()} /></div> : <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-[minmax(130px,1fr)_minmax(130px,1fr)_minmax(225px,1.35fr)_minmax(150px,1fr)_auto] xl:items-end">
        <label className="block"><span className="field-label">Medium reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={mediumThreshold} onChange={(event) => setMediumThreshold(event.target.value)} className="control-input font-mono" data-testid="input-medium-reduction-threshold" /></label>
        <label className="block"><span className="field-label">High reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={highThreshold} onChange={(event) => setHighThreshold(event.target.value)} className="control-input font-mono" data-testid="input-high-reduction-threshold" /></label>
          <div><span className="field-label">First new brand</span><label className="flex h-11 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-input bg-background px-3"><input type="checkbox" checked={firstNewBrandHighSignificance} onChange={(event) => setFirstNewBrandHighSignificance(event.target.checked)} className="h-4 w-4 shrink-0 accent-primary" data-testid="checkbox-first-new-brand-high-significance" /><span className="min-w-0"><span className="block truncate text-xs font-bold">Treat as high significance</span><span className="hidden truncate text-[10px] text-muted-foreground 2xl:block">Only when the prior schedule had one brand.</span></span></label></div>
          <label className="block"><span className="field-label">First new-brand reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={firstNewBrandReductionPercentage} onChange={(event) => setFirstNewBrandReductionPercentage(event.target.value)} className="control-input font-mono" data-testid="input-first-new-brand-reduction" /></label>
        <div><span className="field-label invisible">Save</span><button type="button" onClick={saveSignificanceSettings} disabled={updateSignificanceSettings.isPending} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50 xl:w-auto" data-testid="button-save-significance-settings">{updateSignificanceSettings.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save thresholds</button></div>
      </div>}
    </section>

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-pbs-watchlist">
      <div className="border-b border-border px-5 py-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">PBS ingestion scope</p>
        <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Enabled watchlist</h2>
        <p className="mt-1 text-sm text-muted-foreground">Each enabled entry creates a filtered latest-schedule request. An empty watchlist never falls back to a full download.</p>
      </div>
      <div className="flex flex-col gap-3 border-b border-border bg-muted/20 p-4 sm:flex-row">
        <select value={watchlistType} onChange={(event) => setWatchlistType(event.target.value as PbsWatchlistEntry['filterType'])} className="control-input w-full font-semibold sm:w-auto" data-testid="select-watchlist-filter-type">
          <option value="atc_code">ATC code</option><option value="brand_name">Brand name</option><option value="drug_name">Drug name</option><option value="pbs_code">PBS code</option><option value="formulary">Formulary</option><option value="program_code">Program code</option>
        </select>
        <input value={watchlistValue} onChange={(event) => setWatchlistValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addWatchlistEntry(); }} placeholder={watchlistType === 'atc_code' ? 'e.g. N06BA' : 'Filter value'} className="control-input min-w-0 flex-1" data-testid="input-watchlist-filter-value" />
        <button type="button" onClick={addWatchlistEntry} disabled={createWatchlistEntry.isPending} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-add-watchlist-entry"><Plus className="h-4 w-4" />Add filter</button>
      </div>
       {watchlist.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : watchlist.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => watchlist.refetch()} /></div> : !watchlist.data?.length ? <p className="p-5 text-sm text-muted-foreground">No filters configured. Add an enabled entry before starting an ingestion.</p> : <div className="divide-y divide-border">{watchlist.data.map((entry) => <div key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid={`row-watchlist-entry-${entry.id}`}><span className="rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold capitalize text-muted-foreground">{watchlistFilterTypeLabel(entry.filterType)}</span><span className="min-w-0 flex-1 truncate font-mono text-sm font-bold">{watchlistDisplayValue(entry)}</span><button type="button" onClick={() => toggleWatchlistEntry(entry)} disabled={updateWatchlistEntry.isPending} className="status-badge status-neutral" data-testid={`button-toggle-watchlist-${entry.id}`}>{entry.enabled ? 'Enabled' : 'Disabled'}</button><button type="button" onClick={() => removeWatchlistEntry(entry)} disabled={deleteWatchlistEntry.isPending} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50" aria-label={`Remove ${watchlistDisplayValue(entry)}`} data-testid={`button-delete-watchlist-${entry.id}`}><Trash2 className="h-4 w-4" /></button></div>)}</div>}
    </section>

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-artg-import">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Manual reference import</p>
          <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">ARTG registrations</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Upload a CSV or Excel export from the TGA ARTG search. The file must include ARTG ID, active ingredient, sponsor, start date, and product or good name. A failed upload never clears the last successful ARTG data.</p>
        </div>
      </div>
      <div className="border-b border-border bg-muted/20 p-5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <label className="block min-w-0">
            <span className="field-label">TGA export file</span>
            <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { setArtgFile(event.target.files?.[0] ?? null); setArtgError(''); setArtgNotice(''); }} className="block w-full cursor-pointer rounded-xl border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-info/10 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-info hover:file:bg-info/15" data-testid="input-artg-export-file" />
          </label>
          <button type="button" onClick={uploadArtgExport} disabled={!artgFile || uploadArtg.isPending} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-upload-artg-export">{uploadArtg.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}{uploadArtg.isPending ? 'Importing…' : 'Import ARTG export'}</button>
        </div>
        {artgNotice && <p className="mt-3 flex items-start gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2.5 text-xs font-semibold text-success" role="status" data-testid="status-artg-import-success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{artgNotice}</p>}
        {(artgError || uploadArtg.isError) && <p className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs font-semibold text-destructive" role="alert" data-testid="status-artg-import-error"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{artgError || mutationError(uploadArtg.error, 'The ARTG import failed. Existing ARTG records were retained.')}</p>}
      </div>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3"><p className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Recent ARTG imports</p><div className="flex items-center gap-4"><button type="button" onClick={() => artgImports.refetch()} disabled={artgImports.isFetching} className="text-xs font-bold text-info hover:text-primary disabled:opacity-50">Refresh</button>{artgImportRows.length > 3 && <button type="button" onClick={() => setShowAllArtgImports((current) => !current)} className="inline-flex items-center gap-1 text-xs font-bold text-info hover:text-primary" aria-expanded={showAllArtgImports} data-testid="button-toggle-artg-import-history">{showAllArtgImports ? 'Show fewer' : `Show all ${artgImportRows.length}`} {showAllArtgImports ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button>}</div></div>
        {artgImports.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : artgImports.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => artgImports.refetch()} /></div> : !artgImportRows.length ? <p className="p-5 text-sm text-muted-foreground">No ARTG import has been recorded. The directory will remain empty until a valid TGA export is uploaded.</p> : <><div className="divide-y divide-border">{visibleArtgImports.map((run: ArtgImportRun) => <div key={run.id} className="grid gap-2 px-5 py-3 text-xs sm:grid-cols-[1.15fr_.65fr_.75fr_1fr] sm:items-center sm:gap-4" data-testid={`row-artg-import-${run.id}`}><div className="min-w-0"><p className="truncate font-bold">{run.sourceFileName}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">Run #{run.id} · {formatDateTime(run.startedAt)}</p></div><span className={`status-badge ${run.status === 'completed' ? 'status-success' : run.status === 'failed' ? 'status-error' : 'status-info'}`}>{run.status}</span><span className="font-mono font-bold">{run.recordsAccepted.toLocaleString('en-AU')} saved</span><div className={run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{run.errorMessage ? <span className="inline-flex items-start gap-1.5"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{run.errorMessage}</span> : <span>{run.recordsRejected ? `${run.recordsRejected} invalid` : run.recordsSkipped ? `${run.recordsSkipped} not tracked` : `${run.pbsUnlistedRecords} not PBS-listed`}{run.warnings[0] ? ` · ${run.warnings[0]}` : ''}</span>}</div></div>)}</div>{hiddenArtgImportCount > 0 && <p className="border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">{hiddenArtgImportCount} older import{hiddenArtgImportCount === 1 ? '' : 's'} hidden</p>}</>}
      </div>
    </section>

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" aria-live="polite" data-testid="card-current-ingestion">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Current run</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Live ingestion progress</h2></div>
         <div className="flex flex-wrap items-center gap-2">
           {activeRun ? <IngestionStatus status={activeRun.status} /> : <span className="status-badge status-neutral">Idle</span>}
           {activeRun && <button type="button" onClick={stopIngestion} disabled={Boolean(activeRun.cancelRequestedAt) || cancelIngestion.isPending} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 text-xs font-bold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-55" data-testid="button-cancel-ingestion"><X className="h-3.5 w-3.5" />{activeRun.cancelRequestedAt || cancelIngestion.isPending ? 'Stopping…' : 'Cancel run'}</button>}
         </div>
      </div>
       {current.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : current.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => current.refetch()} /></div> : activeRun ? <div className="grid gap-4 p-5 sm:grid-cols-4">
        {activeRun.mode === 'backfill' ? <div className="sm:col-span-4 rounded-xl border border-primary/15 bg-primary/5 p-4" data-testid="progress-backfill-schedules">
          {activeRun.totalSchedules ? (() => {
            const completedSchedules = Math.min(activeRun.schedulesProcessed, activeRun.totalSchedules);
            const currentSchedule = Math.min(completedSchedules + 1, activeRun.totalSchedules);
            const percentage = Math.round((completedSchedules / activeRun.totalSchedules) * 100);
            return <><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-primary">Backfill progress</p><p className="mt-1 text-sm font-bold">Schedule {currentSchedule} of {activeRun.totalSchedules}</p></div><span className="font-mono text-xs font-bold text-primary">{percentage}%</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-primary/10" role="progressbar" aria-label="Backfill schedule progress" aria-valuemin={0} aria-valuemax={activeRun.totalSchedules} aria-valuenow={completedSchedules}><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percentage}%` }} /></div></>;
          })() : <><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-primary">Backfill progress</p><p className="mt-1 text-sm font-semibold">Preparing the 12-month schedule list…</p></>}
        </div> : <div className="sm:col-span-4 rounded-xl border border-info/20 bg-info/5 p-4" data-testid="progress-current-live">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-info">Current-schedule crawl</p>
          <p className="mt-1 text-sm font-semibold">Live counts update as pages are fetched and items are mapped. The total page count is not known until the crawl finishes.</p>
        </div>}
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Run ID</p><p className="mt-2 font-mono text-lg font-bold">#{activeRun.id}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Items mapped</p><p className="mt-2 font-mono text-lg font-bold" data-testid="text-current-records-processed">{activeRun.recordsProcessed.toLocaleString('en-AU')}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Pages fetched</p><p className="mt-2 font-mono text-lg font-bold" data-testid="text-current-pages-fetched">{activeRun.pagesFetched.toLocaleString('en-AU')}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Started</p><p className="mt-2 text-sm font-bold">{formatDateTime(activeRun.startedAt)}</p></div>
         </div> : <div className="flex items-start gap-4 p-6"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info"><DatabaseZap className="h-5 w-5" /></span><div><h3 className="font-bold">No ingestion is running.</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">Start a run when you are ready to fetch the latest PBS schedule into raw staging. Progress refreshes automatically while a run is active.</p></div></div>}
     </section>
     {watchlistDeleteCandidate && <DeleteWatchlistDialog entry={watchlistDeleteCandidate} pending={deleteWatchlistEntry.isPending} error={watchlistDeleteError} onClose={() => { if (!deleteWatchlistEntry.isPending) { setWatchlistDeleteCandidate(null); setWatchlistDeleteError(''); } }} onConfirm={confirmWatchlistRemoval} />}

    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-ingestion-history">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Operational history</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Recent ingestion runs</h2></div><span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{runs.data?.length ?? 0} shown</span></div>
      {runs.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : runs.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => runs.refetch()} /></div> : !runs.data?.length ? <div className="p-10 text-center"><DatabaseZap className="mx-auto h-8 w-8 text-muted-foreground/50" /><h3 className="mt-3 font-bold">No runs have been recorded.</h3><p className="mt-1 text-sm text-muted-foreground">The first manual ingestion will appear here as soon as it starts.</p></div> : <div className="divide-y divide-border">
        <div className="hidden grid-cols-[.5fr_1fr_.8fr_.85fr_1fr] gap-4 bg-muted/35 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>Run</span><span>Status</span><span>Records</span><span>Started</span><span>Finished / issue</span></div>
        {runs.data.map((run) => <div key={run.id} className="grid gap-3 px-5 py-4 text-sm transition-colors hover:bg-secondary/25 md:grid-cols-[.5fr_1fr_.8fr_.85fr_1fr] md:items-center md:gap-4" data-testid={`row-ingestion-run-${run.id}`}>
          <span className="font-mono font-bold text-info">#{run.id}</span>
          <IngestionStatus status={run.status} />
          <span className="font-mono font-bold">{run.recordsProcessed.toLocaleString('en-AU')}</span>
          <span className="text-xs text-muted-foreground">{formatDateTime(run.startedAt)}</span>
          <span className={`text-xs ${run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{run.errorMessage ? <span className="inline-flex items-start gap-1.5"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{run.errorMessage}</span> : run.finishedAt ? <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" />{formatDateTime(run.finishedAt)}</span> : 'In progress'}</span>
        </div>)}
      </div>}
    </section>
  </AppShell>;
}

export { Dashboard, ArtgDirectory, StockPage, AdminPage };
