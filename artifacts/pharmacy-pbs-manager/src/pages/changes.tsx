import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  type ScheduleChange,
  type ListScheduleChangesChangeType,
  type ListScheduleChangesSignificance,
  useListScheduleChanges,
  useGetDrugScheduleTimeline,
  useListDrugs,
  getListScheduleChangesQueryKey,
  getGetDrugScheduleTimelineQueryKey
} from '@workspace/api-client-react';
import { AppShell, PageHeading, QueryState } from '@/components/app-shell';
import { reductionBadgeClass, reductionBorderClass, reductionTextClass } from '@/lib/percentage-significance';
import { Filter, X, History, ArrowRight, AlertCircle, AlertTriangle, Activity, ChevronDown } from 'lucide-react';
import { Link } from 'wouter';

const money = (value: unknown) => {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
};

const date = (value: string) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
};

const typeLabels: Record<string, string> = {
  new_item: 'New item',
  new_brand: 'New brand',
  delisted: 'Delisted',
  price_change: 'Price update',
  formulary_change: 'Formulary change',
  premium_added: 'Premium added',
  premium_changed: 'Premium updated',
  premium_removed: 'Premium removed',
  published_fnb_new: 'New FNB register entry'
};

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function changeBrandName(change: ScheduleChange): string | null {
  const next = objectValue(change.newValue);
  const previous = objectValue(change.oldValue);
  return change.brandName || textValue(next.brand_name) || textValue(previous.brand_name);
}

function changeStrength(change: ScheduleChange): string | null {
  const next = objectValue(change.newValue);
  return textValue(next.strength) || textValue(next.strength_text);
}

function changePbsCode(change: ScheduleChange): string | null {
  const next = objectValue(change.newValue);
  return change.pbsCode || textValue(next.pbs_code);
}

function changeItemCode(change: ScheduleChange): string | null {
  const next = objectValue(change.newValue);
  const previous = objectValue(change.oldValue);
  return change.liItemId
    || textValue(next.li_item_id)
    || textValue(previous.li_item_id)
    || change.affectedItems?.[0]?.liItemId
    || null;
}

type TimelineGroup = {
  key: string;
  representative: ScheduleChange;
  changes: ScheduleChange[];
  brands: string[];
  itemLabels: string[];
};

type TimelineDateGroup = {
  date: string;
  groups: TimelineGroup[];
};

type ScheduleEventGroup = {
  key: string;
  drugId: number;
  drugName: string;
  effectiveDate: string;
  scheduleCode: number;
  changes: ScheduleChange[];
  brands: string[];
  itemLabels: string[];
};

function timelineGroupKey(change: ScheduleChange): string {
  const oldValue = objectValue(change.oldValue);
  const newValue = objectValue(change.newValue);
  const brandKey = changeBrandName(change)?.trim().toLowerCase() || '';

  if (change.changeType === 'price_change') {
    return [
      change.changeType,
      oldValue.determined_price ?? '',
      newValue.determined_price ?? '',
      newValue.percentage_change ?? '',
    ].join(':');
  }
  if (change.changeType === 'formulary_change') {
    return `${change.changeType}:${oldValue.formulary ?? ''}:${newValue.formulary ?? ''}`;
  }
  if (change.changeType === 'new_item' || change.changeType === 'new_brand') {
    return `${change.changeType}:${brandKey}`;
  }
  if (change.changeType === 'delisted') {
    return `${change.changeType}:${brandKey}:${oldValue.determined_price ?? ''}`;
  }
  if (change.changeType === 'published_fnb_new') {
    return `${change.changeType}:${newValue.manner_of_administration ?? ''}:${newValue.date_of_effect ?? ''}`;
  }
  return change.changeType;
}

function changeItemLabels(change: ScheduleChange): string[] {
  if (change.affectedItems?.length) {
    return change.affectedItems.map((item) => {
      const label = item.strength || item.pbsCode;
      return item.brandName && label ? `${item.brandName} · ${label}` : item.brandName || label || 'PBS listing';
    });
  }

  const brand = changeBrandName(change);
  const strength = changeStrength(change);
  const pbsCode = changePbsCode(change);
  const label = [brand, strength || pbsCode].filter(Boolean).join(' · ');
  return label ? [label] : [];
}

