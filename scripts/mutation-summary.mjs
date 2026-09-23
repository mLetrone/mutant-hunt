#!/usr/bin/env node
/**
 * mutation-summary.mjs - turn a StrykerJS JSON report into a markdown block for a
 * sticky pull-request comment. No Stryker reporter emits this, which is why this exists.
 *
 * USAGE
 *   node scripts/mutation-summary.mjs [report.json] [options]
 *
 * INPUT
 *   The report path comes from, in order of precedence:
 *     1. the first positional argument
 *     2. the MUTATION_REPORT environment variable
 *     3. the default, reports/mutation/mutation.json
 *   The file is Stryker's `json` reporter output. Stryker 10.0.0 actually emits
 *   `schemaVersion: "1.0"` (not the v2 the mutation-testing-report-schema package name
 *   suggests) and omits the schema's `system`/`performance` keys; this script never reads
 *   `schemaVersion` and only needs a `files` object, so it tolerates either shape.
 *
 * OPTIONS
 *   --assert-sane         Exit 3 when the report says zero mutants were killed while valid
 *                         mutants exist. See "THE SANITY CANARY" below.
 *   --break <n|none>      Override the break threshold (percent). `none` disables the verdict.
 *   --max-rows <n>        Rows in the survivors table before truncation (default 20).
 *   --report-url <url>    Link the "full report" pointer at <url> instead of naming the artifact.
 *   --out <path>          Write the block to <path> instead of stdout.
 *   -h, --help            Print this usage on stdout and exit 0.
 *
 * OUTPUT
 *   The markdown block on stdout (or to --out), always ending with a newline.
 *   Byte-stable for a given report: no timestamps, no host names, no durations, and every
 *   collection is sorted before rendering. A sticky comment must diff cleanly.
 *
 * EXIT CODES
 *   0  success (INCLUDING a score below the break threshold - the verdict is rendered, not
 *      enforced; failing the build on the score is Stryker's job, via thresholds.break)
 *   1  usage error (unknown flag, missing flag value)
 *   2  input error (report missing, unreadable, not JSON, or not a mutation report)
 *   3  --assert-sane tripped
 *   Every non-zero exit prints one explanatory line on stderr. Never a bare stack trace.
 *
 * THE SANITY CANARY (--assert-sane)
 *   T00 found a failure mode where a version-mismatched Stryker runner (vitest@5 against
 *   @stryker-mutator/vitest-runner@10) runs to completion, reports 0% with EVERY mutant
 *   survived, and exits 0. Thresholds do not catch it either, because `break` is often unset
 *   on the diff-scoped run and a 0% score with "no tests failed" looks like a clean run to CI.
 *   A mutation gate that goes green when the runner is broken is worse than no gate.
 *   --assert-sane therefore fails the build when killed === 0 while valid mutants exist: a
 *   real suite that kills literally nothing is indistinguishable from a broken runner, and both
 *   deserve a red build. A report with no mutants at all (empty diff scope) is NOT insane and
 *   exits 0.
 *
 * SCORE
 *   mutationScore = detected / valid * 100, where detected = Killed + Timeout and
 *   valid = Killed + Timeout + Survived + NoCoverage. Ignored, RuntimeError, CompileError and
 *   Pending are excluded from both. Verified against
 *   node_modules/.pnpm/mutation-testing-metrics@3.8.4/.../dist/src/calculateMetrics.js (toMetrics).
 *   With zero valid mutants the score is undefined (rendered "n/a"), matching the library's NaN.
 *
 * Zero runtime dependencies: Node 24 built-ins only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

/** Statuses that count towards the mutation score denominator. */
const VALID_STATUSES = ["Killed", "Timeout", "Survived", "NoCoverage"];
/** Statuses the schema defines but that never reach the score. */
const OTHER_STATUSES = ["RuntimeError", "CompileError", "Ignored", "Pending"];

