const SALT_WORDS = new Set([
  "acetate", "calcium", "citrate", "hydrochloride", "hydrobromide", "maleate", "mesylate",
  "monohydrate", "phosphate", "potassium", "sodium", "succinate", "sulfate", "tartrate",
]);

export function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normaliseIngredient(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[()[\],]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SALT_WORDS.has(word))
    .join(" ");
}

export function normaliseIngredientForMatch(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/[()[\],.;:+/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseProductForMatch(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * True when `candidateIngredient` contains `trackedIngredient` (already
 * salt-stripped via normaliseIngredient) as a whole word, after both are
 * punctuation-normalised. Used to match free-text ingredient names against a
 * tracked ingredient regardless of salt form, e.g. "atorvastatin" against
 * "atorvastatin calcium".
 */
export function ingredientContainsWholeWord(candidateIngredient: string, trackedIngredient: string): boolean {
  const candidate = normaliseIngredientForMatch(candidateIngredient);
  const key = normaliseIngredientForMatch(trackedIngredient);
  if (!candidate || !key) return false;
  return ` ${candidate} `.includes(` ${key} `);
}
