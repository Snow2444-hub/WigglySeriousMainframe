import { useState } from 'react';
import { useClerk, useUser } from '@clerk/react';
import { Link, useLocation } from 'wouter';
import {
  Activity,
  ArrowUpRight,
  Bell,
  BookOpen,
  Boxes,
  ClipboardList,
  Database,
  LogOut,
  Menu,
  PackageSearch,
  Settings2,
  ShieldCheck,
  TrendingDown,
  X,
  SlidersHorizontal,
  EyeOff
} from 'lucide-react';
import { useCurrentRole } from '@/components/admin-guard';
import {
  useGetPharmacyBrandPreferences,
  useClearPharmacyBrandPreferences,
  getGetPharmacyBrandPreferencesQueryKey,
  useGetDashboard,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDateValue } from '@/lib/date-format';

const navItems = [
  { href: '/', label: 'Upcoming changes', icon: TrendingDown },
  { href: '/dashboard', label: 'Overview', icon: Activity },
  { href: '/changes', label: 'PBS updates', icon: Bell },
  { href: '/pbs', label: 'PBS directory', icon: BookOpen },
  { href: '/artg', label: 'ARTG register', icon: Database },
  { href: '/stock', label: 'Private stock', icon: Boxes },
  { href: '/brand-preferences', label: 'Brand visibility', icon: SlidersHorizontal },
];

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-3" data-testid="link-brand-home">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-accent text-accent-foreground shadow-sm">
        <span className="absolute h-4 w-1 rounded-full bg-current" />
        <span className="absolute h-1 w-4 rounded-full bg-current" />
      </span>
      {!compact && (
        <span className="leading-none">
          <span className="block text-[15px] font-bold tracking-[-0.04em]">dispense</span>
          <span className="mt-1 block font-mono text-[9px] font-bold uppercase tracking-[0.19em] opacity-60">PBS manager</span>
        </span>
      )}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const roleQuery = useCurrentRole();
  const dashboardQuery = useGetDashboard();
  const initials = (user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0] ?? 'P').toUpperCase();
  const visibleNavItems = roleQuery.data?.role === 'admin'
    ? [...navItems, { href: '/admin', label: 'Data updates', icon: Settings2 }]
    : navItems;

  const { data: preferences } = useGetPharmacyBrandPreferences();
  const clearPreferences = useClearPharmacyBrandPreferences();
  const queryClient = useQueryClient();

  const handleClearPreferences = () => {
    clearPreferences.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries();
      }
    });
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground md:flex">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col bg-sidebar px-4 py-5 text-sidebar-foreground shadow-xl transition-transform duration-200 md:relative md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`} data-testid="nav-sidebar">
        <div className="mb-10 flex items-center justify-between px-2">
          <BrandMark />
          <button type="button" className="rounded-lg p-2 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden" onClick={() => setOpen(false)} aria-label="Close menu" data-testid="button-close-menu">
            <X className="h-4 w-4" />
          </button>
        </div>
          <div className="mb-3 px-3 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-sidebar-foreground/45">Workspace</div>
        <nav className="space-y-1" aria-label="Primary navigation">
          {visibleNavItems.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} onClick={() => setOpen(false)} className={`group flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold ${active ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm' : 'text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}>
                <Icon className={`h-[17px] w-[17px] ${active ? '' : 'opacity-65'}`} />
                <span>{item.label}</span>
                {item.href === '/stock' && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-2xl border border-sidebar-border bg-sidebar-accent/45 p-4">
          <div className="mb-3 flex items-center gap-2 text-accent">
            <ShieldCheck className="h-4 w-4" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.13em]">Private by default</span>
          </div>
          <p className="text-xs leading-relaxed text-sidebar-foreground/62">Your stock records are private to this pharmacy account.</p>
          <Link href="/stock" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-accent hover:text-sidebar-primary-foreground" data-testid="link-sidebar-stock">
            Review stock <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-sidebar-border px-2 pt-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground" data-testid="avatar-user">{initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-bold">{user?.firstName || 'Pharmacy team'}</span>
            <span className="block truncate text-[11px] text-sidebar-foreground/50">{user?.emailAddresses?.[0]?.emailAddress || 'Signed in'}</span>
          </span>
          <button type="button" onClick={() => signOut({ redirectUrl: '/' })} className="rounded-lg p-2 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label="Sign out" data-testid="button-sign-out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>
      {open && <button type="button" className="fixed inset-0 z-30 bg-sidebar/25 backdrop-blur-sm md:hidden" onClick={() => setOpen(false)} aria-label="Close navigation" data-testid="button-overlay-close" />}
      <main className="min-w-0 flex-1 overflow-x-hidden">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-md md:px-10">
          <button type="button" className="rounded-xl border border-border bg-card p-2.5 text-muted-foreground hover:text-foreground md:hidden" onClick={() => setOpen(true)} aria-label="Open menu" data-testid="button-open-menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            <ClipboardList className="h-4 w-4 text-info" />
            <span className="font-medium">Australian medicines workspace</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {preferences && preferences.hiddenBrandCount > 0 && (
              <div className="flex animate-rise-in items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground sm:gap-3 sm:px-3">
                <span className="flex items-center gap-1.5 font-bold">
                  <EyeOff className="h-3.5 w-3.5" />
                  <span className="font-mono">{preferences.hiddenItemCount}</span>
                  <span className="hidden sm:inline">PBS listing{preferences.hiddenItemCount === 1 ? '' : 's'} hidden</span>
                  <span className="sm:hidden">hidden</span>
                </span>
                <div className="hidden h-3 w-px bg-warning/30 sm:block" />
                <button
                  onClick={handleClearPreferences}
                  disabled={clearPreferences.isPending}
                  className="font-bold underline decoration-warning/40 underline-offset-2 hover:decoration-warning disabled:opacity-50"
                >
                  <span className="hidden sm:inline">Show all</span><span className="sm:hidden">Show</span>
                </button>
              </div>
            )}
            <div className="hidden max-w-[min(62vw,680px)] items-center gap-2 overflow-x-auto rounded-xl border border-border bg-card px-3 py-1.5 text-[10px] sm:flex" data-testid="schedule-metadata">
              {dashboardQuery.isLoading ? <span className="font-mono font-bold uppercase tracking-[0.12em] text-muted-foreground">Checking schedule…</span> :
               dashboardQuery.isError || !dashboardQuery.data ? <span className="font-mono font-bold uppercase tracking-[0.12em] text-warning">Schedule unavailable</span> :
               dashboardQuery.data.currentSchedule.status === 'in_progress' ? <span className="font-mono font-bold uppercase tracking-[0.12em] text-warning">PBS ingestion in progress</span> :
               dashboardQuery.data.currentSchedule.status === 'available' ? <span className="whitespace-nowrap font-mono font-bold uppercase tracking-[0.1em] text-muted-foreground" title={`Schedule ${dashboardQuery.data.currentSchedule.scheduleCode} · effective ${dashboardQuery.data.currentSchedule.effectiveDate ?? 'date unavailable'} · last successful ingestion ${dashboardQuery.data.currentSchedule.lastSuccessfulIngestionAt ?? 'unavailable'}`}>Schedule {dashboardQuery.data.currentSchedule.scheduleCode} · {dashboardQuery.data.currentSchedule.effectiveDate ?? 'date unavailable'} · ingested {formatDateValue(dashboardQuery.data.currentSchedule.lastSuccessfulIngestionAt, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span> :
               <span className="font-mono font-bold uppercase tracking-[0.12em] text-warning">Schedule metadata unavailable</span>}
            </div>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted font-mono text-xs font-bold text-muted-foreground md:hidden">{initials}</span>
          </div>
        </header>
        <div className="mx-auto max-w-[1400px] px-5 py-7 md:px-10 md:py-10">{children}</div>
      </main>
    </div>
  );
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div className="animate-rise-in">
        <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-info" /> {eyebrow}
        </div>
        <h1 className="text-3xl font-bold tracking-[-0.055em] text-foreground md:text-[42px]">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action && <div className="animate-rise-in delay-1 md:shrink-0">{action}</div>}
    </div>
  );
}

export function QueryState({ kind, onRetry }: { kind: 'loading' | 'error' | 'empty'; onRetry?: () => void }) {
  if (kind === 'loading') {
    return <div className="space-y-3 rounded-2xl border border-border bg-card p-6" data-testid="status-loading"><div className="skeleton-bar h-4 w-1/3 rounded bg-muted" /><div className="skeleton-bar h-10 w-full rounded-lg bg-muted" /><div className="skeleton-bar h-10 w-5/6 rounded-lg bg-muted" /></div>;
  }
  if (kind === 'error') {
    return <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-8 text-center" data-testid="status-error"><p className="font-semibold text-destructive">Reference data could not be loaded.</p><p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>{onRetry && <button type="button" onClick={onRetry} className="mt-4 inline-flex h-11 items-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground hover:-translate-y-0.5" data-testid="button-retry">Try again</button>}</div>;
  }
  return <div className="rounded-2xl border border-dashed border-border bg-card/60 p-12 text-center" data-testid="status-empty"><PackageSearch className="mx-auto h-8 w-8 text-muted-foreground/50" /><p className="mt-3 font-semibold">Nothing matched that search</p><p className="mt-1 text-sm text-muted-foreground">Try a broader name, ingredient, or code.</p></div>;
}