const DEFAULT_REPORT_PATH = "reports/mutation/mutation.json";
const DEFAULT_MAX_ROWS = 20;
const MARKER = "<!-- mutant-hunt:mutation-summary -->";
const REPLACEMENT_MAX_LENGTH = 60;

const USAGE = [
  "Usage: node scripts/mutation-summary.mjs [report.json] [options]",
  "",
  "  Renders a markdown summary of a StrykerJS JSON report for a sticky PR comment.",
  "  The report path defaults to $MUTATION_REPORT, then reports/mutation/mutation.json.",
  "",
  "Options:",
  "  --assert-sane        exit 3 when zero mutants were killed while valid mutants exist",
  "  --break <n|none>     override the break threshold (percent)",
  "  --max-rows <n>       survivor rows before truncation (default 20)",
  "  --report-url <url>   link the full-report pointer at <url>",
  "  --out <path>         write to <path> instead of stdout",
  "  -h, --help           print this help",
  "",
  "Exit codes: 0 ok, 1 usage, 2 bad input, 3 --assert-sane tripped.",
].join("\n");

/** A usage or input error carrying the exit code the CLI should use. */
export class SummaryError extends Error {
  /**
   * @param {string} message
   * @param {number} code
   */
  constructor(message, code) {
    super(message);
    this.name = "SummaryError";
    this.code = code;
  }
}

/**
 * Parse argv (without the node/script prefix) into options.
 * @param {string[]} args
 * @returns {{help: boolean, reportPath: string|undefined, assertSane: boolean, breakOverride: number|null|undefined, maxRows: number|undefined, reportUrl: string|undefined, out: string|undefined}}
 */
export function parseArgs(args) {
  /** @type {ReturnType<typeof parseArgs>} */
  const options = {
    help: false,
    reportPath: undefined,
    assertSane: false,
    breakOverride: undefined,
    maxRows: undefined,
    reportUrl: undefined,
    out: undefined,
  };

  /**
   * @param {string} flag
   * @param {number} index
   * @returns {string}
   */
  const valueOf = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined) {
      throw new SummaryError(`missing value for ${flag}`, 1);
    }
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--assert-sane":
        options.assertSane = true;
        break;
      case "--break": {
        const raw = valueOf(arg, i);
        i += 1;
        if (raw === "none") {
          options.breakOverride = null;
          break;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new SummaryError(
            `--break expects a number or "none", got ${JSON.stringify(raw)}`,
            1,
          );
        }
        options.breakOverride = parsed;
        break;
      }
      case "--max-rows": {
        const raw = valueOf(arg, i);
        i += 1;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new SummaryError(
            `--max-rows expects a non-negative integer, got ${JSON.stringify(raw)}`,
            1,
          );
        }
        options.maxRows = parsed;
        break;
      }
      case "--report-url":
        options.reportUrl = valueOf(arg, i);
        i += 1;
        break;
      case "--out":
        options.out = valueOf(arg, i);
        i += 1;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new SummaryError(`unknown option ${arg}`, 1);
        }
        if (options.reportPath !== undefined) {
          throw new SummaryError(`unexpected extra argument ${arg}`, 1);
        }
        options.reportPath = arg;
    }
  }

  return options;
}

/**
 * Read and validate a mutation report from disk.
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function loadReport(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SummaryError(`cannot read mutation report at ${path}`, 2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SummaryError(`${path} is not valid JSON: ${reason}`, 2);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SummaryError(`${path} is not a mutation report: expected a JSON object`, 2);
  }
  const files = /** @type {Record<string, unknown>} */ (parsed).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new SummaryError(`${path} is not a mutation report: missing a "files" object`, 2);
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Flatten every mutant of the report, sorted deterministically.
 * @param {Record<string, unknown>} report
 * @returns {{file: string, id: string, mutatorName: string, replacement: string, line: number, column: number, status: string}[]}
 */