function addUnique(values: string[], additions: string[]): string[] {
  const next = [...values];
  for (const value of additions) {
    if (value && !next.includes(value)) next.push(value);
  }
  return next;
}

function scheduleEventKey(change: ScheduleChange): string {
  return `${change.drugId}:${change.effectiveDate}:${change.scheduleCode}`;
}

function groupScheduleChanges(changes: ScheduleChange[]): ScheduleEventGroup[] {
  const groups = new Map<string, ScheduleEventGroup>();

  for (const change of changes) {
    const key = scheduleEventKey(change);
    const group = groups.get(key) ?? {
      key,
      drugId: change.drugId,
      drugName: change.drugName,
      effectiveDate: change.effectiveDate,
      scheduleCode: change.scheduleCode,
      changes: [],
      brands: [],
      itemLabels: [],
    };
    group.changes.push(change);
    const brand = changeBrandName(change);
    group.brands = addUnique(group.brands, [
      ...(brand ? [brand] : []),
      ...(change.affectedItems ?? []).map((item) => item.brandName),
    ]);
    group.itemLabels = addUnique(group.itemLabels, changeItemLabels(change));
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    const dateOrder = right.effectiveDate.localeCompare(left.effectiveDate);
    if (dateOrder !== 0) return dateOrder;
    return left.drugName.localeCompare(right.drugName);
  });
}

