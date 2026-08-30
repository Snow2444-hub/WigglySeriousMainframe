export const ANNIVERSARY_PERCENTAGE_TOLERANCE = 0.1;
export const ANNIVERSARY_PRICE_TOLERANCE = 0.01;

export const ANNIVERSARY_VERIFICATION_STATES = [
  "VERIFIED",
  "GENUINE_MISMATCH",
  "CATALOGUE_FORMULARY_DISCREPANCY",
  "PREDICTION_ONLY",
  "PUBLISHED_ONLY",
] as const;

export type AnniversaryVerificationState = (typeof ANNIVERSARY_VERIFICATION_STATES)[number];

export type AnniversaryCatalogueItem = {
  itemCode: string;
  drugId: number;
  drugName: string;
  activeIngredient: string;
  brandName: string;
  form: string | null;
  liForm: string | null;
  formulary: "F1" | "F2";
};

export type AnniversaryPublishedRow = {
  id: number;
  fileId: number;
  sourceRowNumber: number;
  sourceDrugName: string | null;
  sourceMoa: string | null;
  rawRow: Record<string, unknown>;
  effectDate: string | null;
  expectedFormulary?: "F1" | "F2";
};

export type AnniversaryPrediction = {
  id: number;
  itemCode: string;
  drugId: number;
  drugName: string;
  brandName: string;
  formulary: "F1" | "F2";
  predictedDate: string;
  reductionType: string;
  predictedPercentage: number;
  predictedNewPrice: number;
  currentPrice: number | null;
};

export type AnniversaryResolution = {
  candidateItemCodes: string[];
  candidateItems: AnniversaryCatalogueItem[];
  matchedDrugId: number | null;
};

export type AnniversaryPublishedEvidence = {
  sourceRowId: number;
  sourceRowNumber: number;
  effectDate: string | null;
  sourceDrugName: string | null;
  sourceMoa: string | null;
  sourceBrandName: string | null;
  candidateItemCodes: string[];
  candidateItemFormularies: Array<{ itemCode: string; formulary: "F1" | "F2" }>;
  expectedFormulary: "F1" | "F2" | null;
  publishedOldAemp: number | null;
  publishedNewAemp: number | null;
  publishedPercentage: number | null;
};

export type AnniversaryPredictionVerification = {
  predictionId: number | null;
  itemCode: string | null;
  drugId: number | null;
  drugName: string | null;
  brandName: string | null;
  predictedDate: string | null;
  predictedPercentage: number | null;
  predictedNewPrice: number | null;
  state: AnniversaryVerificationState;
  evidence: AnniversaryPublishedEvidence | null;
};

export type AnniversaryVerificationInput = {
  publishedRows: AnniversaryPublishedRow[];
  catalogueItems: AnniversaryCatalogueItem[];
  predictions: AnniversaryPrediction[];
};

export type AnniversaryVerificationResult = {
  predictions: AnniversaryPredictionVerification[];
  publishedRows: Array<
    AnniversaryPublishedEvidence & {
      state: AnniversaryVerificationState;
      linkedPredictionId: number | null;
    }
  >;
};

function normalized(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function formMatches(sourceForm: string | null, catalogueForm: string | null): boolean {
  const source = normalized(sourceForm);
  const catalogue = normalized(catalogueForm);
  if (!source || !catalogue) return false;
  if (source === catalogue || source.startsWith(`${catalogue} `) || catalogue.startsWith(`${source} `)) {
    return true;
  }
  const routeForms: Record<string, RegExp> = {
    oral: /^(tablet|capsule|caplet|oral|solution|suspension|granules?|powder|wafer|lozenge|chewable)\b/,
    injection: /^(injection|infusion|implant|solution concentrate)\b/,
    inhalation: /^(inhalation|pressurised|nebuliser|nebulizer)\b/,
    topical: /^(cream|ointment|gel|lotion|patch|topical)\b/,
    ophthalmic: /^(eye|ophthalmic)\b/,
    otic: /^(ear|otic)\b/,
    nasal: /^(nasal|spray)\b/,
  };
  return Object.values(routeForms).some(
    (pattern) => pattern.test(source) && pattern.test(catalogue),
  );
}

function numberFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned || !Number.isFinite(Number(cleaned))) return null;
  return Number(cleaned);
}

function sourceField(rawRow: Record<string, unknown>, pattern: RegExp, exclude?: RegExp): unknown {
  const entry = Object.entries(rawRow).find(([key]) => pattern.test(key) && !exclude?.test(key));
  return entry?.[1];
}

export function publishedAempValues(rawRow: Record<string, unknown>): {
  oldAemp: number | null;
  newAemp: number | null;
} {
  return {
    oldAemp: numberFromValue(sourceField(rawRow, /^aemp as at/i, /proposed/i)),
    newAemp: numberFromValue(sourceField(rawRow, /^proposed aemp as at/i)),
  };
}

export function impliedReductionPercentage(oldAemp: number | null, newAemp: number | null): number | null {
  if (oldAemp === null || newAemp === null || oldAemp <= 0) return null;
  return ((oldAemp - newAemp) / oldAemp) * 100;
}

