export {
  buildTypeFieldCandidateReport,
  discoverTypeFields,
  extractCandidateOccurrence,
  normalizeTypeValue,
} from './type-field-candidates.js';
import { buildAnalyzerReport } from './infer-structure.js';
import { scanRoot } from './scan.js';
import { parseAnalyzeInput, type AnalyzeInput } from './type-assignment.js';
import type { AnalyzerReportV2, AnalyzerResult } from './report.js';

export { buildAnalyzerReport, readConfirmedTypes } from './infer-structure.js';
export { parseExclusions } from './relative-directory.js';
export { scanRoot } from './scan.js';
export type { ScanRootOptions, ScanSnapshot, ScannedMarkdownFile } from './scan.js';
export { matchFolderRule, parseAnalyzeInput } from './type-assignment.js';
export type {
  AnalyzeInput,
  FolderTypeRule,
  ResolvedFolderRule,
  TagTypeRule,
  TypeAssignmentPlan,
} from './type-assignment.js';
export {
  ANALYZER_FORMAT_VERSION,
  ANALYZER_VERSION,
  invalidArguments,
  refusal,
} from './report.js';
export type {
  AmbiguousClaim,
  AmbiguousGlobalField,
  AnalyzerFolder,
  AnalyzerReportV2,
  AnalyzerFieldType,
  FieldEvidence,
  FieldTypeChoice,
  FieldTypeOption,
  FileTypeAssignment,
  FolderRuleAssignment,
  AnalyzerInventory,
  AnalyzerIssue,
  AnalyzerIssueCode,
  AnalyzerRefusalCode,
  AnalyzerResult,
  ProposedFieldClaim,
  ProposedGlobalField,
  ProposedSchema,
  TypeFieldCandidate,
  TypeFieldCandidateReportV2,
  TypeFieldValueAssignment,
  TypeNameCollision,
} from './report.js';

export async function analyze(input: AnalyzeInput): Promise<AnalyzerResult<AnalyzerReportV2>> {
  const parsed = parseAnalyzeInput(input);
  if (!parsed.ok) return parsed;
  const scanned = await scanRoot(parsed.data.root, { exclude: parsed.data.exclusions });
  if (!scanned.ok) return scanned;
  return buildAnalyzerReport(scanned.data, parsed.data.plan, parsed.data.fieldTypes);
}
