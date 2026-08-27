import { type ReactNode, useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  ClerkProvider,
  RedirectToSignIn,
  Show,
  SignIn,
  SignUp,
  useAuth,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { ArrowRight, BookOpen, CheckCircle2, Database, LockKeyhole, ShieldCheck } from "lucide-react";
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtgDirectory, AdminPage, Dashboard, StockPage } from "@/pages/pages";
import { ChangesPage } from "@/pages/changes";
import { AdminGuard } from "@/components/admin-guard";
import NotFound from "@/pages/not-found";
import { PbsDirectory } from "@/pages/pbs/PbsDirectory";
import { PbsItemEvidence } from "@/pages/pbs/PbsItemEvidence";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#168b98",
    colorForeground: "#0f172a",
    colorMutedForeground: "#64748b",
    colorDanger: "#c0443a",
    colorBackground: "#ffffff",
    colorInput: "#f1f5f9",
    colorInputForeground: "#0f172a",
    colorNeutral: "#dbe3ed",
    fontFamily: "DM Sans, sans-serif",
    borderRadius: "0.8rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-3xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent",
    footer: "!shadow-none !border-0 !bg-transparent",
    headerTitle: "text-[#0f172a] font-bold tracking-tight",
    headerSubtitle: "text-[#64748b]",
    socialButtonsBlockButtonText: "text-[#0f172a] font-semibold",
    formFieldLabel: "text-[#0f172a] font-semibold",
    footerActionLink: "text-[#168b98] font-semibold",
    footerActionText: "text-[#64748b]",
    dividerText: "text-[#64748b]",
    identityPreviewEditButton: "text-[#168b98]",
    formFieldSuccessText: "text-[#28775e]",
    alertText: "text-[#c0443a]",
    logoBox: "rounded-xl overflow-hidden",
    logoImage: "rounded-xl",
    socialButtonsBlockButton: "border-[#dbe3ed] bg-[#f1f5f9] hover:bg-[#e8eef5]",
    formButtonPrimary: "bg-[#168b98] text-white hover:bg-[#117480]",
    formFieldInput: "border-[#dbe3ed] bg-[#f1f5f9] text-[#0f172a]",
    footerAction: "border-t border-[#dbe3ed]",
    dividerLine: "bg-[#dbe3ed]",
    alert: "border-[#e8b7b2] bg-[#fff0ee]",
    otpCodeFieldInput: "border-[#d9d3c5] bg-[#f4f0e6]",
    formFieldRow: "gap-1",
    main: "gap-5",
  },
};

