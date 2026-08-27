import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetCurrentAdminIngestionRunQueryKey,
  getGetScheduleChangeSettingsQueryKey,
  getGetDashboardQueryKey,
  getListAdminIngestionRunsQueryKey,
  getListPbsWatchlistEntriesQueryKey,
  getListPbsItemsQueryKey,
  getListStockQueryKey,
  getHealthCheckQueryKey,
  type AdminIngestionRun,
  type ArtgEntry,
  type PbsItem,
  type PbsWatchlistEntry,
  type PharmacyStock,
  type StockExposureLine,
  type StockExposureResponse,
  useCreatePbsWatchlistEntry,
  useCreateStock,
  useDeletePbsWatchlistEntry,
  useDeleteStock,
  useGetCurrentAdminIngestionRun,
  useGetScheduleChangeSettings,
  useGetDashboard,
  useHealthCheck,
  useListAdminIngestionRuns,
  useListArtgEntries,
  useListPbsItems,
  useListPbsWatchlistEntries,
  useListStock,
  useTriggerAdminIngestion,
  useUpdatePbsWatchlistEntry,
  useUpdateScheduleChangeSettings,
  useUpdateStock,
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { ArrowRight, BarChart3, BookOpen, Boxes, CalendarDays, Check, CheckCircle2, ChevronDown, CircleAlert, DatabaseZap, Filter, History, LoaderCircle, PackagePlus, Pencil, Play, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, Trash2, TrendingDown, X, XCircle } from 'lucide-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

