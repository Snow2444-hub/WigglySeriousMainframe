export function drugDisplayName(drugName: string, originatorBrandName?: string | null): string {
  const name = drugName.trim();
  const brand = originatorBrandName?.trim();
  if (!name || !brand) return name;
  if (name.localeCompare(brand, undefined, { sensitivity: 'accent' }) === 0) return name;
  if (name.toLocaleLowerCase().endsWith(`(${brand.toLocaleLowerCase()})`)) return name;
  return `${name} (${brand})`;
}