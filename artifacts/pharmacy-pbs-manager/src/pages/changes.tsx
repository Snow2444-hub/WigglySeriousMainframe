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
import { reductionBorderClass, reductionTextClass } from '@/lib/percentage-significance';
import { neutralBadgeClass } from '@/lib/status-styles';
import { drugDisplayName } from '@/lib/drug-label';
import { formatDateValue } from '@/lib/date-format';
import { Filter, X, History, ArrowRight, AlertCircle, AlertTriangle, Activity, CalendarDays, ChevronDown, Info } from 'lucide-react';
import { Link, useLocation } from 'wouter';

const money = (value: unknown) => {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
};

const date = (value: string | null | undefined) => formatDateValue(value, { day: '2-digit', month: 'short', year: 'numeric' });

const typeLabels: Record<string, string> = {
  new_item: 'New item',
  new_brand: 'New brand',
  delisted: 'Delisted',
  price_change: 'Price update',
  formulary_change: 'Formulary change',
  listing_amendment: 'Listing amended',
  premium_added: 'Premium added',
  premium_changed: 'Premium updated',
  premium_removed: 'Premium removed',
  published_fnb_new: 'New FNB register entry'
};

type ChangeCategory = 'all' | 'new' | 'amended' | 'deleted' | 'price';

const changeCategoryLabels: Record<ChangeCategory, string> = {
  all: 'All updates',
  new: 'New listings',
  amended: 'Amended listings',
  deleted: 'Deleted listings',
  price: 'Price changes',
};

const categoryChangeTypes: Record<Exclude<ChangeCategory, 'all'>, string[]> = {
  new: ['new_item', 'new_brand'],
  amended: ['listing_amendment', 'formulary_change', 'premium_added', 'premium_changed', 'premium_removed'],
  deleted: ['delisted'],
  price: ['price_change'],
};

function changeCategory(change: ScheduleChange): ChangeCategory {
  for (const [category, types] of Object.entries(categoryChangeTypes) as Array<[Exclude<ChangeCategory, 'all'>, string[]]>) {
    if (types.includes(change.changeType)) return category;
  }
  return 'all';
}

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
  originatorBrandName: string | null;
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
  if (change.changeType === 'listing_amendment') {
    return `${change.changeType}:${change.liItemId ?? change.id}`;
  }
  if (change.changeType === 'new_item' || change.changeType === 'new_brand') {
    return 'new_brands';
  }
  if (change.changeType === 'delisted') {
    return `${change.changeType}:${brandKey}:${oldValue.determined_price ?? ''}`;
  }
  if (change.changeType === 'published_fnb_new') {
    return `${change.changeType}:${newValue.manner_of_administration ?? ''}:${newValue.date_of_effect ?? ''}`;
  }
  return change.changeType;
}