function StatCard({ label, value, detail, icon: Icon, tone = 'primary' }: { label: string; value: string | number; detail: string; icon: typeof BarChart3; tone?: 'primary' | 'amber' | 'teal' }) {
  return <div className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-xs transition-transform hover:-translate-y-1 hover:shadow-md" data-testid={`card-stat-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className={`mb-7 flex h-9 w-9 items-center justify-center rounded-xl ${tone === 'amber' ? 'bg-accent/20 text-accent-foreground' : tone === 'teal' ? 'bg-chart-3/15 text-chart-3' : 'bg-primary/10 text-primary'}`}><Icon className="h-4 w-4" /></div>
    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
    <div className="mt-1 flex items-baseline gap-2"><span className="text-3xl font-bold tracking-[-0.06em]" data-testid={`text-stat-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</span><span className="text-xs text-muted-foreground">{detail}</span></div>
  </div>;
}

function Dashboard() {
  const dashboard = useGetDashboard();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey() } });
  if (dashboard.isLoading) return <AppShell><PageHeading eyebrow="Workspace overview" title="Good morning." description="A quick read on the stock and reference data your team uses most." /><QueryState kind="loading" /></AppShell>;
  if (dashboard.isError || !dashboard.data) return <AppShell><PageHeading eyebrow="Workspace overview" title="Good morning." description="A quick read on the stock and reference data your team uses most." /><QueryState kind="error" onRetry={() => dashboard.refetch()} /></AppShell>;
  const summary = dashboard.data;
  return <AppShell>
    <PageHeading eyebrow="Workspace overview" title="Good morning." description="A quick read on the stock and reference data your team uses most." action={<Link href="/stock" className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md" data-testid="link-add-stock"><Plus className="h-4 w-4" /> Add stock record</Link>} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Stock units" value={summary.totalStockUnits} detail="on hand" icon={Boxes} />
      <StatCard label="Stock lines" value={summary.stockLineCount} detail="records" icon={PackagePlus} tone="amber" />
      <StatCard label="Tracked items" value={summary.trackedItems} detail="PBS items" icon={BookOpen} tone="teal" />
      <StatCard label="PBS mix" value={`${summary.formularyBreakdown.F1}/${summary.formularyBreakdown.F2}`} detail="F1 / F2" icon={BarChart3} />
    </div>
    <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-recent-stock">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Private workspace</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Recent stock records</h2></div><Link href="/stock" className="flex items-center gap-1 text-xs font-bold text-primary hover:gap-2" data-testid="link-view-all-stock">View all <ArrowRight className="h-3.5 w-3.5" /></Link></div>
        {summary.recentStock?.length ? <div className="divide-y divide-border">{summary.recentStock.slice(0, 5).map((item, index) => <div key={item.id} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/45" data-testid={`row-recent-stock-${item.id}`}><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary font-mono text-xs font-bold text-secondary-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{item.brandName || 'PBS item'}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.itemCode} · added {date(item.purchaseDate)}</p></div><div className="text-right"><p className="font-mono text-sm font-bold">{item.quantity} units</p><p className="mt-0.5 text-xs text-muted-foreground">{money(item.purchasePrice)} each</p></div></div>)}</div> : <div className="p-12"><QueryState kind="empty" /></div>}
      </section>
      <section className="rounded-2xl border border-border bg-sidebar p-6 text-sidebar-foreground shadow-sm" data-testid="card-reference-note">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><ShieldCheck className="h-5 w-5" /></div>
        <p className="mt-7 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-foreground/55">Reference desk</p>
        <h2 className="mt-2 text-2xl font-bold tracking-[-0.05em]">Know the number before you order.</h2>
        <p className="mt-3 text-sm leading-relaxed text-sidebar-foreground/65">Search PBS listings, check current ex-manufacturer and wholesale prices, then trace how a price has moved over time.</p>
        <p className="mt-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-sidebar-foreground/45"><span className={`h-1.5 w-1.5 rounded-full ${health.data?.status === 'ok' ? 'bg-accent' : health.isError ? 'bg-destructive' : 'bg-sidebar-foreground/40'}`} />{health.data?.status === 'ok' ? 'Reference service online' : health.isError ? 'Reference service unavailable' : 'Checking reference service'}</p>
        <Link href="/pbs" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-sidebar-primary px-4 py-3 text-sm font-bold text-sidebar-primary-foreground hover:-translate-y-0.5" data-testid="link-reference-desk"><Search className="h-4 w-4" /> Open PBS directory</Link>
      </section>
    </div>
  </AppShell>;
}

function ArtgDirectory() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const params = useMemo(() => ({ search: search || undefined, status: status || undefined }), [search, status]);
  const query = useListArtgEntries(params);
  const entries = query.data ?? [];
  return <AppShell><PageHeading eyebrow="Reference library / ARTG" title="ARTG register" description="Keep registration status and sponsor details close while you validate a product." />
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-xs sm:flex-row"><label className="flex min-h-11 flex-1 items-center gap-3 rounded-xl bg-muted/60 px-3 text-muted-foreground"><Search className="h-4 w-4" /><input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70" placeholder="Search ARTG ID, ingredient, sponsor or product" data-testid="input-artg-search" /></label><label className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm"><Filter className="h-4 w-4 text-primary" /><select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-transparent pr-5 text-sm font-semibold outline-none" data-testid="select-artg-status"><option value="">All statuses</option><option value="Registered">Registered</option><option value="Cancelled">Cancelled</option></select></label></div>
    {query.isLoading ? <QueryState kind="loading" /> : query.isError ? <QueryState kind="error" onRetry={() => query.refetch()} /> : !entries.length ? <QueryState kind="empty" /> : <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs"><div className="hidden grid-cols-[.65fr_1.4fr_1fr_1fr_.75fr] gap-4 border-b border-border bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>ARTG ID</span><span>Product</span><span>Ingredient</span><span>Sponsor</span><span>Status</span></div><div className="divide-y divide-border">{entries.map((entry: ArtgEntry) => <div key={entry.artgId} className="grid gap-2 px-5 py-4 transition-colors hover:bg-secondary/30 md:grid-cols-[.65fr_1.4fr_1fr_1fr_.75fr] md:items-center md:gap-4" data-testid={`row-artg-${entry.artgId}`}><div className="font-mono text-xs font-bold text-primary">{entry.artgId}</div><div><p className="text-sm font-bold">{entry.productName}</p><p className="mt-0.5 text-xs text-muted-foreground">Registered {date(entry.registrationDate)}</p></div><p className="text-xs text-muted-foreground md:text-sm">{entry.activeIngredient}</p><p className="text-xs text-muted-foreground md:text-sm">{entry.sponsor}</p><span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-bold ${entry.status.toLowerCase() === 'active' ? 'bg-chart-3/15 text-chart-3' : 'bg-destructive/10 text-destructive'}`}>{entry.status}</span></div>)}</div></div>}
  </AppShell>;
}