export function collectMutants(report) {
  const files = /** @type {Record<string, unknown>} */ (report.files ?? {});
  const mutants = [];
  for (const file of Object.keys(files).sort()) {
    const entry = files[file];
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const list = /** @type {{mutants?: unknown}} */ (entry).mutants;
    if (!Array.isArray(list)) {
      continue;
    }
    for (const mutant of list) {
      if (typeof mutant !== "object" || mutant === null) {
        continue;
      }
      const record = /** @type {Record<string, unknown>} */ (mutant);
      const start = /** @type {Record<string, unknown>} */ (
        /** @type {Record<string, unknown>} */ (record.location ?? {}).start ?? {}
      );
      mutants.push({
        file,
        // The schema says `id` is a string; a number is the only coercion worth making.
        id:
          typeof record.id === "string"
            ? record.id
            : typeof record.id === "number"
              ? String(record.id)
              : "",
        mutatorName: typeof record.mutatorName === "string" ? record.mutatorName : "unknown",
        replacement: typeof record.replacement === "string" ? record.replacement : "",
        line: typeof start.line === "number" ? start.line : 0,
        column: typeof start.column === "number" ? start.column : 0,
        status: typeof record.status === "string" ? record.status : "unknown",
      });
    }
  }
  mutants.sort(
    (a, b) =>
      a.file.localeCompare(b.file, "en") ||
      a.line - b.line ||
      a.column - b.column ||
      a.id.localeCompare(b.id, "en"),
  );
  return mutants;
}

/**
 * Count mutants by status and compute the mutation score the way
 * mutation-testing-metrics does: detected / valid, valid excluding Ignored,
 * RuntimeError, CompileError and Pending.
 * @param {Record<string, unknown>} report
 * @returns {{counts: Record<string, number>, killed: number, survived: number, timeout: number, noCoverage: number, detected: number, valid: number, invalid: number, ignored: number, total: number, score: number|undefined}}
 */
export function summarize(report) {
  const mutants = collectMutants(report);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const status of [...VALID_STATUSES, ...OTHER_STATUSES]) {
    counts[status] = 0;
  }
  for (const mutant of mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }

  const killed = counts.Killed ?? 0;
  const timeout = counts.Timeout ?? 0;
  const survived = counts.Survived ?? 0;
  const noCoverage = counts.NoCoverage ?? 0;
  const ignored = counts.Ignored ?? 0;
  const invalid = (counts.RuntimeError ?? 0) + (counts.CompileError ?? 0);
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;

  return {
    counts,
    killed,
    survived,
    timeout,
    noCoverage,
    detected,
    valid,
    invalid,
    ignored,
    total: mutants.length,
    score: valid > 0 ? (detected / valid) * 100 : undefined,
  };
}

/**
 * Thresholds, read defensively. The mutation-testing-report-schema's `thresholds` object
 * has no `break` field, but Stryker 10.0.0 emits one there anyway (in violation of its own
 * published schema) and mirrors the same value in the free-form `config.thresholds` it also
 * writes. `break` is read from the top level first, since that's what Stryker actually
 * produces; the `config` mirror is kept only as a fallback for a report that follows the
 * documented schema literally and omits it from the top level.
 * @param {Record<string, unknown>} report
 * @param {number|null|undefined} breakOverride
 * @returns {{high: number|undefined, low: number|undefined, break: number|undefined}}
 */
export function readThresholds(report, breakOverride) {
  /** @param {unknown} value */
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  /** @param {unknown} value */
  const asObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : {};

  const thresholds = asObject(report.thresholds);
  const configThresholds = asObject(asObject(report.config).thresholds);

  let breakValue = num(thresholds.break) ?? num(configThresholds.break);
  if (breakOverride === null) {
    breakValue = undefined;
  } else if (breakOverride !== undefined) {
    breakValue = breakOverride;
  }

  return {
    high: num(thresholds.high) ?? num(configThresholds.high),
    low: num(thresholds.low) ?? num(configThresholds.low),
    break: breakValue,
  };
}