function timelineGroupLabel(group: TimelineGroup): string {
  const types = new Set(group.changes.map((change) => change.changeType));
  if (types.has('new_brand') || types.has('new_item')) return 'New brands';
  if (types.has('price_change')) return 'Price update';
  if (types.has('formulary_change')) return 'Formulary update';
  return typeLabels[group.representative.changeType] || group.representative.changeType;
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
      originatorBrandName: change.originatorBrandName,
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

function eventBadgeLabel(group: ScheduleEventGroup): string {
  const types = new Set(group.changes.map((change) => change.changeType));
  const category = changeCategory(group.changes[0]);
  const categories = new Set(group.changes.map(changeCategory));
  if (categories.size === 1 && category !== 'all') return changeCategoryLabels[category];
  if (types.size > 1) return 'Multiple changes';
  if (types.has('published_fnb_new')) return 'FNB entry';
  if (types.has('premium_added')) return 'Premium added';
  if (types.has('premium_changed')) return 'Premium update';
  if (types.has('premium_removed')) return 'Premium removed';
  return 'Schedule update';
}

function eventScheduleLabel(group: ScheduleEventGroup): string | null {
  if (group.scheduleCode > 0) return `SCH ${group.scheduleCode}`;
  if (group.changes.some((change) => change.changeType === 'published_fnb_new')) return 'FNB register';
  return null;
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
  const amendmentChange = group.changes.find((change) => change.changeType === 'listing_amendment');
  const newBrandChange = group.changes.find((change) => change.changeType === 'new_brand');
  const fnbChange = group.changes.find((change) => change.changeType === 'published_fnb_new');

  if (priceChange) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ChangeDetails change={priceChange} />
        {group.brands.length > 1 && <span className="text-xs font-semibold text-muted-foreground">across {group.brands.length} brands</span>}
      </div>
    );
  }
  if (formularyChange && group.changes.length === 1) return <ChangeDetails change={formularyChange} />;
  if (amendmentChange && group.changes.length === 1) return <ChangeDetails change={amendmentChange} />;
  if (newBrandChange) {
    const impact = eventSignificance(group);
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        <span className={reductionTextClass(impact)}>Brand added</span>
        <span className="text-muted-foreground">across {group.brands.length} brand{group.brands.length === 1 ? '' : 's'}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${neutralBadgeClass}`}>
          {group.itemLabels.length || group.changes.length} listing{(group.itemLabels.length || group.changes.length) === 1 ? '' : 's'}
        </span>
      </div>
    );
  }
  if (fnbChange) {
    const payload = objectValue(fnbChange.newValue);
    const manner = textValue(payload.manner_of_administration);
    const effectDate = textValue(payload.date_of_effect);
    const matchedItemCount = Array.isArray(payload.matched_item_codes)
      ? payload.matched_item_codes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).length
      : 0;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-semibold">
        <span className="text-foreground">FNB register entry</span>
        {manner && <span className="text-muted-foreground">{manner}</span>}
        {matchedItemCount > 0 && <span className="text-muted-foreground">{matchedItemCount} matched PBS items</span>}
        {effectDate && <span className="font-mono text-[10px] text-muted-foreground">effective {date(effectDate)}</span>}
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

function sameListing(left: PriceChangeListing, right: PriceChangeListing): boolean {
  if (left.liItemId && right.liItemId) return left.liItemId === right.liItemId;
  return Boolean(
    left.pbsCode
    && right.pbsCode
    && left.pbsCode === right.pbsCode
    && left.brandName === right.brandName
    && left.strength === right.strength,
  );
}

function addUniqueListings(target: PriceChangeListing[], additions: PriceChangeListing[]): void {
  for (const listing of additions) {
    if (!target.some((candidate) => sameListing(candidate, listing))) target.push(listing);
  }
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
    addUniqueListings(current.listings, priceChangeListings(change));
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

function groupNewBrandChanges(changes: ScheduleChange[]): BrandPriceGroup[] {
  const brands = new Map<string, BrandPriceGroup>();
  for (const change of changes) {
    const fallbackBrand = changeBrandName(change) || change.drugName;
    const incoming = priceChangeListings(change).map((listing) => ({
      ...listing,
      brandName: listing.brandName || fallbackBrand,
    }));
    const key = fallbackBrand.trim().toLowerCase();
    const brand = brands.get(key) ?? {
      key,
      brandName: fallbackBrand,
      strength: incoming[0]?.strength ?? null,
      listings: [],
    };
    for (const listing of incoming) {
      if (brand.listings.length > 0 && brand.strength !== listing.strength) brand.strength = null;
    }
    addUniqueListings(brand.listings, incoming);
    brands.set(key, brand);
  }
  return [...brands.values()].sort((left, right) => left.brandName.localeCompare(right.brandName));
}

type OtherChangeGroup = {
  key: string;
  representative: ScheduleChange;
  brands: string[];
};

function groupOtherChanges(changes: ScheduleChange[]): OtherChangeGroup[] {
  const groups = new Map<string, OtherChangeGroup>();
  for (const change of changes) {
    const oldValue = objectValue(change.oldValue);
    const newValue = objectValue(change.newValue);
    const key = change.changeType === 'new_brand' || change.changeType === 'new_item'
      ? 'new_brands'
      : change.changeType === 'formulary_change'
        ? `formulary:${oldValue.formulary ?? ''}:${newValue.formulary ?? ''}`
        : change.changeType === 'listing_amendment'
          ? `listing_amendment:${change.liItemId ?? change.id}`
        : change.changeType;
    const group = groups.get(key) ?? { key, representative: change, brands: [] };
    const brand = changeBrandName(change);
    if (brand) group.brands = addUnique(group.brands, [brand]);
    group.brands = addUnique(group.brands, (change.affectedItems ?? []).map((item) => item.brandName));
    groups.set(key, group);
  }
  return [...groups.values()];
}

function EventExpandedDetails({ group }: { group: ScheduleEventGroup }) {
  const [expandedPrices, setExpandedPrices] = useState<string[]>([]);
  const [expandedBrands, setExpandedBrands] = useState<string[]>([]);
  const priceGroups = groupPriceChanges(group.changes.filter((change) => change.changeType === 'price_change'));
  const otherChanges = groupOtherChanges(group.changes.filter((change) => change.changeType !== 'price_change'));
  const newBrandChanges = groupNewBrandChanges(group.changes.filter((change) => change.changeType === 'new_brand' || change.changeType === 'new_item'));
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
        {newBrandChanges.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
              <span className="font-semibold text-foreground">New brands listed</span>
              <span className="font-mono font-bold text-muted-foreground">{newBrandChanges.length} brand{newBrandChanges.length === 1 ? '' : 's'}</span>
            </div>
            <div className="divide-y divide-border/70 border-t border-border/70">
              {newBrandChanges.map((brand) => {
                const brandKey = `${group.key}:new:${brand.key}`;
                const expanded = expandedBrands.includes(brandKey);
                return (
                  <div key={brandKey}>
                    <button type="button" onClick={() => toggle(setExpandedBrands, brandKey)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs hover:bg-secondary/25">
                      <span className="font-semibold text-foreground">{brand.brandName}</span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-bold text-muted-foreground">{brand.listings.length} listing{brand.listings.length === 1 ? '' : 's'}</span>
                        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </span>
                    </button>
                    {expanded && listings(brand.listings)}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {otherChanges.filter((change) => change.key !== 'new_brands').map((change) => (
          <div key={change.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-3 text-xs">
            <span className="font-semibold text-foreground">{change.brands.join(', ') || change.representative.drugName}</span>
            <ChangeDetails change={change.representative} />
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
    const groupKey = `${change.effectiveDate}:${key}`;
    let group = dateGroup.groups.find((candidate) => candidate.key === groupKey);
    if (!group) {
      group = {
        key: groupKey,
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
  if (group.representative.changeType === 'formulary_change') return false;
  if (group.representative.changeType === 'price_change') {
    return groupPriceChanges(group.changes).some((priceGroup) => priceGroup.listingCount > 1);
  }
  if (group.representative.changeType === 'new_item' || group.representative.changeType === 'new_brand') {
    return group.brands.length > 0;
  }
  return false;
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
        <span className={reductionTextClass(significance)}>
          {group.brands.length === 1 ? 'New brand listed' : `${group.brands.length} new brands listed`}
        </span>
      </div>
    );
  }

  if (change.changeType === 'delisted') {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs font-semibold">
        <span className={reductionTextClass(significance)}>Removed</span>
        <span className="truncate">{brandLabel}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${neutralBadgeClass}`}>
          {itemCount} listing{itemCount === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  return <ChangeDetails change={change} />;
}