function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect to="/dashboard" />;

  return (
    <div className="min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
        <a href="/" className="flex items-center gap-3" data-testid="link-home-brand">
          <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <span className="absolute h-5 w-1 rounded bg-current" />
            <span className="absolute h-1 w-5 rounded bg-current" />
          </span>
          <span>
            <span className="block text-base font-bold tracking-[-0.04em]">dispense</span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground">PBS manager</span>
          </span>
        </a>
        <nav className="flex items-center gap-2">
          <a href="/sign-in" className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-bold text-muted-foreground hover:bg-card hover:text-foreground" data-testid="link-home-sign-in">Sign in</a>
          <a href="/sign-up" className="inline-flex h-11 items-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground shadow-sm hover:-translate-y-0.5 hover:shadow-md" data-testid="link-home-sign-up">Create account</a>
        </nav>
      </header>
      <main>
        <section className="relative mx-auto grid max-w-7xl gap-12 px-6 pb-20 pt-12 lg:grid-cols-[1fr_.8fr] lg:items-center lg:px-10 lg:pb-28 lg:pt-20">
          <div className="relative z-10 animate-rise-in">
            <div className="mb-6 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-info" /> For Australian pharmacy teams</div>
            <h1 className="max-w-[650px] text-[clamp(3.4rem,7vw,6.5rem)] font-bold leading-[.94] tracking-[-0.075em]">The right number,<br /><span className="text-primary">right when you need it.</span></h1>
            <p className="mt-7 max-w-[530px] text-lg leading-relaxed text-muted-foreground">A focused workspace for PBS pricing, ARTG registrations and the stock records that belong to your pharmacy — not a generic admin system.</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a href="/sign-up" className="inline-flex h-12 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-md hover:-translate-y-1 hover:shadow-lg" data-testid="button-home-start">Start with dispense <ArrowRight className="h-4 w-4" /></a>
              <a href="/sign-in" className="inline-flex h-12 items-center rounded-xl border border-border bg-card px-5 text-sm font-bold hover:-translate-y-0.5 hover:shadow-sm" data-testid="button-home-existing">I already have an account</a>
            </div>
            <div className="mt-10 flex items-center gap-3 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 text-success" /> Your stock stays private to your account</div>
          </div>
          <div className="relative animate-rise-in delay-2">
            <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-accent/25 blur-3xl" />
            <div className="relative overflow-hidden rounded-[2rem] border border-sidebar-border bg-sidebar p-5 text-sidebar-foreground shadow-xl sm:p-7">
              <div className="grid-paper absolute inset-0 opacity-[.08]" />
              <div className="relative">
                <div className="flex items-center justify-between border-b border-sidebar-border pb-5"><div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-sidebar-foreground/50">Today / 08:42</p><p className="mt-1 text-lg font-bold">Reference desk</p></div><span className="flex items-center gap-1.5 rounded-full bg-sidebar-accent px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent" /> Live</span></div>
                <div className="mt-5 rounded-2xl border border-sidebar-border bg-sidebar-accent/55 p-4"><div className="flex items-start justify-between"><div><p className="font-mono text-[10px] text-accent">PBS ITEM / 1234K</p><p className="mt-2 text-base font-bold">Crestor 10 mg</p><p className="mt-1 text-xs text-sidebar-foreground/55">Rosuvastatin · AstraZeneca Australia</p></div><span className="rounded-md bg-sidebar-primary px-2 py-1 font-mono text-[10px] font-bold text-sidebar-primary-foreground">F1</span></div><div className="mt-5 rounded-xl bg-sidebar p-3"><p className="font-mono text-[9px] text-sidebar-foreground/45">EX-MANUFACTURER / WHOLESALE PRICE</p><p className="mt-1 font-mono text-sm font-bold">$18.42</p></div></div>
                <div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-accent p-4 text-accent-foreground"><p className="font-mono text-[9px] font-bold uppercase tracking-wider opacity-60">Units on hand</p><p className="mt-2 text-3xl font-bold tracking-[-.06em]">247</p><p className="mt-1 text-xs opacity-70">across 31 lines</p></div><div className="rounded-2xl border border-sidebar-border p-4"><p className="font-mono text-[9px] uppercase tracking-wider text-sidebar-foreground/45">Price history</p><div className="mt-4 flex h-8 items-end gap-1"><span className="h-3 w-2 rounded-t bg-chart-3/50" /><span className="h-5 w-2 rounded-t bg-chart-3/60" /><span className="h-4 w-2 rounded-t bg-chart-3/70" /><span className="h-7 w-2 rounded-t bg-accent" /><span className="h-6 w-2 rounded-t bg-accent" /><span className="h-8 w-2 rounded-t bg-accent" /></div><p className="mt-2 text-xs text-sidebar-foreground/65">Last updated today</p></div></div>
              </div>
            </div>
          </div>
        </section>
        <section className="border-y border-border bg-card/60"><div className="mx-auto grid max-w-7xl gap-px bg-border sm:grid-cols-3"><div className="bg-card/60 px-6 py-8 lg:px-10"><BookOpen className="h-5 w-5 text-info" /><h2 className="mt-4 font-bold">PBS, without the noise</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Find a listing, see current ex-manufacturer and wholesale prices, and follow the price trail from one calm screen.</p></div><div className="bg-card/60 px-6 py-8 lg:px-10"><Database className="h-5 w-5 text-info" /><h2 className="mt-4 font-bold">Registration confidence</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Search ARTG details by product, ingredient, sponsor or status when a decision needs a second check.</p></div><div className="bg-card/60 px-6 py-8 lg:px-10"><LockKeyhole className="h-5 w-5 text-info" /><h2 className="mt-4 font-bold">Your shelves, your view</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Track quantities and purchase prices in a private workspace designed for the people who use it.</p></div></div></section>
        <section className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-6 py-20 lg:flex-row lg:items-end lg:px-10"><div><p className="font-mono text-[10px] font-bold uppercase tracking-[.18em] text-muted-foreground">Built for the counter</p><h2 className="mt-3 max-w-xl text-4xl font-bold leading-tight tracking-[-.06em] md:text-5xl">Less hunting.<br />More certainty.</h2></div><div className="max-w-md"><p className="text-sm leading-relaxed text-muted-foreground">Dispense keeps the public reference desk and private stock shelf close together, without mixing the two. It is quick enough for a busy dispensary and thoughtful enough to trust.</p><a href="/sign-up" className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-primary hover:gap-3" data-testid="link-home-bottom-cta">Create your workspace <ArrowRight className="h-4 w-4" /></a></div></section>
      </main>
      <footer className="border-t border-border px-6 py-6 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span className="font-mono text-[10px] uppercase tracking-[.14em]">dispense / PBS manager</span><span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> A practical workspace for pharmacy teams</span></div></footer>
    </div>
  );
}

