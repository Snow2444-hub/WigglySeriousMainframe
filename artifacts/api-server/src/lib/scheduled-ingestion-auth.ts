import { timingSafeEqual } from "node:crypto";

export const SCHEDULED_INGESTION_TOKEN_ENV = "PBS_SCHEDULED_INGESTION_TOKEN";

export function scheduledIngestionTokenMatches(
  expectedToken: string | undefined,
  providedToken: string | undefined,
): boolean {
  if (!expectedToken || !providedToken) return false;

  const expected = Buffer.from(expectedToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}