function TimelineGroupExpanded({ group }: { group: TimelineGroup }) {
  const [expandedBrands, setExpandedBrands] = useState<string[]>([]);
  const priceGroups = groupPriceChanges(group.changes.filter((change) => change.changeType === 'price_change'));
  const newBrandChanges = groupNewBrandChanges(group.changes.filter((change) => change.changeType === 'new_brand' || change.changeType === 'new_item'));
  const toggleBrand = (key: string) => {
    setExpandedBrands((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
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

  if (group.representative.changeType === 'price_change') {
    return (
      <div className="border-t border-border/70 bg-muted/20 px-3 py-2.5">
        <div className="space-y-1.5">
          {priceGroups.flatMap((priceGroup) => priceGroup.brands.map((brand) => {
            const brandKey = `${group.key}:${priceGroup.key}:${brand.key}`;
            const expanded = expandedBrands.includes(brandKey);
            return (
              <div key={brandKey} className="overflow-hidden rounded-lg border border-border/70 bg-card">
                <button type="button" onClick={() => toggleBrand(brandKey)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] hover:bg-secondary/25">
                  <span className="font-semibold text-foreground">{[brand.brandName, brand.strength].filter(Boolean).join(' · ')}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-bold text-muted-foreground">{brand.listings.length} listing{brand.listings.length === 1 ? '' : 's'}</span>
                    <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {expanded && listings(brand.listings)}
              </div>
            );
          }))}
        </div>
      </div>
    );
  }

  if (group.representative.changeType === 'new_item' || group.representative.changeType === 'new_brand') {
    return (
      <div className="border-t border-border/70 bg-muted/20 px-3 py-2.5">
        <div className="space-y-1.5">
          {newBrandChanges.map((brand) => {
            const brandKey = `${group.key}:${brand.key}`;
            const expanded = expandedBrands.includes(brandKey);
            return (
              <div key={brandKey} className="overflow-hidden rounded-lg border border-border/70 bg-card">
                <button type="button" onClick={() => toggleBrand(brandKey)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] hover:bg-secondary/25">
                  <span className="font-semibold text-foreground">{brand.brandName}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-bold text-muted-foreground">{brand.listings.length} listing{brand.listings.length === 1 ? '' : 's'}</span>
                    <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {expanded && listings(brand.listings)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (group.representative.changeType === 'formulary_change') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/70 bg-muted/20 px-3 py-2.5 text-[11px]">
        <span className="font-semibold text-foreground">{group.brands.join(', ') || 'Affected listings'}</span>
        <ChangeDetails change={group.representative} />
      </div>
    );
  }

  return (
    <div className="border-t border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-foreground">{group.brands.join(', ') || 'Affected listings'}</span>
        <ChangeDetails change={group.representative} />
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
        {typeof oldPrice === 'number' && (
          <>
            <span className="text-muted-foreground line-through opacity-70">{money(oldPrice)}</span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          </>
        )}
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
  if (change.changeType === 'listing_amendment') {
    const previous = objectValue(change.oldValue);
    const next = objectValue(change.newValue);
    const fields = Array.isArray(next.changed_fields)
      ? next.changed_fields.filter((field): field is string => typeof field === 'string')
      : Object.keys(next).filter((field) => !['li_item_id', 'pbs_code', 'changed_fields'].includes(field));
    const labelByField: Record<string, string> = {
      benefit_type: 'Benefit type',
      maximum_quantity: 'Maximum quantity',
      maximum_prescribable_packs: 'Max prescribable packs',
      number_of_repeats: 'Repeats',
      pack_size: 'Pack size',
      restriction_indicators: 'Restrictions',
      caution_indicators: 'Cautions',
    };
    const formatValue = (field: string, value: unknown): string => {
      if (value === null || value === undefined || value === '') return 'not specified';
      if (field === 'benefit_type') {
        const normalized = String(value).trim().toLowerCase();
        if (normalized === 'u' || normalized === 'unrestricted') return 'unrestricted';
        if (normalized === 'r' || normalized === 'restricted') return 'restricted';
        if (['a', 's', 'authority', 'authority required'].includes(normalized)) return 'authority';
      }
      if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ') || 'none';
      if (typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => `${key.replaceAll('_', ' ')}: ${String(entry)}`)
          .join(', ') || 'none';
      }
      return String(value);
    };
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        <span className="text-info">Amended</span>
        {fields.map((field) => (
          <span key={field} className="rounded bg-info/10 px-1.5 py-0.5 text-info">
            {labelByField[field] || field}: {formatValue(field, previous[field])} <ArrowRight className="inline h-3 w-3" /> {formatValue(field, next[field])}
          </span>
        ))}
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
  const [location] = useLocation();
  const initialParams = useMemo(() => new URLSearchParams(location.split('?')[1] ?? ''), [location]);
  const initialChangeType = initialParams.get('changeType') as ListScheduleChangesChangeType | null;
  const initialCategory: ChangeCategory = initialChangeType === 'new_brand' || initialChangeType === 'new_item'
    ? 'new'
    : initialChangeType === 'delisted'
      ? 'deleted'
      : initialChangeType === 'price_change'
        ? 'price'
        : initialChangeType === 'formulary_change' || initialChangeType === 'listing_amendment'
          ? 'amended'
          : 'all';
  const [drugId, setDrugId] = useState<number | ''>(() => initialParams.get('drugId') ? Number(initialParams.get('drugId')) : '');
  const [category, setCategory] = useState<ChangeCategory>(initialCategory);
  const [changeType, setChangeType] = useState<ListScheduleChangesChangeType | ''>(() => initialChangeType ?? '');
  const [scheduleCode, setScheduleCode] = useState<number | ''>(() => initialParams.get('scheduleCode') ? Number(initialParams.get('scheduleCode')) : '');
  const [from, setFrom] = useState(() => initialParams.get('from') ?? '');
  const [to, setTo] = useState(() => initialParams.get('to') ?? '');
  const [year, setYear] = useState(() => initialParams.get('year') ?? '');
  const [direction] = useState<'decrease' | ''>(() => initialParams.get('direction') === 'decrease' ? 'decrease' : '');
  const [significance, setSignificance] = useState<ListScheduleChangesSignificance | ''>('');
  
  const [timelineDrugId, setTimelineDrugId] = useState<number | null>(null);
  const [timelineDrugName, setTimelineDrugName] = useState<string>('');
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState<string[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<string[]>([]);

  const params = useMemo(() => ({
    drugId: drugId || undefined,
    scheduleCode: scheduleCode || undefined,
    from: from || undefined,
    to: to || undefined,
    changeType: changeType || undefined,
    direction: direction || undefined,
    significance: significance || undefined,
    limit: 500
  }), [drugId, scheduleCode, from, to, changeType, direction, significance]);

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
  const yearOptions = useMemo(
    () => [...new Set(changes.map((change) => change.effectiveDate.slice(0, 4)))]
      .filter((value) => /^\d{4}$/.test(value))
      .sort((left, right) => right.localeCompare(left)),
    [changes],
  );
  const filteredChanges = useMemo(
    () => changes.filter((change) => (
      (category === 'all' || changeCategory(change) === category)
      && (!year || change.effectiveDate.slice(0, 4) === year)
    )),
    [changes, category, year],
  );
  const events = useMemo(() => groupScheduleChanges(filteredChanges), [filteredChanges]);
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

        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span className="hidden xl:inline">From</span>
          <input value={from} onChange={(e) => setFrom(e.target.value)} type="date" className="min-w-0 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-changes-from" />
        </label>

        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-xs font-semibold text-muted-foreground">
          <CalendarDays className="h-4 w-4 text-info" /><span className="hidden xl:inline">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} type="date" className="min-w-0 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-changes-to" />
        </label>

        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <CalendarDays className="h-4 w-4 text-info" />
          <select value={year} onChange={(e) => setYear(e.target.value)} className="w-full bg-transparent text-sm font-semibold outline-none" data-testid="select-changes-year">
            <option value="">All years</option>
            {yearOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>

        <label className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 text-xs font-semibold text-muted-foreground">
          <span className="font-mono text-[10px] font-bold uppercase">Schedule</span>
          <input value={scheduleCode} onChange={(e) => setScheduleCode(e.target.value ? Number(e.target.value) : '')} type="number" min="0" placeholder="Any" className="w-20 bg-transparent text-sm font-medium text-foreground outline-none" data-testid="input-changes-schedule" />
        </label>
        
        <label className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <Filter className="h-4 w-4 text-primary" />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ChangeCategory)}
            className="w-full bg-transparent text-sm font-semibold outline-none"
            data-testid="select-changes-category"
          >
            {(Object.keys(changeCategoryLabels) as ChangeCategory[]).map((value) => (
              <option key={value} value={value}>{changeCategoryLabels[value]}</option>
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
            <option value="listing_amendment">Listing amendments</option>
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
      ) : filteredChanges.length === 0 ? (
        <QueryState kind="empty" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
          <div className="hidden grid-cols-[.7fr_1.5fr_1fr_1fr_.5fr] gap-4 border-b border-border bg-muted/45 px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid">
            <span>Date</span>
            <span>Medicine</span>
            <span>Event</span>
            <span>Details</span>
            <span className="flex items-center justify-end gap-1" title="Impact reflects the significance of the schedule change, not prediction confidence">Impact <Info className="h-3 w-3" /></span>
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
                      {eventScheduleLabel(event) && <p className="mt-0.5 font-mono text-[10px] font-bold text-muted-foreground">{eventScheduleLabel(event)}</p>}
                    </div>
                    <div>
                      {event.brands.length === 1 && changeItemCode(event.changes[0]) ? (
                        <Link
                          href={`/pbs/${encodeURIComponent(changeItemCode(event.changes[0]) as string)}`}
                          className="text-sm font-bold leading-tight text-foreground hover:text-primary hover:underline"
                        >
                           {drugDisplayName(event.drugName, event.originatorBrandName)}
                        </Link>
                      ) : (
                        <p className="text-sm font-bold leading-tight">{drugDisplayName(event.drugName, event.originatorBrandName)}</p>
                      )}
                      {event.brands.length > 0 && <p className="mt-1 truncate text-[11px] font-semibold text-muted-foreground">{event.brands.length} brand{event.brands.length === 1 ? '' : 's'}</p>}
                    </div>
                    <div>
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${neutralBadgeClass}`}>
                        {impact !== 'normal' && <AlertCircle className="h-3 w-3" />}
                        {eventBadgeLabel(event)}
                      </span>
                    </div>
                    <EventDetails group={event} />
                    <div className="flex justify-between gap-1 md:justify-end">
                      <button
                        type="button"
                         onClick={() => { setTimelineDrugId(event.drugId); setTimelineDrugName(drugDisplayName(event.drugName, event.originatorBrandName)); }}
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
                        {timelineGroupLabel(group)}
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