function AuthScreen({ mode }: { mode: "sign-in" | "sign-up" }) {
  return (
    <div className="grid min-h-[100dvh] bg-background lg:grid-cols-[.8fr_1.2fr]">
      <div className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <a href="/" className="flex items-center gap-3" data-testid="link-auth-brand"><span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><span className="absolute h-5 w-1 rounded bg-current" /><span className="absolute h-1 w-5 rounded bg-current" /></span><span><span className="block font-bold">dispense</span><span className="font-mono text-[9px] uppercase tracking-[.2em] text-sidebar-foreground/50">PBS manager</span></span></a>
        <div className="max-w-sm"><p className="font-mono text-[10px] font-bold uppercase tracking-[.18em] text-accent">A calmer reference desk</p><h1 className="mt-5 text-5xl font-bold leading-[.98] tracking-[-.07em]">The right number, right when you need it.</h1><p className="mt-6 text-sm leading-relaxed text-sidebar-foreground/60">PBS reference data and private stock records for Australian pharmacy teams.</p></div>
      </div>
      <div className="flex items-center justify-center px-4 py-10"><div className="w-full max-w-[440px]"><div className="mb-7 flex items-center justify-between lg:hidden"><a href="/" className="flex items-center gap-2 font-bold" data-testid="link-auth-mobile-brand"><span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground"><span className="absolute h-4 w-1 rounded bg-current" /><span className="absolute h-1 w-4 rounded bg-current" /></span>dispense</a><a href="/" className="text-xs font-bold text-muted-foreground hover:text-foreground" data-testid="link-auth-mobile-home">Back home</a></div>{mode === "sign-in" ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /> : <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />}</div></div>
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="flex min-h-[100dvh] items-center justify-center bg-background"><div className="w-56 space-y-3"><div className="skeleton-bar h-3 rounded bg-muted" /><div className="skeleton-bar h-10 rounded-xl bg-muted" /></div></div>;
  if (!isSignedIn) return <RedirectToSignIn />;
  return <>{children}</>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) client.clear();
    previousUserId.current = userId;
  }), [addListener, client]);
  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={Home} />
    <Route path="/sign-in/*?" component={() => <AuthScreen mode="sign-in" />} />
    <Route path="/sign-up/*?" component={() => <AuthScreen mode="sign-up" />} />
    <Route path="/dashboard" component={() => <Protected><Dashboard /></Protected>} />
    <Route path="/changes" component={() => <Protected><ChangesPage /></Protected>} />
    <Route path="/pbs" component={() => <Protected><PbsDirectory /></Protected>} />
    <Route path="/pbs/:itemCode" component={() => <Protected><PbsItemEvidence /></Protected>} />
    <Route path="/artg" component={() => <Protected><ArtgDirectory /></Protected>} />
    <Route path="/stock" component={() => <Protected><StockPage /></Protected>} />
    <Route path="/admin" component={() => <Protected><AdminGuard><AdminPage /></AdminGuard></Protected>} />
    <Route component={NotFound} />
  </Switch></RoutedErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: "Welcome back", subtitle: "Your reference desk is ready." } }, signUp: { start: { title: "Create your workspace", subtitle: "PBS clarity for your pharmacy team." } } }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ClerkQueryClientCacheInvalidator />
        <Router />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </ClerkProvider>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}

export default App;