type StockForm = { itemCode: string; quantity: string; purchasePrice: string; purchaseDate: string; invoiceReference: string };
const blankStock: StockForm = { itemCode: '', quantity: '0', purchasePrice: '0', purchaseDate: new Date().toISOString().slice(0, 10), invoiceReference: '' };

function itemLabel(item: Pick<PbsItem, 'brandName' | 'drugName' | 'strength' | 'form' | 'packSize'>) {
  return [item.brandName, item.drugName, item.strength, item.form, item.packSize].filter(Boolean).join(' · ');
}

function StockDialog({ initial, onClose, onSaved }: { initial?: StockExposureLine; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState<StockForm>(initial ? { itemCode: initial.itemCode, quantity: String(initial.quantity), purchasePrice: String(initial.purchasePrice), purchaseDate: initial.purchaseDate.slice(0, 10), invoiceReference: initial.invoiceReference ?? '' } : blankStock);
  const [itemSearch, setItemSearch] = useState(initial ? `${initial.itemCode} · ${initial.brandName}` : '');
  const [showItemResults, setShowItemResults] = useState(false);
  const [error, setError] = useState('');
  const create = useCreateStock();
  const update = useUpdateStock();
  const itemQuery = useListPbsItems(
    { search: itemSearch.trim(), limit: 20 },
    { query: { queryKey: getListPbsItemsQueryKey({ search: itemSearch.trim(), limit: 20 }), enabled: itemSearch.trim().length >= 2 } },
  );
  const pending = create.isPending || update.isPending;
  const set = (key: keyof StockForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => {
    if (!form.itemCode.trim() || Number(form.quantity) < 0 || Number(form.purchasePrice) < 0 || !form.purchaseDate) { setError('Choose a PBS item, then enter a non-negative quantity and price with a purchase date.'); return; }
    const baseData = { itemCode: form.itemCode.trim(), quantity: Number(form.quantity), purchasePrice: Number(form.purchasePrice), purchaseDate: form.purchaseDate };
    const options = { onSuccess: () => { onSaved(initial ? 'Stock record updated.' : 'Stock record added.'); onClose(); }, onError: () => setError('The record could not be saved. Please try again.') };
    if (initial) update.mutate({ id: initial.id, data: { ...baseData, invoiceReference: form.invoiceReference.trim() || null }, ...options });
    else create.mutate({ data: { ...baseData, ...(form.invoiceReference.trim() ? { invoiceReference: form.invoiceReference.trim() } : {}) }, ...options });
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
                <input value={itemSearch} onFocus={() => setShowItemResults(true)} onChange={(e) => { setItemSearch(e.target.value); set('itemCode', ''); setShowItemResults(true); }} placeholder="Search brand, drug, ingredient or item code" className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-stock-item-search" />
              </div>
            </label>
            {showItemResults && itemSearch.trim().length >= 2 && (
              <div className="absolute left-0 right-0 top-[4.75rem] z-10 max-h-60 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
                {itemQuery.isLoading ? <p className="px-3 py-4 text-xs text-muted-foreground">Searching PBS items…</p> : itemQuery.isError ? <p className="px-3 py-4 text-xs text-destructive">PBS item search is unavailable.</p> : !itemQuery.data?.length ? <p className="px-3 py-4 text-xs text-muted-foreground">No matching PBS items.</p> : itemQuery.data.map((item) => (
                  <button type="button" key={item.itemCode} onClick={() => { set('itemCode', item.itemCode); setItemSearch(`${item.itemCode} · ${itemLabel(item)}`); setShowItemResults(false); setError(''); }} className="block w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted" data-testid={`option-stock-item-${item.itemCode}`}>
                    <span className="block font-mono text-xs font-bold text-primary">{item.itemCode} · {item.formulary}</span>
                    <span className="mt-1 block text-xs font-semibold">{itemLabel(item)}</span>
                  </button>
                ))}
              </div>
            )}
            {form.itemCode && <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">Selected PBS item: {form.itemCode}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="mb-1.5 block text-xs font-bold">Quantity</span><input type="number" min="0" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-stock-quantity" /></label>
            <label className="block"><span className="mb-1.5 block text-xs font-bold">Purchase price (AUD)</span><input type="number" min="0" step="0.01" value={form.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-stock-price" /></label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className="mb-1.5 block text-xs font-bold">Purchase date</span><input type="date" value={form.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-stock-date" /></label>
            <label className="block"><span className="mb-1.5 block text-xs font-bold">Invoice reference <span className="font-normal text-muted-foreground">(optional)</span></span><div className="relative"><ReceiptText className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input value={form.invoiceReference} onChange={(e) => set('invoiceReference', e.target.value)} maxLength={120} placeholder="e.g. INV-2048" className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-stock-invoice-reference" /></div></label>
          </div>
        </div>
        {error && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" data-testid="status-stock-form-error">{error}</p>}
        <div className="mt-7 flex justify-end gap-3"><button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-bold text-muted-foreground hover:bg-muted" data-testid="button-cancel-stock">Cancel</button><button type="button" onClick={submit} disabled={pending} className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-save-stock">{pending && <LoaderCircle className="h-4 w-4 animate-spin" />}{initial ? 'Save changes' : 'Add record'}</button></div>
      </div>
    </div>
  );
}

function StockPage() {
  const queryClient = useQueryClient();
  const stock = useListStock();
  const remove = useDeleteStock();
  const [dialog, setDialog] = useState<'new' | StockExposureLine | null>(null);
  const [notice, setNotice] = useState('');
  const response = stock.data as StockExposureResponse | undefined;
  const rows = response?.rows ?? [];
  const summary = response?.summary;
  const atRiskRows = rows.filter((row) => row.totalExposure > 0);
  const neutralRows = rows.filter((row) => !row.prediction);
  const totalUnits = rows.reduce((total, row) => total + row.quantity, 0);
  const saved = (message: string) => { setNotice(message); queryClient.invalidateQueries({ queryKey: getListStockQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); window.setTimeout(() => setNotice(''), 3200); };
  const deleteRow = (row: StockExposureLine) => { if (window.confirm(`Delete the stock record for ${row.itemCode}?`)) remove.mutate({ id: row.id }, { onSuccess: () => saved('Stock record deleted.'), onError: () => setNotice('Could not delete that record.') }); };
  const renderGroup = (predictedDate: string, lineCount: number, totalExposure: number) => <div key={predictedDate} className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><CalendarDays className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-bold">{date(predictedDate)}</p><p className="text-xs text-muted-foreground">{lineCount} at-risk {lineCount === 1 ? 'line' : 'lines'}</p></div><p className="font-mono text-sm font-bold text-destructive">{money(totalExposure)}</p></div>;
  const renderRow = (row: StockExposureLine) => <div key={row.id} className="grid gap-4 px-5 py-5 transition-colors hover:bg-secondary/25 lg:grid-cols-[minmax(0,1.4fr)_0.75fr_0.75fr_auto] lg:items-center" data-testid={`row-stock-${row.id}`}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-mono text-[10px] font-bold text-primary">{row.itemCode}</p><span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{row.formulary}</span></div><p className="mt-1 truncate text-sm font-bold">{row.brandName}</p><p className="mt-1 truncate text-xs text-muted-foreground">{row.drugName} · {[row.strength, row.form, row.packSize].filter(Boolean).join(' · ')}</p><p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{row.quantity} units at {money(row.purchasePrice)} each</span><span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" />{date(row.purchaseDate)}</span>{row.invoiceReference && <span className="inline-flex items-center gap-1"><ReceiptText className="h-3 w-3" />{row.invoiceReference}</span>}</p></div><div className="rounded-xl bg-muted/55 p-3 lg:bg-transparent lg:p-0"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Prediction</p>{row.prediction ? <><p className="mt-1 text-sm font-bold">{date(row.prediction.predictedDate)}</p><p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${row.prediction.confidence === 'confirmed' ? 'bg-chart-3' : 'bg-accent-foreground'}`} />{row.prediction.confidence === 'confirmed' ? 'Confirmed' : 'Indicative'} · {row.prediction.reductionType.replaceAll('_', ' ')}</p></> : <p className="mt-1 text-sm font-semibold text-muted-foreground">No future prediction</p>}</div><div className="rounded-xl bg-muted/55 p-3 lg:bg-transparent lg:p-0"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Exposure</p>{row.prediction ? <><p className={`mt-1 text-lg font-bold tracking-[-0.04em] ${row.totalExposure > 0 ? 'text-destructive' : 'text-chart-3'}`}>{row.totalExposure > 0 ? money(row.totalExposure) : 'No loss'}</p><p className="mt-1 text-xs text-muted-foreground">{money(row.perPackExposure)} per pack</p></> : <p className="mt-1 text-lg font-bold text-muted-foreground">Neutral</p>}</div><div className="flex gap-1 lg:justify-end"><button type="button" onClick={() => setDialog(row)} className="rounded-lg p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary" aria-label={`Edit ${row.itemCode}`} data-testid={`button-edit-stock-${row.id}`}><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => deleteRow(row)} disabled={remove.isPending} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50" aria-label={`Delete ${row.itemCode}`} data-testid={`button-delete-stock-${row.id}`}><Trash2 className="h-4 w-4" /></button></div></div>;
  return <AppShell><PageHeading eyebrow="Private workspace / stock" title="Stock exposure" description="See which private stock lines are most exposed to upcoming PBS price reductions." action={<button type="button" onClick={() => setDialog('new')} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md" data-testid="button-add-stock"><Plus className="h-4 w-4" /> Add stock</button>} />
    {notice && <div className="mb-5 flex items-center gap-2 rounded-xl border border-chart-3/25 bg-chart-3/10 px-4 py-3 text-sm font-semibold text-chart-3" role="status" data-testid="status-stock-success"><Check className="h-4 w-4" />{notice}</div>}
    {stock.isLoading ? <QueryState kind="loading" /> : stock.isError ? <QueryState kind="error" onRetry={() => stock.refetch()} /> : !rows.length ? <div className="grid-paper rounded-2xl border border-dashed border-border p-10 sm:p-16"><div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/20 text-accent-foreground"><Boxes className="h-6 w-6" /></div><h2 className="mt-5 text-xl font-bold tracking-[-0.04em]">Your stock workspace is clear.</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Add a private PBS stock record to see quantities, predictions, and potential exposure in one place.</p><button type="button" onClick={() => setDialog('new')} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground hover:-translate-y-0.5" data-testid="button-add-first-stock"><Plus className="h-4 w-4" /> Add first record</button></div></div> : <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Total exposure" value={money(summary?.totalExposure ?? 0)} detail="potential loss" icon={TrendingDown} tone="amber" /><StatCard label="At-risk lines" value={summary?.totalAtRiskLines ?? atRiskRows.length} detail="stock records" icon={CircleAlert} /><StatCard label="Stock units" value={totalUnits} detail="on hand" icon={Boxes} tone="teal" /><StatCard label="Prediction dates" value={summary?.exposureByDate.length ?? 0} detail="upcoming dates" icon={CalendarDays} /></div><div className="mt-6 grid gap-6 xl:grid-cols-[1.3fr_.7fr]"><section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-stock-exposure"><div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Risk-first view</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Stock lines</h2></div><p className="text-xs text-muted-foreground">{atRiskRows.length ? `${atRiskRows.length} lines with positive exposure` : 'No positive exposure detected'}</p></div><div className="divide-y divide-border">{atRiskRows.length ? atRiskRows.map(renderRow) : <div className="p-8 text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-chart-3" /><p className="mt-3 text-sm font-bold">No stock is currently at risk.</p><p className="mt-1 text-xs text-muted-foreground">Future predictions are still shown below when a line has no positive loss.</p></div>}</div></section><section className="rounded-2xl border border-border bg-sidebar p-5 text-sidebar-foreground shadow-sm" data-testid="section-exposure-by-date"><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-foreground/55">Forward view</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Exposure by date</h2><p className="mt-2 text-sm leading-relaxed text-sidebar-foreground/65">Potential loss grouped by the earliest future prediction for each PBS item.</p><div className="mt-5 space-y-2">{summary?.exposureByDate.length ? summary.exposureByDate.map((group) => renderGroup(group.predictedDate, group.lineCount, group.totalExposure)) : <p className="rounded-xl border border-sidebar-border bg-sidebar-accent/35 p-4 text-xs text-sidebar-foreground/65">No positive exposure has been calculated yet.</p>}</div></section></div>{neutralRows.length > 0 && <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-neutral-stock"><div className="border-b border-border px-5 py-4"><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Neutral lines</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">No future prediction yet</h2><p className="mt-1 text-sm text-muted-foreground">These records remain visible without inventing an exposure amount.</p></div><div className="divide-y divide-border">{neutralRows.map(renderRow)}</div></section>}</>}
    {dialog && <StockDialog initial={dialog === 'new' ? undefined : dialog} onClose={() => setDialog(null)} onSaved={saved} />}
  </AppShell>;
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-AU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed);
}

function IngestionStatus({ status }: { status: AdminIngestionRun['status'] }) {
  const styles = {
    queued: 'bg-accent/25 text-accent-foreground',
    running: 'bg-primary/10 text-primary',
    completed: 'bg-chart-3/15 text-chart-3',
    failed: 'bg-destructive/10 text-destructive',
  } as const;
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${styles[status]}`}>{status}</span>;
}

function AdminPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [maxPages, setMaxPages] = useState('');
  const [ingestionMode, setIngestionMode] = useState<'current' | 'backfill'>('current');
  const [inputError, setInputError] = useState('');
  const [watchlistType, setWatchlistType] = useState<PbsWatchlistEntry['filterType']>('atc_code');
  const [watchlistValue, setWatchlistValue] = useState('');
  const [mediumThreshold, setMediumThreshold] = useState('');
  const [highThreshold, setHighThreshold] = useState('');
  const [firstNewBrandHighSignificance, setFirstNewBrandHighSignificance] = useState(true);
  const [firstNewBrandReductionPercentage, setFirstNewBrandReductionPercentage] = useState('25');
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

  useEffect(() => {
    if (!significanceSettings.data) return;
    setMediumThreshold(String(significanceSettings.data.mediumReductionPercentage));
    setHighThreshold(String(significanceSettings.data.highReductionPercentage));
    setFirstNewBrandHighSignificance(significanceSettings.data.firstNewBrandHighSignificance);
    setFirstNewBrandReductionPercentage(String(significanceSettings.data.firstNewBrandReductionPercentage));
  }, [significanceSettings.data]);

  const refresh = () => {
    void Promise.all([runs.refetch(), current.refetch(), watchlist.refetch()]);
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
    if (!window.confirm(`Remove the ${entry.filterType} watchlist entry “${entry.filterValue}”?`)) return;
    deleteWatchlistEntry.mutate(
      { id: entry.id },
      {
        onSuccess: refreshWatchlist,
        onError: () => setInputError('The PBS watchlist entry could not be removed.'),
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
      action={<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
        <label className="min-w-[170px]">
          <span className="mb-1.5 block font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Run mode</span>
          <select value={ingestionMode} onChange={(event) => setIngestionMode(event.target.value as 'current' | 'backfill')} disabled={trigger.isPending || Boolean(activeRun)} className="h-12 w-full rounded-xl border border-input bg-card px-3 text-sm font-semibold outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-55" data-testid="select-ingestion-mode">
            <option value="current">Current schedule</option>
            <option value="backfill">Past 12 months</option>
          </select>
        </label>
        <label className="min-w-[150px]">
          <span className="mb-1.5 block font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Test page cap</span>
          <input type="number" min="1" max="10000" step="1" value={maxPages} onChange={(event) => setMaxPages(event.target.value)} disabled={trigger.isPending || Boolean(activeRun)} placeholder="Full schedule" aria-describedby="max-pages-help" className="h-12 w-full rounded-xl border border-input bg-card px-3 text-sm font-semibold outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-55 sm:w-[150px]" data-testid="input-max-pages" />
          <span id="max-pages-help" className="mt-1 block text-[10px] text-muted-foreground">Blank fetches every matching page.</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={refresh} disabled={runs.isFetching || current.isFetching} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-bold text-foreground hover:-translate-y-0.5 hover:shadow-sm disabled:opacity-55" data-testid="button-refresh-ingestion-runs"><RefreshCw className={`h-4 w-4 ${runs.isFetching || current.isFetching ? 'animate-spin' : ''}`} /> Refresh</button>
          <button type="button" onClick={startIngestion} disabled={trigger.isPending || Boolean(activeRun)} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-55" data-testid="button-trigger-ingestion"><Play className="h-4 w-4" />{trigger.isPending ? 'Starting…' : activeRun ? 'Run in progress' : 'Start ingestion'}</button>
        </div>
      </div>}
    />

    {notice && <div className="mb-5 flex items-center gap-2 rounded-xl border border-chart-3/25 bg-chart-3/10 px-4 py-3 text-sm font-semibold text-chart-3" role="status" data-testid="status-ingestion-success"><Check className="h-4 w-4" />{notice}</div>}
    {(inputError || trigger.isError) && <div className="mb-5 flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm font-semibold text-destructive" role="alert" data-testid="status-ingestion-error"><CircleAlert className="h-4 w-4" />{inputError || trigger.error?.message || 'The ingestion run could not be started.'}</div>}

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-significance-settings">
      <div className="border-b border-border px-5 py-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Schedule-change alerts</p>
        <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Price reduction significance</h2>
        <p className="mt-1 text-sm text-muted-foreground">A reduction above the medium threshold is flagged medium; above the high threshold is flagged high.</p>
      </div>
       {significanceSettings.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : significanceSettings.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => significanceSettings.refetch()} /></div> : <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-end">
        <label className="block flex-1"><span className="mb-1.5 block text-xs font-bold">Medium reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={mediumThreshold} onChange={(event) => setMediumThreshold(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-medium-reduction-threshold" /></label>
        <label className="block flex-1"><span className="mb-1.5 block text-xs font-bold">High reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={highThreshold} onChange={(event) => setHighThreshold(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-high-reduction-threshold" /></label>
         <label className="flex flex-1 cursor-pointer items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"><input type="checkbox" checked={firstNewBrandHighSignificance} onChange={(event) => setFirstNewBrandHighSignificance(event.target.checked)} className="h-4 w-4 accent-primary" data-testid="checkbox-first-new-brand-high-significance" /><span><span className="block text-xs font-bold">First new brand is high</span><span className="block text-[10px] leading-relaxed text-muted-foreground">Only when the previous schedule had one brand.</span></span></label>
         <label className="block flex-1"><span className="mb-1.5 block text-xs font-bold">First new-brand reduction (%)</span><input type="number" min="0.001" max="100" step="0.1" value={firstNewBrandReductionPercentage} onChange={(event) => setFirstNewBrandReductionPercentage(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-first-new-brand-reduction" /></label>
        <button type="button" onClick={saveSignificanceSettings} disabled={updateSignificanceSettings.isPending} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-save-significance-settings">{updateSignificanceSettings.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save thresholds</button>
      </div>}
    </section>

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-pbs-watchlist">
      <div className="border-b border-border px-5 py-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">PBS ingestion scope</p>
        <h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Enabled watchlist</h2>
        <p className="mt-1 text-sm text-muted-foreground">Each enabled entry creates a filtered latest-schedule request. An empty watchlist never falls back to a full download.</p>
      </div>
      <div className="flex flex-col gap-3 border-b border-border bg-muted/20 p-4 sm:flex-row">
        <select value={watchlistType} onChange={(event) => setWatchlistType(event.target.value as PbsWatchlistEntry['filterType'])} className="h-11 rounded-xl border border-input bg-background px-3 text-sm font-semibold outline-none focus:border-primary" data-testid="select-watchlist-filter-type">
          <option value="atc_code">ATC code</option><option value="brand_name">Brand name</option><option value="drug_name">Drug name</option><option value="pbs_code">PBS code</option><option value="formulary">Formulary</option><option value="program_code">Program code</option>
        </select>
        <input value={watchlistValue} onChange={(event) => setWatchlistValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addWatchlistEntry(); }} placeholder={watchlistType === 'atc_code' ? 'e.g. N06BA' : 'Filter value'} className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" data-testid="input-watchlist-filter-value" />
        <button type="button" onClick={addWatchlistEntry} disabled={createWatchlistEntry.isPending} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50" data-testid="button-add-watchlist-entry"><Plus className="h-4 w-4" />Add filter</button>
      </div>
      {watchlist.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : watchlist.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => watchlist.refetch()} /></div> : !watchlist.data?.length ? <p className="p-5 text-sm text-muted-foreground">No filters configured. Add an enabled entry before starting an ingestion.</p> : <div className="divide-y divide-border">{watchlist.data.map((entry) => <div key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid={`row-watchlist-entry-${entry.id}`}><span className="rounded-md bg-muted px-2 py-1 font-mono text-[10px] font-bold text-muted-foreground">{entry.filterType}</span><span className="min-w-0 flex-1 truncate font-mono text-sm font-bold">{entry.filterValue}</span><button type="button" onClick={() => toggleWatchlistEntry(entry)} disabled={updateWatchlistEntry.isPending} className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] ${entry.enabled ? 'bg-chart-3/15 text-chart-3' : 'bg-muted text-muted-foreground'}`} data-testid={`button-toggle-watchlist-${entry.id}`}>{entry.enabled ? 'Enabled' : 'Disabled'}</button><button type="button" onClick={() => removeWatchlistEntry(entry)} disabled={deleteWatchlistEntry.isPending} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50" aria-label={`Remove ${entry.filterValue}`} data-testid={`button-delete-watchlist-${entry.id}`}><Trash2 className="h-4 w-4" /></button></div>)}</div>}
    </section>

    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-xs" aria-live="polite" data-testid="card-current-ingestion">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Current run</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Live ingestion progress</h2></div>
        {activeRun ? <IngestionStatus status={activeRun.status} /> : <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Idle</span>}
      </div>
      {current.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : current.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => current.refetch()} /></div> : activeRun ? <div className="grid gap-4 p-5 sm:grid-cols-4">
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Run ID</p><p className="mt-2 font-mono text-lg font-bold">#{activeRun.id}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Items mapped</p><p className="mt-2 font-mono text-lg font-bold" data-testid="text-current-records-processed">{activeRun.recordsProcessed.toLocaleString('en-AU')}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Pages fetched</p><p className="mt-2 font-mono text-lg font-bold" data-testid="text-current-pages-fetched">{activeRun.pagesFetched.toLocaleString('en-AU')}</p></div>
        <div className="rounded-xl bg-muted/55 p-4"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Started</p><p className="mt-2 text-sm font-bold">{formatDateTime(activeRun.startedAt)}</p></div>
      </div> : <div className="flex items-start gap-4 p-6"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><DatabaseZap className="h-5 w-5" /></span><div><h3 className="font-bold">No ingestion is running.</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">Start a run when you are ready to fetch the latest PBS schedule into raw staging. Progress refreshes automatically while a run is active.</p></div></div>}
    </section>

    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs" data-testid="section-ingestion-history">
      <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Operational history</p><h2 className="mt-1 text-lg font-bold tracking-[-0.03em]">Recent ingestion runs</h2></div><span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{runs.data?.length ?? 0} shown</span></div>
      {runs.isLoading ? <div className="p-5"><QueryState kind="loading" /></div> : runs.isError ? <div className="p-5"><QueryState kind="error" onRetry={() => runs.refetch()} /></div> : !runs.data?.length ? <div className="p-10 text-center"><DatabaseZap className="mx-auto h-8 w-8 text-muted-foreground/50" /><h3 className="mt-3 font-bold">No runs have been recorded.</h3><p className="mt-1 text-sm text-muted-foreground">The first manual ingestion will appear here as soon as it starts.</p></div> : <div className="divide-y divide-border">
        <div className="hidden grid-cols-[.5fr_1fr_.8fr_.85fr_1fr] gap-4 bg-muted/35 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid"><span>Run</span><span>Status</span><span>Records</span><span>Started</span><span>Finished / issue</span></div>
        {runs.data.map((run) => <div key={run.id} className="grid gap-3 px-5 py-4 text-sm transition-colors hover:bg-secondary/25 md:grid-cols-[.5fr_1fr_.8fr_.85fr_1fr] md:items-center md:gap-4" data-testid={`row-ingestion-run-${run.id}`}>
          <span className="font-mono font-bold text-primary">#{run.id}</span>
          <IngestionStatus status={run.status} />
          <span className="font-mono font-bold">{run.recordsProcessed.toLocaleString('en-AU')}</span>
          <span className="text-xs text-muted-foreground">{formatDateTime(run.startedAt)}</span>
          <span className={`text-xs ${run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{run.errorMessage ? <span className="inline-flex items-start gap-1.5"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{run.errorMessage}</span> : run.finishedAt ? <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-chart-3" />{formatDateTime(run.finishedAt)}</span> : 'In progress'}</span>
        </div>)}
      </div>}
    </section>
  </AppShell>;
}

export { Dashboard, ArtgDirectory, StockPage, AdminPage };