function eventSummary(group: ScheduleEventGroup): string {
  const types = new Set(group.changes.map((change) => change.changeType));
  const parts: string[] = [];
  if (types.has('new_brand')) parts.push(group.brands.length > 1 ? `${group.brands.length} new brands` : 'new brand');
  if (types.has('new_item')) parts.push('new listing');
  if (types.has('price_change')) parts.push(group.brands.length > 1 ? `price update across ${group.brands.length} brands` : 'price update');
  if (types.has('formulary_change')) parts.push('formulary update');
  if (types.has('delisted')) parts.push('delisting');
  if (types.has('published_fnb_new')) parts.push('FNB register entry');
  if (parts.length === 0) return 'Schedule update';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function significanceForChanges(changes: ScheduleChange[]): 'normal' | 'medium' | 'high' {
  if (changes.some((change) => change.significance === 'high')) return 'high';
  if (changes.some((change) => change.significance === 'medium')) return 'medium';
  return 'normal';
}

function eventSignificance(group: ScheduleEventGroup): 'normal' | 'medium' | 'high' {
  return significanceForChanges(group.changes);
}

function EventDetails({ group }: { group: ScheduleEventGroup }) {
  const priceChange = group.changes.find((change) => change.changeType === 'price_change');
  const formularyChange = group.changes.find((change) => change.changeType === 'formulary_change');
  const newBrandChange = group.changes.find((change) => change.changeType === 'new_brand');

  if (priceChange) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ChangeDetails change={priceChange} />
        {group.brands.length > 1 && <span className="text-xs font-semibold text-muted-foreground">across {group.brands.length} brands</span>}
      </div>
    );
  }
  if (formularyChange && group.changes.length === 1) return <ChangeDetails change={formularyChange} />;
  if (newBrandChange) {
    const impact = eventSignificance(group);
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        <span className={reductionTextClass(impact)}>Brand added</span>
        <span className="text-muted-foreground">across {group.brands.length} brand{group.brands.length === 1 ? '' : 's'}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${reductionBadgeClass(impact)}`}>
          {group.itemLabels.length || group.changes.length} listing{(group.itemLabels.length || group.changes.length) === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted-foreground">
      {group.brands.slice(0, 2).map((brand) => <span key={brand}>{brand}</span>)}
      {group.brands.length > 2 && <span>+{group.brands.length - 2} brands</span>}
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold">
        {group.itemLabels.length || group.changes.length} item{(group.itemLabels.length || group.changes.length) === 1 ? '' : 's'}
      </span>
    </div>
  );
}

type PriceChangeListing = {
  liItemId: string | null;
  pbsCode: string | null;
  brandName: string;
  strength: string | null;
};

type BrandPriceGroup = {
  key: string;
  brandName: string;
  strength: string | null;
  listings: PriceChangeListing[];
};

type PriceChangeGroup = {
  key: string;
  representative: ScheduleChange;
  brands: BrandPriceGroup[];
  brandCount: number;
  listingCount: number;
  reductionMagnitude: number;
};

function priceChangeListings(change: ScheduleChange): PriceChangeListing[] {
  if (change.affectedItems?.length) {
    return change.affectedItems.map((item) => ({
      liItemId: item.liItemId,
      pbsCode: item.pbsCode,
      brandName: item.brandName,
      strength: item.strength,
    }));
  }
  return [{
    liItemId: changeItemCode(change),
    pbsCode: changePbsCode(change),
    brandName: changeBrandName(change) || change.drugName,
    strength: changeStrength(change),
  }];
}

function priceChangeGroupKey(change: ScheduleChange): string {
  const oldValue = objectValue(change.oldValue);
  const newValue = objectValue(change.newValue);
  return [
    oldValue.determined_price ?? '',
    newValue.determined_price ?? '',
    newValue.percentage_change ?? '',
  ].join(':');
}

function priceChangeReductionMagnitude(change: ScheduleChange): number {
  const percentage = objectValue(change.newValue).percentage_change;
  return typeof percentage === 'number' ? Math.abs(percentage) : 0;
}

function groupPriceChanges(changes: ScheduleChange[]): PriceChangeGroup[] {
  const groups = new Map<string, { representative: ScheduleChange; listings: PriceChangeListing[] }>();
  for (const change of changes) {
    const key = priceChangeGroupKey(change);
    const current = groups.get(key) ?? { representative: change, listings: [] };
    current.listings.push(...priceChangeListings(change));
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, group]) => {
    const brandMap = new Map<string, BrandPriceGroup>();
    for (const listing of group.listings) {
      const brandKey = listing.brandName;
      const brand = brandMap.get(brandKey) ?? {
        key: brandKey,
        brandName: listing.brandName,
        strength: listing.strength,
        listings: [],
      };
      if (brand.listings.length > 0 && brand.strength !== listing.strength) {
        brand.strength = null;
      }
      if (!brand.listings.some((candidate) => candidate.liItemId === listing.liItemId && candidate.pbsCode === listing.pbsCode)) {
        brand.listings.push(listing);
      }
      brandMap.set(brandKey, brand);
    }
    const brands = [...brandMap.values()].sort((left, right) =>
      left.brandName.localeCompare(right.brandName) || (left.strength ?? '').localeCompare(right.strength ?? ''),
    );
    return {
      key,
      representative: group.representative,
      brands,
      brandCount: new Set(group.listings.map((listing) => listing.brandName)).size,
      listingCount: brands.reduce((count, brand) => count + brand.listings.length, 0),
      reductionMagnitude: priceChangeReductionMagnitude(group.representative),
    };
  }).sort((left, right) => right.reductionMagnitude - left.reductionMagnitude);
}

function EventExpandedDetails({ group }: { group: ScheduleEventGroup }) {
  const [expandedPrices, setExpandedPrices] = useState<string[]>([]);
  const [expandedBrands, setExpandedBrands] = useState<string[]>([]);
  const priceGroups = groupPriceChanges(group.changes.filter((change) => change.changeType === 'price_change'));
  const otherChanges = group.changes.filter((change) => change.changeType !== 'price_change');
  const toggle = (setter: Dispatch<SetStateAction<string[]>>, key: string) => {
    setter((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  };
  const listings = (items: PriceChangeListing[]) => (
    <div className="divide-y divide-border/70 border-t border-border/70 bg-muted/15">
      {items.map((item, index) => {
        const label = [item.brandName, item.strength].filter(Boolean).join(' · ');
        const itemKey = item.liItemId ?? `${item.pbsCode}:${index}`;
        return item.liItemId ? (
          <Link key={itemKey} href={`/pbs/${encodeURIComponent(item.liItemId)}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-secondary/30">
            <span className="font-semibold text-foreground">{label}</span>
            <span className="font-mono font-bold text-muted-foreground">PBS {item.pbsCode || 'listing'}</span>
          </Link>
        ) : (
          <div key={itemKey} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
            <span className="font-semibold text-foreground">{label}</span>
            <span className="font-mono font-bold text-muted-foreground">PBS {item.pbsCode || 'listing'}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="border-t border-border/70 bg-muted/20 px-5 py-3">
      <div className="space-y-2">
        {priceGroups.map((priceGroup) => {
          const priceKey = `${group.key}:${priceGroup.key}`;
          const expanded = expandedPrices.includes(priceKey);
          const singleBrand = priceGroup.brandCount === 1;
          const directBrand = priceGroup.brands[0];
          const directLabel = directBrand ? [directBrand.brandName, directBrand.strength].filter(Boolean).join(' · ') : '';
          return (
            <div key={priceKey} className="overflow-hidden rounded-xl border border-border bg-card">
              <button type="button" onClick={() => toggle(setExpandedPrices, priceKey)} aria-expanded={expanded} className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-secondary/20">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <ChangeDetails change={priceGroup.representative} />
                  <span className="text-xs font-semibold text-muted-foreground">
                    {singleBrand ? directLabel : `${priceGroup.brandCount} brands`}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted-foreground">
                    {priceGroup.listingCount} listing{priceGroup.listingCount === 1 ? '' : 's'}
                  </span>
                </div>
                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded && (singleBrand ? listings(directBrand.listings) : (
                <div className="divide-y divide-border/70 border-t border-border/70 bg-muted/15">
                  {priceGroup.brands.map((brand) => {
                    const brandKey = `${priceKey}:${brand.key}`;
                    const brandExpanded = expandedBrands.includes(brandKey);
                    return (
                      <div key={brandKey}>
                        <button type="button" onClick={() => toggle(setExpandedBrands, brandKey)} aria-expanded={brandExpanded} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs hover:bg-secondary/25">
                          <span className="font-semibold text-foreground">{[brand.brandName, brand.strength].filter(Boolean).join(' · ')}</span>
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[10px] font-bold text-muted-foreground">{brand.listings.length} listing{brand.listings.length === 1 ? '' : 's'}</span>
                            <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${brandExpanded ? 'rotate-180' : ''}`} />
                          </span>
                        </button>
                        {brandExpanded && listings(brand.listings)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
        {otherChanges.map((change) => (
          <div key={change.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-3 text-xs">
            <span className="font-semibold text-foreground">{changeBrandName(change) || change.drugName}</span>
            <ChangeDetails change={change} />
          </div>
        ))}
      </div>
    </div>
  );
}

function groupTimelineChanges(changes: ScheduleChange[]): TimelineDateGroup[] {
  const dateGroups = new Map<string, TimelineDateGroup>();

  for (const change of changes) {
    let dateGroup = dateGroups.get(change.effectiveDate);
    if (!dateGroup) {
      dateGroup = { date: change.effectiveDate, groups: [] };
      dateGroups.set(change.effectiveDate, dateGroup);
    }

    const key = timelineGroupKey(change);
    let group = dateGroup.groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key: `${change.effectiveDate}:${key}`,
        representative: change,
        changes: [],
        brands: [],
        itemLabels: [],
      };
      dateGroup.groups.push(group);
    }

    group.changes.push(change);
    const brand = changeBrandName(change);
    if (brand) group.brands = addUnique(group.brands, [brand]);
    group.brands = addUnique(
      group.brands,
      (change.affectedItems ?? []).map((item) => item.brandName),
    );
    group.itemLabels = addUnique(group.itemLabels, changeItemLabels(change));
  }

  return [...dateGroups.values()];
}

function timelineGroupCanExpand(group: TimelineGroup): boolean {
  return group.changes.length > 1 || group.itemLabels.length > 1;
}

function TimelineGroupSummary({ group }: { group: TimelineGroup }) {
  const change = group.representative;
  const brandLabel = group.brands.length ? group.brands.join(', ') : 'Affected listings';
  const itemCount = group.itemLabels.length || group.changes.length;
  const significance = significanceForChanges(group.changes);

  if (change.changeType === 'price_change' || change.changeType === 'formulary_change') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <ChangeDetails change={change} />
        <span className="text-xs font-semibold text-muted-foreground">{brandLabel}</span>
      </div>
    );
  }

  if (change.changeType === 'new_item' || change.changeType === 'new_brand') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs font-semibold">
        <span className={reductionTextClass(significance)}>{change.changeType === 'new_brand' ? 'Brand added' : 'Added'}</span>
        <span className="truncate">{brandLabel}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${reductionBadgeClass(significance)}`}>
          {itemCount} listing{itemCount === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  if (change.changeType === 'delisted') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs font-semibold">
        <span className={reductionTextClass(significance)}>Removed</span>
        <span className="truncate">{brandLabel}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${reductionBadgeClass(significance)}`}>
          {itemCount} listing{itemCount === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  return <ChangeDetails change={change} />;
}

function TimelineGroupExpanded({ group }: { group: TimelineGroup }) {
  return (
    <div className="border-t border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="space-y-1.5">
        {group.changes.map((change) => {
          const itemLabels = changeItemLabels(change);
          const labels = itemLabels.length ? itemLabels : [changeBrandName(change) || 'Drug-level change'];
          return labels.map((label, index) => (
            <div key={`${change.id}-${index}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
              <span className="font-semibold text-foreground">{label}</span>
              {change.changeType === 'price_change' || change.changeType === 'formulary_change' ? (
                <ChangeDetails change={change} />
              ) : (
                <span className="font-mono text-muted-foreground">{changePbsCode(change) || 'PBS listing'}</span>
              )}
            </div>
          ));
        })}
      </div>
    </div>
  );
}

function ChangeDetails({ change }: { change: ScheduleChange }) {
  if (change.changeType === 'price_change') {
    const oldVal = change.oldValue as Record<string, number> | null;
    const newVal = change.newValue as Record<string, number> | null;
    const oldPrice = oldVal?.determined_price;
    const newPrice = newVal?.determined_price;
    const percentage = newVal?.percentage_change;
    return (
      <span className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className="text-muted-foreground line-through opacity-70">{money(oldPrice)}</span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-bold text-foreground">{money(newPrice)}</span>
        {typeof percentage === 'number' && <span className={`text-[11px] font-bold ${reductionTextClass(change.significance)}`}>{percentage.toFixed(2)}%</span>}
      </span>
    );
  }
  if (change.changeType === 'delisted') {
    const previous = objectValue(change.oldValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-destructive">Removed</span>
        {textValue(previous.brand_name) && <span>{textValue(previous.brand_name)}</span>}
        {typeof previous.determined_price === 'number' && <span className="font-mono">{money(previous.determined_price)}</span>}
        {textValue(previous.formulary) && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{textValue(previous.formulary)}</span>}
        {textValue(previous.pbs_code) && <span className="font-mono text-[10px] text-muted-foreground">{textValue(previous.pbs_code)}</span>}
      </span>
    );
  }
  if (change.changeType === 'new_item') {
    const added = objectValue(change.newValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-success">Added</span>
        {textValue(added.brand_name) && <span>{textValue(added.brand_name)}</span>}
        {typeof added.determined_price === 'number' && <span className="font-mono">{money(added.determined_price)}</span>}
        {textValue(added.formulary) && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{textValue(added.formulary)}</span>}
        {textValue(added.pbs_code) && <span className="font-mono text-[10px] text-muted-foreground">{textValue(added.pbs_code)}</span>}
      </span>
    );
  }
  if (change.changeType === 'new_brand') {
    const added = objectValue(change.newValue);
    const affectedItems = change.affectedItems ?? [];
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-success">Brand added</span>
        {textValue(added.brand_name) && <span>{textValue(added.brand_name)}</span>}
        <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono text-[10px] text-success">{affectedItems.length} item{affectedItems.length === 1 ? '' : 's'}</span>
        {affectedItems.map((item) => <span key={item.liItemId} className="font-mono text-[10px] text-muted-foreground">{item.strength || item.pbsCode || item.liItemId}</span>)}
      </span>
    );
  }
  if (change.changeType === 'formulary_change') {
    const oldVal = change.oldValue as Record<string, string> | null;
    const newVal = change.newValue as Record<string, string> | null;
    return (
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{oldVal?.formulary || '—'}</span> 
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /> 
        <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">{newVal?.formulary || '—'}</span>
      </span>
    );
  }
  if (
    change.changeType === 'premium_added' ||
    change.changeType === 'premium_changed' ||
    change.changeType === 'premium_removed'
  ) {
    const previous = objectValue(change.oldValue);
    const next = objectValue(change.newValue);
    const value = change.changeType === 'premium_removed' ? previous : next;
    const brandPremium = typeof value.brand_premium === 'number' ? value.brand_premium : null;
    const therapeuticGroupPremium = typeof value.therapeutic_group_premium === 'number'
      ? value.therapeutic_group_premium
      : null;
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        {brandPremium !== null && <span>Brand {money(brandPremium)}</span>}
        {therapeuticGroupPremium !== null && <span>Therapeutic {money(therapeuticGroupPremium)}</span>}
        {value.therapeutic_exemption_indicator === 'Y' && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Exempt</span>
        )}
      </span>
    );
  }
  if (change.changeType === 'published_fnb_new') {
    const added = objectValue(change.newValue);
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="text-info">Highlighted in PBS register</span>
        {textValue(added.manner_of_administration) && <span>{textValue(added.manner_of_administration)}</span>}
        {textValue(added.date_of_effect) && <span className="font-mono">{date(textValue(added.date_of_effect) as string)}</span>}
      </span>
    );
  }
  return <span className="text-sm text-muted-foreground">—</span>;
}