/**
 * True when the report looks like the silent-0% failure mode: valid mutants, none killed.
 * @param {ReturnType<typeof summarize>} stats
 * @returns {boolean}
 */
export function isInsane(stats) {
  return stats.valid > 0 && stats.killed === 0;
}

/**
 * @param {number|undefined} score
 * @returns {string}
 */
export function formatScore(score) {
  return score === undefined ? "n/a" : `${score.toFixed(2)}%`;
}

/**
 * Make an arbitrary source snippet safe for one markdown table cell.
 * @param {string} value
 * @returns {string}
 */
export function formatCell(value) {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  const clipped =
    flat.length > REPLACEMENT_MAX_LENGTH ? `${flat.slice(0, REPLACEMENT_MAX_LENGTH - 3)}...` : flat;
  // Pipes would break the table cell. Backticks are left alone: codeSpan() below fences
  // them correctly instead of mangling the content.
  return clipped.replaceAll("|", "\\|");
}

/**
 * Wrap `content` in a backtick code span that survives CommonMark unmangled.
 *
 * A code span's fence must be a run of backticks longer than any run already inside the
 * content (per CommonMark, a fence of N backticks may contain runs of fewer than N), and
 * when the content starts or ends with a backtick - or is empty - a single padding space
 * is added on both sides so the parser doesn't fuse the fence with the content. CommonMark
 * strips exactly one such leading/trailing space back off (it only refuses to when the
 * content is nothing but spaces), so the rendered code span's content is `content` again.
 * @param {string} content
 * @returns {string}
 */
