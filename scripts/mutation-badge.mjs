#!/usr/bin/env node
/**
 * mutation-badge.mjs - turn a StrykerJS JSON report into a shields.io endpoint file.
 *
 * Stryker ships no badge reporter; the only built-in badge is the hosted Stryker
 * Dashboard, which means the report leaves the perimeter. This is the self-hosted
 * alternative: a weekly CI job runs this script, publishes the JSON to GitHub Pages,
 * and the README badge points at
 *   https://img.shields.io/endpoint?url=https://<owner>.github.io/<repo>/badge.json
 *
 * Endpoint schema (https://shields.io/badges/endpoint-badge):
 *   required - schemaVersion (always the number 1), label (string), message (non-empty string)
 *   optional - color, labelColor, isError, namedLogo, logoSvg, logoColor, logoSize,
 *              style, cacheSeconds
 * We set `color` (the whole point) and nothing else: `style` belongs in the README's
 * img.shields.io query string, where it can be changed without a CI run, and
 * `cacheSeconds` is pointless for a file that changes once a week.
 *
 * Score definition, verified against mutation-testing-metrics@3.8.4
 * (dist/src/calculateMetrics.js, function `toMetrics`):
 *   detected = Killed + Timeout
 *   valid    = detected + Survived + NoCoverage
 *   score    = valid > 0 ? detected / valid * 100 : NaN
 * So Ignored, RuntimeError, CompileError *and* Pending are all excluded from `valid`.
 *
 * Zero valid mutants yields NaN, which Stryker's own clear-text reporter renders as
 * "n/a" in grey (dist/src/reporters/clear-text-score-table.js). The badge does the same:
 * message "n/a", color "lightgrey". A green badge over an empty report would be a lie,
 * and a red one would be a false alarm.
 *
 * Two decimals, like Stryker's own `score.toFixed(2)`, so the badge and the terminal
 * never disagree about the same run.
 *
 * ZERO runtime dependencies - Node 24 built-ins only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, env, exit, stderr } from "node:process";
import { fileURLToPath } from "node:url";

/** Stryker's own defaults, used when the report carries no `thresholds` object. */
export const DEFAULT_THRESHOLDS = Object.freeze({ high: 80, low: 60 });

export const DEFAULT_REPORT = "reports/mutation/mutation.json";
export const DEFAULT_OUT = "public/badge.json";
export const DEFAULT_LABEL = "mutants slain";

/** Exit codes are part of the contract. */
export const EXIT_OK = 0;
export const EXIT_INPUT = 1; // missing file, unreadable, bad JSON, wrong shape
export const EXIT_USAGE = 2; // unknown flag, missing flag value, nonsense threshold

const USAGE = `Usage: node scripts/mutation-badge.mjs [report] [options]

  report              Stryker JSON report. Defaults to $MUTATION_REPORT,
                      then ${DEFAULT_REPORT}.

Options:
  --out <path>        Output file. Defaults to $MUTATION_BADGE_OUT, then ${DEFAULT_OUT}.
  --label <text>      Badge left-hand text. Default: "${DEFAULT_LABEL}".
  --high <number>     Override thresholds.high from the report.
  --low <number>      Override thresholds.low from the report.
  -h, --help          Print this and exit 0.

Exit codes: ${EXIT_OK} ok - ${EXIT_INPUT} missing/malformed report - ${EXIT_USAGE} bad usage.
`;

class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} code
   */
  constructor(message, code) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/**
 * A status is "valid" when it counts towards the denominator of the score.
 * Anything else (Ignored, RuntimeError, CompileError, Pending) is ignored entirely.
 */
const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * @typedef {{detected: number, undetected: number, valid: number, total: number}} Counts
 */

/**
 * Count mutants by category across every file in the report.
 *
 * @param {unknown} report parsed Stryker JSON report
 * @returns {Counts}
 * @throws {CliError} when `files` is missing or not shaped like the schema
 */
