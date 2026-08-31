import { AppShell, PageHeading } from "@/components/app-shell";
import { AlertTriangle, CalendarClock, CircleHelp, GitBranch, Layers3, ShieldCheck } from "lucide-react";

const mechanismCards = [
  {
    icon: CircleHelp,
    label: "Why prices fall",
    title: "Three forces move PBS prices",
    accent: "bg-primary/10 text-primary",
    body: "PBS prices can fall because a medicine has been on the market for long enough, because competition arrives through a first new brand, or because disclosed transaction prices show that the approved price is no longer aligned with real-world prices.",
    detail: "The workspace keeps these mechanisms separate because each one has a different trigger, evidence base and timing.",
    example: "A medicine can have an anniversary date, a first-new-brand event and a price-disclosure signal, but each is assessed under its own rules.",
  },
  {
    icon: GitBranch,
    label: "Reductions do not stack",
    title: "One applicable pathway at a time",
    accent: "bg-warning/10 text-warning-foreground",
    body: "Anniversary and first-new-brand reductions are mutually exclusive. The 5-, 10- and 15-year anniversary reductions do not apply if a first-new-brand reduction has applied, and a first-new-brand reduction does not apply if the 15-year anniversary reduction has already applied.",
    detail: "This follows the interaction of the statutory rules in Division 3A of the National Health Act. The app reflects this by not showing the same drug as receiving both pathways.",
    example: "If a first new brand triggers the applicable reduction before the 15-year anniversary event, the prediction does not also apply the anniversary reduction.",
  },
  {
    icon: CalendarClock,
    label: "Anniversary reductions",
    title: "Five, ten and fifteen years",
    accent: "bg-info/10 text-info",
    body: "For eligible F1 items, the anniversary mechanism is applied on 1 April after the relevant anniversary: 5% at five years, 5% at ten years, and 26.1% at fifteen years before the 1 April 2027 step-up.",
    detail: "From 1 April 2027, the 15-year rate is 30%. All statutory price reductions are capped at 60% off the brand's AEMP, using the 1 January 2016 AEMP or, for items listed later, the AEMP at listing. The app rounds a date-based anniversary forward to the next 1 April and shows the reference AEMP used for that cap.",
    example: "A 10-year anniversary falling in September is modelled on the following 1 April, not on the September anniversary day.",
  },
  {
    icon: ShieldCheck,
    label: "Section 99ACP",
    title: "A separate 1.48% event",
    accent: "bg-success/10 text-success",
    body: "Section 99ACP is modelled separately from the 15-year anniversary reduction. It is scheduled on the actual 15th PBS anniversary date and does not replace the 15-year 1 April event.",
    detail: "When both mechanisms are relevant, they remain separate predictions so a pharmacy team can see the different legal triggers and dates.",
    example: "A medicine first listed on 15 June 2012 receives a separate 99ACP prediction on 15 June 2027.",
  },
  {
    icon: Layers3,
    label: "First New Brand",
    title: "Up to 25%, subject to discretion",
    accent: "bg-warning/10 text-warning-foreground",
    body: "An eligible first-new-brand event is modelled from the pre-event AEMP. The maximum reduction is 25%, but an existing effective price below AEMP can limit the reduction to that lower price.",
    detail: "Our modelling assumption uses 1 October 2018 as the date-based eligibility cutoff, matching the PBS-published transition to an FNB reduction of up to 25%. Predictions remain conditional because the statutory outcome is subject to Ministerial discretion.",
    example: "A $100 pre-event AEMP normally predicts $75. If the existing effective price is $80, the prediction is $80 instead.",
  },
  {
    icon: CircleHelp,
    label: "Price disclosure",
    title: "Published and indicative signals",
    accent: "bg-primary/10 text-primary",
    body: "The workspace displays confirmed or indicative PBS price-disclosure signals when their published source data is available, alongside the configured WADP gap checks.",
    detail: "These signals are kept distinct from anniversary and first-new-brand mechanisms because their evidence and timing are different.",
    example: "A published future AEMP supersedes an indicative prediction for the same item and date.",
  },
];