export function ChangesPage() {
  const [drugId, setDrugId] = useState<number | ''>('');
  const [changeType, setChangeType] = useState<ListScheduleChangesChangeType | ''>('');
  const [significance, setSignificance] = useState<ListScheduleChangesSignificance | ''>('');
  
  const [timelineDrugId, setTimelineDrugId] = useState<number | null>(null);
  const [timelineDrugName, setTimelineDrugName] = useState<string>('');
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState<string[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<string[]>([]);

  const params = useMemo(() => ({
    drugId: drugId || undefined,
    changeType: changeType || undefined,
    significance: significance || undefined,
    limit: 500
  }), [drugId, changeType, significance]);

  const query = useListScheduleChanges(params, {
    query: { queryKey: getListScheduleChangesQueryKey(params) }
  });

  const drugIndex = useListDrugs({ limit: 100 });
  
  const timeline = useGetDrugScheduleTimeline(timelineDrugId!, {
    query: {
      enabled: timelineDrugId !== null,
      queryKey: timelineDrugId ? getGetDrugScheduleTimelineQueryKey(timelineDrugId) : ['timeline-noop']
    }
  });

  const changes = query.data ?? [];
  const events = useMemo(() => groupScheduleChanges(changes), [changes]);
  const timelineGroups = useMemo(
    () => (timeline.data ? groupTimelineChanges(timeline.data) : []),
    [timeline.data],
  );

  const toggleEvent = (key: string) => {
    setExpandedEvents((current) => (
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
    ));
  };

  const toggleTimelineGroup = (key: string) => {
    setExpandedTimelineGroups((current) => (
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
    ));
  };

  return (
    <AppShell>
      <PageHeading 
        eyebrow="Alert desk / Schedule" 
        title="PBS updates" 
        description="Monitor schedule movements, pricing changes, and delistings across the PBS network." 
      />
      
      <div className="control-row mb-6">
        <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <select 
            value={drugId} 
            onChange={(e) => setDrugId(e.target.value ? Number(e.target.value) : '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-drug"
          >
            <option value="">All medicines</option>
            {drugIndex.data?.map(drug => (
              <option key={drug.id} value={drug.id}>{drug.name}</option>
            ))}
          </select>
        </label>
        
        <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <Filter className="h-4 w-4 text-info" />
          <select 
            value={changeType} 
            onChange={(e) => setChangeType(e.target.value as ListScheduleChangesChangeType | '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-type"
          >
            <option value="">All change types</option>
            <option value="new_item">New items</option>
            <option value="new_brand">New brands</option>
            <option value="delisted">Delisted</option>
            <option value="price_change">Price changes</option>
            <option value="formulary_change">Formulary changes</option>
            <option value="premium_added">Premiums added</option>
            <option value="premium_changed">Premiums updated</option>
            <option value="premium_removed">Premiums removed</option>
          </select>
        </label>
        
        <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <AlertTriangle className={`h-4 w-4 ${significance === 'high' ? 'text-destructive' : significance === 'medium' ? 'text-warning' : 'text-muted-foreground'}`} />
          <select 
            value={significance} 
            onChange={(e) => setSignificance(e.target.value as ListScheduleChangesSignificance | '')} 
            className="w-full bg-transparent text-sm font-semibold outline-none" 
            data-testid="select-changes-significance"
          >
            <option value="">All impact levels</option>
            <option value="high">High impact</option>
            <option value="medium">Medium impact</option>
            <option value="normal">Normal impact</option>
          </select>
        </label>
      </div>

      {query.isLoading ? (
        <QueryState kind="loading" />
      ) : query.isError ? (
        <QueryState kind="error" onRetry={() => query.refetch()} />
      ) : changes.length === 0 ? (
        <QueryState kind="empty" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
          <div className="hidden grid-cols-[.7fr_1.5fr_1fr_1fr_.5fr] gap-4 border-b border-border bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid">
            <span>Date</span>
            <span>Medicine</span>
            <span>Event</span>
            <span>Details</span>
            <span />
          </div>
          <div className="divide-y divide-border">
            {events.map((event) => {
              const impact = eventSignificance(event);
              const isExpanded = expandedEvents.includes(event.key);
              const canExpand = event.changes.length > 1 || event.itemLabels.length > 1;
              return (
                <article
                  key={event.key}
                  className={`border-l-4 transition-colors hover:bg-secondary/30 ${reductionBorderClass(impact)}`}
                  data-testid={`schedule-event-${event.key}`}
                >
                  <div className="grid gap-3 px-5 py-4 md:grid-cols-[.7fr_1.5fr_1fr_1fr_.5fr] md:items-center md:gap-4">
                    <div>
                      <p className="font-mono text-sm font-bold">{date(event.effectiveDate)}</p>
                      {event.scheduleCode && <p className="mt-0.5 font-mono text-[10px] font-bold text-muted-foreground">SCH {event.scheduleCode}</p>}
                    </div>
                    <div>
                      {event.brands.length === 1 && changeItemCode(event.changes[0]) ? (
                        <Link
                          href={`/pbs/${encodeURIComponent(changeItemCode(event.changes[0]) as string)}`}
                          className="text-sm font-bold leading-tight text-foreground hover:text-primary hover:underline"
                        >
                          {event.drugName}
                        </Link>
                      ) : (
                        <p className="text-sm font-bold leading-tight">{event.drugName}</p>
                      )}
                      {event.brands.length > 0 && <p className="mt-1 truncate text-[11px] font-semibold text-muted-foreground">{event.brands.length} brand{event.brands.length === 1 ? '' : 's'}</p>}
                    </div>
                    <div>
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${reductionBadgeClass(impact)}`}>
                        {impact !== 'normal' && <AlertCircle className="h-3 w-3" />}
                        {eventSummary(event)}
                      </span>
                    </div>
                    <EventDetails group={event} />
                    <div className="flex justify-between gap-1 md:justify-end">
                      <button
                        type="button"
                        onClick={() => { setTimelineDrugId(event.drugId); setTimelineDrugName(event.drugName); }}
                        className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-info hover:bg-info/10"
                        data-testid={`button-timeline-event-${event.key}`}
                      >
                        <History className="h-3.5 w-3.5" />
                        <span className="hidden lg:inline">Timeline</span>
                      </button>
                      {canExpand && (
                        <button
                          type="button"
                          onClick={() => toggleEvent(event.key)}
                          className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-expanded={isExpanded}
                          data-testid={`button-toggle-event-${event.key}`}
                        >
                          <span>{isExpanded ? 'Hide' : 'Listings'}</span>
                          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </div>
                  </div>
                  {isExpanded && <EventExpandedDetails group={event} />}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {timelineDrugId && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-sidebar/35 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" data-testid="dialog-timeline">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => setTimelineDrugId(null)} aria-label="Close timeline" data-testid="button-close-timeline-backdrop" />
          <div className="relative flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl sm:rounded-3xl">
            <div className="flex shrink-0 items-start justify-between border-b border-border bg-muted/20 px-6 py-5">
              <div className="pr-8">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-info">Schedule Timeline</span>
                <h2 className="mt-1.5 text-2xl font-bold tracking-[-0.04em]">{timelineDrugName}</h2>
              </div>
              <button type="button" onClick={() => setTimelineDrugId(null)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close" data-testid="button-close-timeline-modal">
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="flex-1 overflow-auto p-6">
              {timeline.isLoading ? (
                <div className="py-12"><QueryState kind="loading" /></div>
              ) : timeline.isError || !timeline.data ? (
                <div className="py-12"><QueryState kind="error" onRetry={() => timeline.refetch()} /></div>
              ) : timeline.data.length === 0 ? (
                <p className="py-12 text-center text-sm font-semibold text-muted-foreground">No historical changes found for this medicine.</p>
              ) : (
                <div className="relative ml-2 space-y-5 border-l-2 border-border/60 pb-5 pt-1">
                  {timelineGroups.map((day) => {
                    const highestImpact = day.groups.some((group) => group.changes.some((change) => change.significance === 'high'))
                      ? 'high'
                      : day.groups.some((group) => group.changes.some((change) => change.significance === 'medium'))
                        ? 'medium'
                        : null;
                    return (
                      <section key={day.date} className="relative pl-5" data-testid={`timeline-date-${day.date}`}>
                        <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-card ${
                          highestImpact === 'high' ? 'bg-destructive' :
                          highestImpact === 'medium' ? 'bg-warning' :
                          'bg-info'
                        }`} />

                        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <p className="font-mono text-sm font-bold text-foreground">{date(day.date)}</p>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                              {day.groups.length} event{day.groups.length === 1 ? '' : 's'}
                            </span>
                            {highestImpact && (
                              <span className={`flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider ${highestImpact === 'high' ? 'text-destructive' : 'text-warning'}`}>
                                <AlertCircle className="h-3 w-3" /> {highestImpact}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          {day.groups.map((group) => {
                            const canExpand = timelineGroupCanExpand(group);
                            const isExpanded = expandedTimelineGroups.includes(group.key);
                            const significance = group.changes.some((change) => change.significance === 'high')
                              ? 'high'
                              : group.changes.some((change) => change.significance === 'medium')
                                ? 'medium'
                                : 'normal';
                            return (
                              <article
                                key={group.key}
                                className={`overflow-hidden rounded-xl border bg-card shadow-xs ${
                                  significance === 'high' ? 'border-destructive/35 border-l-4' :
                                  significance === 'medium' ? 'border-warning/40 border-l-4' :
                                  'border-border'
                                }`}
                                data-testid={`timeline-group-${group.key}`}
                              >
                                <div className="flex items-start gap-2.5 p-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <span className="text-xs font-bold text-foreground">
                                        {typeLabels[group.representative.changeType] || group.representative.changeType}
                                      </span>
                                      {significance !== 'normal' && (
                                        <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${
                                          significance === 'high' ? 'bg-destructive/10 text-destructive' : 'bg-warning/12 text-warning'
                                        }`}>
                                          {significance}
                                        </span>
                                      )}
                                    </div>
                                    <div className="mt-1.5">
                                      <TimelineGroupSummary group={group} />
                                    </div>
                                  </div>
                                  {canExpand && (
                                    <button
                                      type="button"
                                      onClick={() => toggleTimelineGroup(group.key)}
                                      className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                      aria-label={`${isExpanded ? 'Hide' : 'Show'} individual changes`}
                                      aria-expanded={isExpanded}
                                      data-testid={`button-toggle-timeline-group-${group.key}`}
                                    >
                                      <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                    </button>
                                  )}
                                </div>
                                {isExpanded && <TimelineGroupExpanded group={group} />}
                              </article>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