export function countMutants(report) {
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new CliError("report is not a JSON object", EXIT_INPUT);
  }
  const files = /** @type {Record<string, unknown>} */ (report).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new CliError('report has no "files" object - is this a Stryker JSON report?', EXIT_INPUT);
  }

  let detected = 0;
  let undetected = 0;
  let total = 0;

  // Sorted so the traversal is deterministic even if a future report's key order shifts.
  for (const path of Object.keys(files).sort()) {
    const file = /** @type {Record<string, unknown>} */ (files)[path];
    if (typeof file !== "object" || file === null) {
      throw new CliError(`files["${path}"] is not an object`, EXIT_INPUT);
    }
    const mutants = /** @type {Record<string, unknown>} */ (file).mutants;
    if (!Array.isArray(mutants)) {
      throw new CliError(`files["${path}"].mutants is not an array`, EXIT_INPUT);
    }
    for (const mutant of mutants) {
      if (typeof mutant !== "object" || mutant === null) {
        throw new CliError(`files["${path}"] contains a mutant that is not an object`, EXIT_INPUT);
      }
      const status = /** @type {Record<string, unknown>} */ (mutant).status;
      if (typeof status !== "string") {
        throw new CliError(`files["${path}"] contains a mutant without a status`, EXIT_INPUT);
      }
      total += 1;
      if (DETECTED.has(status)) {
        detected += 1;
      } else if (UNDETECTED.has(status)) {
        undetected += 1;
      }
    }
  }

  return { detected, undetected, valid: detected + undetected, total };
}

/**
 * Mutation score in percent, or NaN when there is no valid mutant.
 * Mirrors mutation-testing-metrics' `toMetrics`.
 *
 * @param {Counts} counts
 * @returns {number}
 */
export function mutationScore(counts) {
  return counts.valid > 0 ? (counts.detected / counts.valid) * 100 : Number.NaN;
}

/**
 * Thresholds from the report, with the documented fallback and CLI overrides on top.
 * Note the schema's Thresholds object has only `high` and `low` - `break` is a Stryker
 * *config* key that never reaches the report's top-level `thresholds`.
 *
 * @param {unknown} report
 * @param {{high?: number|undefined, low?: number|undefined}} [overrides]
 * @returns {{high: number, low: number}}
 */
export function resolveThresholds(report, overrides = {}) {
  const fromReport =
    typeof report === "object" && report !== null
      ? /** @type {Record<string, unknown>} */ (report).thresholds
      : undefined;
  const bag =
    typeof fromReport === "object" && fromReport !== null
      ? /** @type {Record<string, unknown>} */ (fromReport)
      : {};

  const high = pickThreshold(overrides.high, bag.high, DEFAULT_THRESHOLDS.high, "high");
  const low = pickThreshold(overrides.low, bag.low, DEFAULT_THRESHOLDS.low, "low");

  if (high < low) {
    throw new CliError(`thresholds.high (${high}) is below thresholds.low (${low})`, EXIT_USAGE);
  }
  return { high, low };
}

/**
 * @param {number|undefined} override
 * @param {unknown} reported
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function pickThreshold(override, reported, fallback, name) {
  if (override !== undefined) {
    return override;
  }
  if (reported === undefined) {
    return fallback;
  }
  if (
    typeof reported !== "number" ||
    !Number.isFinite(reported) ||
    reported < 0 ||
    reported > 100
  ) {
    throw new CliError(
      `thresholds.${name} in the report is not a number between 0 and 100 (got ${JSON.stringify(reported)})`,
      EXIT_INPUT,
    );
  }
  return reported;
}

/**
 * Shields colour for a score. Same comparison chain as Stryker's clear-text reporter:
 * NaN is grey, `>= high` green, `>= low` yellow, otherwise red. Note this reads the
 * RAW score, not the rounded message, so a 89.999% score stays yellow while displaying
 * "90.00%" - the threshold verdict must match Stryker's, not the printed text.
 *
 * @param {number} score
 * @param {{high: number, low: number}} thresholds
 * @returns {"brightgreen"|"yellow"|"red"|"lightgrey"}
 */
export function pickColor(score, thresholds) {
  if (Number.isNaN(score)) {
    return "lightgrey";
  }
  if (score >= thresholds.high) {
    return "brightgreen";
  }
  if (score >= thresholds.low) {
    return "yellow";
  }
  return "red";
}

/**
 * The badge's right-hand text. Two decimals, "n/a" when there is nothing to score.
 * `message` must never be empty per the endpoint schema.
 *
 * @param {number} score
 * @returns {string}
 */
export function formatMessage(score) {
  return Number.isNaN(score) ? "n/a" : `${score.toFixed(2)}%`;
}

/**
 * @typedef {{schemaVersion: 1, label: string, message: string, color: string}} EndpointBadge
 */

/**
 * Build the shields.io endpoint payload from a parsed report.
 *
 * @param {unknown} report
 * @param {{label?: string, high?: number|undefined, low?: number|undefined}} [options]
 * @returns {EndpointBadge}
 */
