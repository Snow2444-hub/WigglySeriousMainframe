import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(apiRoot, "src");
const protectedIdentifiers = new Set([
  "drugsTable",
  "pbsItemsTable",
  "predictedReductionsTable",
  "scheduleChangesTable",
  "ingestionRunsTable",
  "tgaShortageObservationsTable",
  "tgaShortageMatchesTable",
]);
const protectedSqlTables = [
  "drugs",
  "pbs_items",
  "predicted_reductions",
  "schedule_changes",
  "ingestion_runs",
  "tga_shortage_observations",
  "tga_shortage_matches",
];
const globalAuthorityTables = new Set([
  "drugsTable",
  "pbsItemsTable",
  "ingestionRunsTable",
]);
const derivedAuthorityTables = new Set([
  "predictedReductionsTable",
  "scheduleChangesTable",
  "tgaShortageObservationsTable",
  "tgaShortageMatchesTable",
]);

const approvedModules = new Set([
  "src/lib/ingestion-run-control.ts",
  "src/lib/pbs-current-ingestion.ts",
  "src/lib/pbs-item-mapping.ts",
  "src/lib/pbs-item-lifecycle.ts",
  "src/lib/pbs-published-files.ts",
  "src/lib/predicted-reductions.ts",
  "src/lib/schedule-changes.ts",
  "src/lib/scheduled-ingestion.ts",
  "src/lib/tga-shortages.ts",
  "src/lib/seed.ts",
  "src/routes/admin.ts",
  "src/routes/brand-preferences.ts",
  "src/routes/reference.ts",
  "src/routes/stock.ts",
  "src/scripts/repair-pbs-catalogue-status.ts",
]);

function listTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function isTestInfrastructure(path) {
  return path.endsWith(".test.ts") || path.includes("/test/");
}

function rawSqlMentionsProtectedTable(text) {
  return protectedSqlTables.some((table) =>
    new RegExp(`\\b(?:from|join|update|into|delete\\s+from)\\s+(?:public\\.)?${table}\\b`, "i").test(text),
  );
}

function isDatabaseModule(moduleSpecifier) {
  return (
    moduleSpecifier === "@workspace/db" ||
    moduleSpecifier.startsWith("@workspace/db/") ||
    moduleSpecifier.includes("/lib/db/src/")
  );
}

function authorityHelperUsed(node, helperName) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === helperName
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.length > 0 && node.elements.every((element) => authorityHelperUsed(element, helperName));
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "map"
  ) {
    const callback = node.arguments[0];
    return Boolean(callback && authorityHelperUsed(callback, helperName));
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return authorityHelperUsed(node.body, helperName);
  }
  if (ts.isParenthesizedExpression(node)) {
    return authorityHelperUsed(node.expression, helperName);
  }
  return false;
}

const violations = [];

for (const filePath of listTypeScriptFiles(sourceRoot)) {
  const projectPath = relative(apiRoot, filePath).replaceAll("\\", "/");
  if (isTestInfrastructure(projectPath)) continue;

  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node) {
    if (
      !approvedModules.has(projectPath) &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isDatabaseModule(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        violations.push(`${projectPath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} namespace import can expose protected tables`);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (protectedIdentifiers.has(importedName)) {
            violations.push(
              `${projectPath}:${sourceFile.getLineAndCharacterOfPosition(element.getStart()).line + 1} imports protected ${importedName}`,
            );
          }
        }
      }
    }

    if (
      !approvedModules.has(projectPath) &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      rawSqlMentionsProtectedTable(node.text)
    ) {
      violations.push(
        `${projectPath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} contains raw SQL access to a protected table`,
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "values" &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      node.expression.expression.expression.name.text === "insert"
    ) {
      const tableArgument = node.expression.expression.arguments[0];
      const valuesArgument = node.arguments[0];
      if (tableArgument && ts.isIdentifier(tableArgument) && valuesArgument) {
        const helperName = globalAuthorityTables.has(tableArgument.text)
          ? "withGlobalAuthority"
          : derivedAuthorityTables.has(tableArgument.text)
            ? "withDerivedAuthority"
            : undefined;
        if (helperName && !authorityHelperUsed(valuesArgument, helperName)) {
          violations.push(
            `${projectPath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} inserts ${tableArgument.text} without ${helperName}`,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (violations.length > 0) {
  console.error("Authority boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("Move protected-table access into an approved authority owner or use its exported API.");
  process.exitCode = 1;
}