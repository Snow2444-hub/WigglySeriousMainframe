import type { ingestPublishedFiles } from "./pbs-published-files";
import type { pruneRawScheduleStaging } from "./ingestion-run-control";
import type { fetchSchedule } from "./pbs-ingestion";
import type { syncScheduleChangesFromStagedData } from "./schedule-changes";

export type PbsIngestionExecutorDependencies = {
  fetchSchedule?: typeof fetchSchedule;
  syncScheduleChangesFromStagedData?: typeof syncScheduleChangesFromStagedData;
  pruneRawScheduleStaging?: typeof pruneRawScheduleStaging;
  ingestPublishedFiles?: typeof ingestPublishedFiles;
};