export function buildBadge(report, options = {}) {
  const counts = countMutants(report);
  const score = mutationScore(counts);
  const thresholds = resolveThresholds(report, { high: options.high, low: options.low });
  // Key order is fixed here; JSON.stringify preserves insertion order, which is what
  // makes the output byte-stable across runs.
  return {
    schemaVersion: 1,
    label: options.label ?? DEFAULT_LABEL,
    message: formatMessage(score),
    color: pickColor(score, thresholds),
  };
}

/**
 * Serialise the badge deterministically: two-space indent, trailing newline, LF only.
 *
 * @param {EndpointBadge} badge
 * @returns {string}
 */
export function serializeBadge(badge) {
  return `${JSON.stringify(badge, null, 2)}\n`;
}

/**
 * @param {string} raw
 * @param {string} flag
 * @returns {number}
 */
function parseThresholdFlag(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new CliError(`${flag} expects a number between 0 and 100, got "${raw}"`, EXIT_USAGE);
  }
  return value;
}

/**
 * Parse argv (already sliced: no execPath, no script path).
 *
 * @param {readonly string[]} args
 * @param {Record<string, string|undefined>} [environment]
 * @returns {{help: boolean, report: string, out: string, label: string, high: number|undefined, low: number|undefined}}
 */
export function parseArgs(args, environment = {}) {
  /** @type {string|undefined} */
  let report;
  /** @type {string|undefined} */
  let out;
  /** @type {string|undefined} */
  let label;
  /** @type {number|undefined} */
  let high;
  /** @type {number|undefined} */
  let low;

  for (let i = 0; i < args.length; i += 1) {
    // `noUncheckedIndexedAccess` is on: a sparse array would hand us undefined here.
    const arg = args[i] ?? "";
    if (arg === "-h" || arg === "--help") {
      return {
        help: true,
        report: "",
        out: "",
        label: DEFAULT_LABEL,
        high: undefined,
        low: undefined,
      };
    }
    if (arg === "--out" || arg === "--label" || arg === "--high" || arg === "--low") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`${arg} expects a value`, EXIT_USAGE);
      }
      i += 1;
      if (arg === "--out") {
        out = value;
      } else if (arg === "--label") {
        label = value;
      } else if (arg === "--high") {
        high = parseThresholdFlag(value, arg);
      } else {
        low = parseThresholdFlag(value, arg);
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError(`unknown option "${arg}"`, EXIT_USAGE);
    }
    if (report !== undefined) {
      throw new CliError(`unexpected second report path "${arg}"`, EXIT_USAGE);
    }
    report = arg;
  }

  return {
    help: false,
    report: report ?? environment.MUTATION_REPORT ?? DEFAULT_REPORT,
    out: out ?? environment.MUTATION_BADGE_OUT ?? DEFAULT_OUT,
    label: label ?? DEFAULT_LABEL,
    high,
    low,
  };
}

/**
 * Read + parse a Stryker report, turning both failure modes into CliError.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readReport(path) {
  /** @type {string} */
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const reason =
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT"
        ? "no such file"
        : String(error);
    throw new CliError(`cannot read report "${path}": ${reason}`, EXIT_INPUT);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `report "${path}" is not valid JSON: ${/** @type {Error} */ (error).message}`,
      EXIT_INPUT,
    );
  }
}

/**
 * @param {readonly string[]} args
 * @param {Record<string, string|undefined>} [environment]
 * @returns {Promise<number>} process exit code
 */
export async function main(args, environment = {}) {
  try {
    const options = parseArgs(args, environment);
    if (options.help) {
      stderr.write(USAGE);
      return EXIT_OK;
    }
    const report = await readReport(options.report);
    const badge = buildBadge(report, {
      label: options.label,
      high: options.high,
      low: options.low,
    });
    const outPath = resolve(options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, serializeBadge(badge), "utf8");
    stderr.write(`mutation-badge: ${badge.message} (${badge.color}) -> ${options.out}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CliError) {
      stderr.write(`mutation-badge: ${error.message}\n`);
      return error.code;
    }
    stderr.write(`mutation-badge: unexpected failure: ${/** @type {Error} */ (error).message}\n`);
    return EXIT_INPUT;
  }
}

/* c8 ignore start -- CLI wiring, exercised by the spec through main() instead. */
if (argv[1] !== undefined && resolve(argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  exit(await main(argv.slice(2), env));
}
/* c8 ignore stop */
