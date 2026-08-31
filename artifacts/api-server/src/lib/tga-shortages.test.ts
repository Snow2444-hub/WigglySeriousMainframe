import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTgaCsv } from "./tga-shortages";

test("parses active TGA CSV after BOM and explanatory preamble", () => {
  const csv = [
    "\uFEFFMedicine shortages export",
    "Report generated 31 August 2026",
    "",
    '"ARTG ID","ARTG name","Active ingredients","Dosage form","Quantity of active ingredients","Sponsor","Phone","Shortage status","Supply impact start date","Supply impact end date","Deletion from market","Shortage impact rating","Availability","Reason","Management action","Last updated"',
    '"12345","Example Brand 10 mg","example sodium ~ second ingredient","tablet","10 mg","Example Sponsor","02 0000 0000","Current","1/8/2026","30/9/2026","","Critical","Limited Availability","Manufacturing delay","Use an alternative, where clinically appropriate.\r\nContact the sponsor for details.","30/8/2026"',
  ].join("\r\n");
  const parsed = parseTgaCsv(csv, "active");
  assert.equal(parsed.headerRecordNumber, 4);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.managementAction, "Use an alternative, where clinically appropriate. Contact the sponsor for details.");
  assert.equal(parsed.rows[0]?.supplyImpactStartDate, "2026-08-01");
  assert.equal(parsed.rows[0]?.lastUpdated, "2026-08-30");
  assert.equal(parsed.reportPublicationDate, "2026-08-31");
});

test("accepts the archive trailing empty phantom column", () => {
  const csv = [
    "Archive export",
    '"ARTG ID","ARTG name","Active ingredients","Dosage form","Quantity of active ingredients","Sponsor","Phone","Supply impact start date","Supply impact end date","Deletion from market","Shortage impact rating","Reason"',
    '"54321","Archive Brand","archive ingredient","capsule","20 mg","Sponsor","","1/1/2026","1/3/2026","","Medium","Resolved",',
  ].join("\n");
  const parsed = parseTgaCsv(csv, "archive");
  assert.equal(parsed.rejectedRows, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.shortageStatus, "Resolved");
  assert.equal(parsed.rows[0]?.availability, null);
  assert.equal(parsed.rows[0]?.managementAction, null);
});

test("rejects a non-empty surplus archive column", () => {
  const csv = [
    '"ARTG ID","ARTG name","Active ingredients","Dosage form","Quantity of active ingredients","Sponsor","Phone","Supply impact start date","Supply impact end date","Deletion from market","Shortage impact rating","Reason"',
    '"54321","Archive Brand","archive ingredient","capsule","20 mg","Sponsor","","1/1/2026","1/3/2026","","Medium","Resolved","unexpected"',
  ].join("\n");
  const parsed = parseTgaCsv(csv, "archive");
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.rejectedRows, 1);
  assert.match(parsed.warnings[0] ?? "", /surplus columns/);
});

test("fails when the TGA header shape changes", () => {
  assert.throws(
    () => parseTgaCsv('"ARTG ID","ARTG name"\n"1","Name"', "active"),
    /recognizable header/,
  );
});