export function resolveAnniversaryRow(
  row: Pick<AnniversaryPublishedRow, "sourceDrugName" | "sourceMoa" | "rawRow">,
  catalogueItems: AnniversaryCatalogueItem[],
): AnniversaryResolution {
  const sourceBrandName = String(
    sourceField(row.rawRow, /^brand name$/i) ?? sourceField(row.rawRow, /^brand name/i) ?? "",
  ).trim();
  const drugName = normalized(row.sourceDrugName);
  const brandName = normalized(sourceBrandName);
  const candidates = catalogueItems.filter((item) => {
    const drugMatches = [item.drugName, item.activeIngredient].some((value) => normalized(value) === drugName);
    const brandMatches = normalized(item.brandName) === brandName;
    const formMatchesSource = [item.form, item.liForm].some((value) => formMatches(row.sourceMoa, value));
    return Boolean(drugName && brandName && drugMatches && brandMatches && formMatchesSource);
  });
  const uniqueCandidates = [...new Map(candidates.map((item) => [item.itemCode, item])).values()].sort((a, b) =>
    a.itemCode.localeCompare(b.itemCode),
  );
  return {
    candidateItemCodes: uniqueCandidates.map((item) => item.itemCode),
    candidateItems: uniqueCandidates,
    matchedDrugId: new Set(uniqueCandidates.map((item) => item.drugId)).size === 1
      ? uniqueCandidates[0]?.drugId ?? null
      : null,
  };
}

function expectedFormulary(rawRow: Record<string, unknown>): "F1" | "F2" | null {
  if (Object.keys(rawRow).some((key) => /^f1 legal instrument drug/i.test(key))) return "F1";
  if (Object.keys(rawRow).some((key) => /^f2 legal instrument drug/i.test(key))) return "F2";
  return null;
}

function evidenceForRow(
  row: AnniversaryPublishedRow,
  catalogueItems: AnniversaryCatalogueItem[],
): AnniversaryPublishedEvidence {
  const resolution = resolveAnniversaryRow(row, catalogueItems);
  const { oldAemp, newAemp } = publishedAempValues(row.rawRow);
  return {
    sourceRowId: row.id,
    sourceRowNumber: row.sourceRowNumber,
    effectDate: row.effectDate,
    sourceDrugName: row.sourceDrugName,
    sourceMoa: row.sourceMoa,
    sourceBrandName: String(
      sourceField(row.rawRow, /^brand name$/i) ?? sourceField(row.rawRow, /^brand name/i) ?? "",
    ).trim() || null,
    candidateItemCodes: resolution.candidateItemCodes,
    candidateItemFormularies: resolution.candidateItems.map((item) => ({
      itemCode: item.itemCode,
      formulary: item.formulary,
    })),
    expectedFormulary: row.expectedFormulary ?? expectedFormulary(row.rawRow),
    publishedOldAemp: oldAemp,
    publishedNewAemp: newAemp,
    publishedPercentage: impliedReductionPercentage(oldAemp, newAemp),
  };
}

function isPercentageMatch(predicted: number, published: number | null): boolean {
  return published !== null && Math.abs(predicted - published) <= ANNIVERSARY_PERCENTAGE_TOLERANCE + Number.EPSILON;
}

function isPriceMatch(predicted: number, published: number | null): boolean {
  return published !== null && Math.abs(predicted - published) <= ANNIVERSARY_PRICE_TOLERANCE + Number.EPSILON;
}

function classifyMatchedPrediction(
  prediction: AnniversaryPrediction,
  evidence: AnniversaryPublishedEvidence,
): AnniversaryVerificationState {
  const matchedCandidate = evidence.candidateItemFormularies.find(
    (candidate) => candidate.itemCode === prediction.itemCode,
  );
  if (
    !matchedCandidate
    || (evidence.expectedFormulary !== null && matchedCandidate.formulary !== evidence.expectedFormulary)
    || matchedCandidate.formulary !== prediction.formulary
  ) {
    return "CATALOGUE_FORMULARY_DISCREPANCY";
  }
  const percentageMatches = isPercentageMatch(prediction.predictedPercentage, evidence.publishedPercentage);
  const priceMatches = evidence.publishedNewAemp === null
    || isPriceMatch(prediction.predictedNewPrice, evidence.publishedNewAemp)
    || (
      evidence.publishedOldAemp !== null
      && prediction.currentPrice !== null
      && isPriceMatch(prediction.currentPrice, evidence.publishedOldAemp)
      && percentageMatches
    );
  return percentageMatches && priceMatches ? "VERIFIED" : "GENUINE_MISMATCH";
}

export function buildAnniversaryVerification(input: AnniversaryVerificationInput): AnniversaryVerificationResult {
  const evidenceRows = input.publishedRows.map((row) => evidenceForRow(row, input.catalogueItems));
  const predictions: AnniversaryPredictionVerification[] = input.predictions.map((prediction) => {
    const evidence = evidenceRows.find((candidate) =>
      candidate.effectDate === prediction.predictedDate
      && candidate.candidateItemCodes.includes(prediction.itemCode),
    );
    return {
      predictionId: prediction.id,
      itemCode: prediction.itemCode,
      drugId: prediction.drugId,
      drugName: prediction.drugName,
      brandName: prediction.brandName,
      predictedDate: prediction.predictedDate,
      predictedPercentage: prediction.predictedPercentage,
      predictedNewPrice: prediction.predictedNewPrice,
      state: evidence ? classifyMatchedPrediction(prediction, evidence) : "PREDICTION_ONLY",
      evidence: evidence ?? null,
    };
  });

  const publishedRows = evidenceRows.map((evidence) => {
    const linkedPrediction = input.predictions.find((prediction) =>
      prediction.predictedDate === evidence.effectDate
      && evidence.candidateItemCodes.includes(prediction.itemCode),
    );
    const state = linkedPrediction
      ? classifyMatchedPrediction(linkedPrediction, evidence)
      : "PUBLISHED_ONLY";
    return {
      ...evidence,
      state,
      linkedPredictionId: linkedPrediction?.id ?? null,
    };
  });

  return { predictions, publishedRows };
}