export function ReductionInfoPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Reference guide / reductions"
        title="How PBS reductions work"
        description="A plain-language guide to the mechanisms shown in Upcoming changes. Rules and source evidence can change; use the linked PBS source material and published reports for final decisions."
      />

      <div className="space-y-6">
        <section className="rounded-2xl border border-info/20 bg-info/5 p-5 sm:p-6" data-testid="panel-reduction-guide-intro">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-info" />
            <div>
              <h2 className="font-bold text-foreground">Predictions are decision support, not a legal instrument</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                The app combines PBS schedule dates, item pricing, historical AEMP evidence and published report data. A prediction should be checked against the operative PBS schedule, pricing instruments and any applicable Ministerial decision before action.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6" data-testid="panel-reduction-glossary">
          <details open>
            <summary className="cursor-pointer list-none font-bold text-foreground marker:hidden">
              <span className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <CircleHelp className="h-4 w-4" />
                </span>
                Key terms
              </span>
            </summary>
            <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-border pt-5 sm:grid-cols-2">
              <div>
                <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">AEMP</dt>
                <dd className="mt-1 text-sm leading-relaxed text-foreground/80"><span className="font-semibold text-foreground">Approved Ex-Manufacturer Price</span> — the wholesale price the manufacturer is approved to charge, before wholesaler markup, pharmacy markup and dispensing fees. This is the wholesale price the app tracks.</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">WADP</dt>
                <dd className="mt-1 text-sm leading-relaxed text-foreground/80"><span className="font-semibold text-foreground">Weighted Average Disclosed Price</span> — the average of the actual, often discounted, transaction prices manufacturers disclose. When it is meaningfully below the approved price, the PBS can reset the price down to it.</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">F1 / F2</dt>
                <dd className="mt-1 text-sm leading-relaxed text-foreground/80"><span className="font-semibold text-foreground">Formulary categories</span> — F1 generally holds single-brand medicines with no generic or biosimilar competitor; F2 holds multi-brand medicines subject to price disclosure. A medicine moves from F1 to F2 when a first new brand lists.</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">SPR</dt>
                <dd className="mt-1 text-sm leading-relaxed text-foreground/80"><span className="font-semibold text-foreground">Statutory Price Reduction</span> — a price reduction applied automatically by law when its statutory trigger is met.</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">FNB</dt>
                <dd className="mt-1 text-sm leading-relaxed text-foreground/80"><span className="font-semibold text-foreground">First New Brand</span> — the first additional brand of a medicine to list, which can trigger a statutory price reduction.</dd>
              </div>
            </dl>
          </details>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {mechanismCards.map((card) => {
            const Icon = card.icon;
            return (
              <article key={card.label} className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6" data-testid={`card-reduction-${card.label.toLowerCase().replaceAll(" ", "-")}`}>
                <div className="flex items-start gap-4">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${card.accent}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{card.label}</p>
                    <h2 className="mt-1 text-xl font-bold tracking-[-0.03em]">{card.title}</h2>
                  </div>
                </div>
                <p className="mt-5 text-sm leading-relaxed text-foreground/80">{card.body}</p>
                <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">{card.detail}</p>
                <p className="mt-4 rounded-xl bg-muted/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground"><span className="font-bold text-foreground">Example: </span>{card.example}</p>
              </article>
            );
          })}
        </div>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6" data-testid="panel-anniversary-exemptions">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Exempt items</p>
              <h2 className="mt-1 text-xl font-bold tracking-[-0.03em]">Some items are treated differently</h2>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Some pharmaceutical items are exempt from the 15-year anniversary, first-new-brand and price-disclosure reductions, but not from the 5- and 10-year anniversary reductions. These exemptions commonly cover formulations intended for specific groups, such as children.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6" data-testid="panel-combination-flow-on">
          <div className="flex items-start gap-3">
            <Layers3 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Combination medicines</p>
              <h2 className="mt-1 text-xl font-bold tracking-[-0.03em]">Flow-on is not calculated here</h2>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Combination flow-on reductions require component-level AEMPs, component weights, listed status and the applicable relationship between the combination and each component. The current workspace does not persist that evidence, so it deliberately does not estimate a flow-on result or present an approximation.
              </p>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}