export function codeSpan(content) {
  const runs = content.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  const needsPadding = content === "" || content.startsWith("`") || content.endsWith("`");
  return needsPadding ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/**
 * The pass/fail sentence, plus where the score sits in the low/high band.
 * @param {number|undefined} score
 * @param {{high: number|undefined, low: number|undefined, break: number|undefined}} thresholds
 * @returns {string}
 */
function renderVerdict(score, thresholds) {
  if (score === undefined) {
    return "**No verdict** - the report contains no valid mutants, so there is no score to judge.";
  }
  const shown = formatScore(score);
  const lines = [];
  if (thresholds.break === undefined) {
    lines.push(`**No break threshold configured** - ${shown} is reported, not enforced.`);
  } else if (score < thresholds.break) {
    lines.push(`**FAIL** - ${shown} is below the break threshold of ${thresholds.break}%.`);
  } else {
    lines.push(`**PASS** - ${shown} is at or above the break threshold of ${thresholds.break}%.`);
  }
  if (thresholds.high !== undefined && score >= thresholds.high) {
    lines.push(`At or above \`high: ${thresholds.high}\`.`);
  } else if (thresholds.low !== undefined && score < thresholds.low) {
    lines.push(`Below \`low: ${thresholds.low}\`.`);
  } else if (thresholds.low !== undefined && thresholds.high !== undefined) {
    lines.push(`Between \`low: ${thresholds.low}\` and \`high: ${thresholds.high}\`.`);
  }
  return lines.join(" ");
}

/**
 * Render the sticky-comment markdown block.
 * @param {Record<string, unknown>} report
 * @param {{maxRows?: number, reportUrl?: string|undefined, breakOverride?: number|null|undefined}} [options]
 * @returns {string} the block, newline-terminated
 */
export function renderSummary(report, options = {}) {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const stats = summarize(report);
  const thresholds = readThresholds(report, options.breakOverride);
  const survivors = collectMutants(report).filter((mutant) => mutant.status === "Survived");

  const lines = [
    MARKER,
    "## Mutation report",
    "",
    `**${formatScore(stats.score)}** - ${stats.killed} mutants slain, ${stats.survived} escaped the hunt.`,
    "",
    renderVerdict(stats.score, thresholds),
    "",
    "| slain | escaped | timed out | no coverage | valid | score |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${stats.killed} | ${stats.survived} | ${stats.timeout} | ${stats.noCoverage} | ${stats.valid} | ${formatScore(stats.score)} |`,
    "",
    "Score is `(killed + timeout) / valid`; `valid` excludes ignored, pending, runtime-error and compile-error mutants.",
    "",
  ];

  if (stats.ignored > 0 || stats.invalid > 0) {
    lines.push(
      `Excluded from the score: ${stats.ignored} ignored, ${stats.invalid} runtime/compile errors.`,
      "",
    );
  }

  if (survivors.length === 0) {
    lines.push(
      stats.valid === 0
        ? "No mutants in this report - nothing was hunted."
        : "No survivors. Every mutant was slain.",
      "",
    );
  } else {
    lines.push(
      `### ${survivors.length} escaped the hunt`,
      "",
      "| file | line | mutator | replacement |",
      "| --- | ---: | --- | --- |",
    );
    for (const mutant of survivors.slice(0, maxRows)) {
      lines.push(
        `| ${codeSpan(formatCell(mutant.file))} | ${mutant.line} | ${formatCell(mutant.mutatorName)} | ${codeSpan(formatCell(mutant.replacement))} |`,
      );
    }
    if (survivors.length > maxRows) {
      lines.push("", `...and ${survivors.length - maxRows} more.`);
    }
    lines.push("");
  }

  lines.push(
    options.reportUrl === undefined
      ? "Full details: the `mutation-report` HTML artifact on this workflow run (`reports/mutation/index.html` locally)."
      : `Full details: [the HTML mutation report](${options.reportUrl}).`,
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Whole CLI as a pure-ish function: reads the report, returns what to write and the exit code.
 * @param {string[]} args argv without the node/script prefix
 * @param {{env?: Record<string, string|undefined>}} [deps]
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function runCli(args, deps = {}) {
  const environment = deps.env ?? env;
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return failure(error);
  }
  if (options.help) {
    return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
  }

  const path = options.reportPath ?? environment.MUTATION_REPORT ?? DEFAULT_REPORT_PATH;
  let report;
  try {
    report = loadReport(path);
  } catch (error) {
    return failure(error);
  }

  const block = renderSummary(report, {
    maxRows: options.maxRows,
    reportUrl: options.reportUrl,
    breakOverride: options.breakOverride,
  });

  if (options.out !== undefined) {
    try {
      writeFileSync(options.out, block, "utf8");
    } catch {
      return { code: 2, stdout: "", stderr: `mutation-summary: cannot write to ${options.out}\n` };
    }
  }

  const stats = summarize(report);
  if (options.assertSane && isInsane(stats)) {
    return {
      code: 3,
      stdout: options.out === undefined ? block : "",
      stderr:
        `mutation-summary: --assert-sane failed - ${stats.valid} valid mutants and not one killed. ` +
        "That is the silent-0% failure mode (check the vitest / stryker-runner version lock), not a test suite.\n",
    };
  }

  return { code: 0, stdout: options.out === undefined ? block : "", stderr: "" };
}

/**
 * @param {unknown} error
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function failure(error) {
  if (error instanceof SummaryError) {
    const hint = error.code === 1 ? `\n${USAGE}\n` : "";
    return { code: error.code, stdout: "", stderr: `mutation-summary: ${error.message}\n${hint}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 2, stdout: "", stderr: `mutation-summary: ${message}\n` };
}

/* c8 ignore start -- CLI wiring, exercised by a subprocess test */
if (argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]) {
  const result = runCli(argv.slice(2));
  if (result.stdout !== "") {
    stdout.write(result.stdout);
  }
  if (result.stderr !== "") {
    stderr.write(result.stderr);
  }
  exit(result.code);
}
/* c8 ignore stop */
