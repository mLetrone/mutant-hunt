import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  codeSpan,
  collectMutants,
  formatCell,
  formatScore,
  isInsane,
  loadReport,
  parseArgs,
  readThresholds,
  renderSummary,
  runCli,
  summarize,
} from "../../scripts/mutation-summary.mjs";

// Paths are relative to the project root: Vitest runs with cwd = root, and so does the CLI in CI.
const SCRIPT = "scripts/mutation-summary.mjs";
/**
 * The hand-written contract fixture (FIXTURE CONTRACT in .claude/ORCHESTRATION.md).
 * It is synthetic on purpose: it is the ONLY report in the repo carrying Timeout and
 * NoCoverage mutants, which a project at 100% line coverage can never produce.
 */
const FIXTURE = "test/fixtures/mutation.json";
/**
 * A real StrykerJS 10.0.0 report: the committed act-1 run measured at 57.60%
 * (docs/measurements.md). Trimmed from reports/mutation/mutation.json by DELETING
 * three keys and nothing else - every file entry's `source`, every testFile entry's
 * `source`, and `framework.branding.imageUrl` (a 2.6 kB inline SVG data URI). No
 * status, mutator, replacement, location, id or threshold was touched, no key was
 * added, and both scripts produce byte-identical output from the trimmed copy and
 * from the untrimmed report.
 */
const REAL_FIXTURE = "test/fixtures/mutation-real.json";

type Report = Record<string, unknown>;

const fixture = (): Report => loadReport(FIXTURE) as Report;
const realFixture = (): Report => loadReport(REAL_FIXTURE) as Report;

/** Build a report with one mutant per entry of `statuses`. */
function reportOf(statuses: string[], file = "src/a.ts"): Report {
  return {
    schemaVersion: "2.0",
    thresholds: { high: 90, low: 70 },
    config: { thresholds: { high: 90, low: 70, break: 80 } },
    files: {
      [file]: {
        language: "typescript",
        source: "",
        mutants: statuses.map((status, index) => ({
          id: String(index),
          mutatorName: "EqualityOperator",
          replacement: `a > ${index}`,
          location: { start: { line: index + 1, column: 1 }, end: { line: index + 1, column: 9 } },
          status,
        })),
      },
    },
  };
}

/** Write `content` to a throwaway file outside the repo and return its path. */
function tempFile(name: string, content: string): string {
  const dir: string = mkdtempSync(join(tmpdir(), "mutation-summary-"));
  const path: string = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

/** Table rows of the survivors table (they all start with a backticked file path). */
const tableRows = (block: string): string[] =>
  block.split("\n").filter((line: string) => line.startsWith("| `"));

describe("summarize", () => {
  it("counts the hand-written fixture by status", () => {
    const stats = summarize(fixture());
    expect({
      killed: stats.killed,
      survived: stats.survived,
      timeout: stats.timeout,
      noCoverage: stats.noCoverage,
      total: stats.total,
    }).toEqual({ killed: 5, survived: 4, timeout: 1, noCoverage: 2, total: 12 });
  });

  it("scores detected / valid, as mutation-testing-metrics does", () => {
    // detected = killed 5 + timeout 1 = 6, valid = 12 -> 50%
    expect(summarize(fixture()).score).toBe(50);
    expect(formatScore(summarize(fixture()).score)).toBe("50.00%");
  });

  it("excludes Ignored, RuntimeError and CompileError from the denominator", () => {
    const stats = summarize(
      reportOf(["Killed", "Survived", "Ignored", "RuntimeError", "CompileError"]),
    );
    expect(stats.valid).toBe(2);
    expect(stats.detected).toBe(1);
    expect(stats.ignored).toBe(1);
    expect(stats.invalid).toBe(2);
    expect(stats.score).toBe(50);
  });

  it("counts Timeout as detected", () => {
    expect(summarize(reportOf(["Timeout", "Survived"])).score).toBe(50);
  });

  it("has no score when there is no valid mutant", () => {
    expect(summarize(reportOf([])).score).toBeUndefined();
    expect(summarize(reportOf(["Ignored"])).score).toBeUndefined();
    expect(formatScore(undefined)).toBe("n/a");
  });
});

describe("collectMutants", () => {
  it("sorts by file, then line, then column, then id", () => {
    const report: Report = {
      files: {
        "src/b.ts": {
          mutants: [
            {
              id: "9",
              mutatorName: "M",
              location: { start: { line: 1, column: 1 } },
              status: "Survived",
            },
          ],
        },
        "src/a.ts": {
          mutants: [
            {
              id: "2",
              mutatorName: "M",
              location: { start: { line: 5, column: 1 } },
              status: "Survived",
            },
            {
              id: "1",
              mutatorName: "M",
              location: { start: { line: 2, column: 9 } },
              status: "Survived",
            },
            {
              id: "0",
              mutatorName: "M",
              location: { start: { line: 2, column: 3 } },
              status: "Survived",
            },
          ],
        },
      },
    };
    const seen = collectMutants(report).map(
      (m: { file: string; line: number; column: number }) => `${m.file}:${m.line}:${m.column}`,
    );
    expect(seen).toEqual(["src/a.ts:2:3", "src/a.ts:2:9", "src/a.ts:5:1", "src/b.ts:1:1"]);
  });

  it("survives mutants missing the optional fields", () => {
    const report: Report = {
      files: { "src/a.ts": { mutants: [{ id: "0", mutatorName: "X", status: "Survived" }] } },
    };
    expect(collectMutants(report)[0]).toMatchObject({ line: 0, column: 0, replacement: "" });
  });
});

describe("readThresholds", () => {
  it("reads break from the config mirror, since the schema object has none", () => {
    expect((fixture().thresholds as Record<string, unknown>).break).toBeUndefined();
    expect(readThresholds(fixture(), undefined)).toEqual({ high: 90, low: 70, break: 80 });
  });

  it("returns no break when neither place has one", () => {
    expect(readThresholds({ thresholds: { high: 90, low: 70 } }, undefined).break).toBeUndefined();
  });

  it("honours the override and --break none", () => {
    expect(readThresholds(fixture(), 40).break).toBe(40);
    expect(readThresholds(fixture(), null).break).toBeUndefined();
  });

  it("ignores non-numeric threshold values", () => {
    expect(readThresholds({ thresholds: { high: "90", low: null } }, undefined)).toEqual({
      high: undefined,
      low: undefined,
      break: undefined,
    });
  });
});

describe("renderSummary", () => {
  it("renders the hand-written fixture block", () => {
    const block: string = renderSummary(fixture());
    expect(block.startsWith("<!-- mutant-hunt:mutation-summary -->\n")).toBe(true);
    expect(block.endsWith("\n")).toBe(true);
    expect(block).toContain("**50.00%** - 5 mutants slain, 4 escaped the hunt.");
    expect(block).toContain("**FAIL** - 50.00% is below the break threshold of 80%.");
    expect(block).toContain("Below `low: 70`.");
    expect(block).toContain("| 5 | 4 | 1 | 2 | 12 | 50.00% |");
    expect(block).toContain("### 4 escaped the hunt");
    expect(block).toContain(
      "| `src/domain/surcharges.ts` | 17 | EqualityOperator | `subtotalCents >= 100_000` |",
    );
    expect(block).toContain("`mutation-report` HTML artifact");
  });

  it("lists only survivors in the table", () => {
    expect(tableRows(renderSummary(fixture()))).toHaveLength(4);
  });

  it("passes when the score clears the break threshold", () => {
    const block: string = renderSummary(
      reportOf(["Killed", "Killed", "Killed", "Killed", "Survived"]),
    );
    expect(block).toContain("**PASS** - 80.00% is at or above the break threshold of 80%.");
    expect(block).toContain("Between `low: 70` and `high: 90`.");
  });

  it("reports when nothing escaped", () => {
    const block: string = renderSummary(reportOf(["Killed", "Killed"]));
    expect(block).toContain("No survivors. Every mutant was slain.");
    expect(block).toContain("At or above `high: 90`.");
    expect(tableRows(block)).toHaveLength(0);
  });

  it("renders an empty report without a score or a verdict", () => {
    const block: string = renderSummary({ files: {} });
    expect(block).toContain("**n/a** - 0 mutants slain, 0 escaped the hunt.");
    expect(block).toContain("**No verdict**");
    expect(block).toContain("No mutants in this report - nothing was hunted.");
    expect(block).not.toContain("| file | line |");
  });

  it("says so when no break threshold is configured", () => {
    const block: string = renderSummary({
      thresholds: { high: 90, low: 70 },
      files: reportOf(["Killed"]).files,
    });
    expect(block).toContain("**No break threshold configured**");
  });

  it("mentions mutants excluded from the score", () => {
    expect(renderSummary(reportOf(["Killed", "Ignored", "CompileError"]))).toContain(
      "Excluded from the score: 1 ignored, 1 runtime/compile errors.",
    );
  });

  it("caps the survivors table at 20 rows and counts the rest", () => {
    const block: string = renderSummary(reportOf(Array.from({ length: 25 }, () => "Survived")));
    expect(tableRows(block)).toHaveLength(20);
    expect(block).toContain("### 25 escaped the hunt");
    expect(block).toContain("...and 5 more.");
  });

  it("honours --max-rows and adds no truncation line when it is not needed", () => {
    const block: string = renderSummary(reportOf(Array.from({ length: 25 }, () => "Survived")), {
      maxRows: 3,
    });
    expect(tableRows(block)).toHaveLength(3);
    expect(block).toContain("...and 22 more.");
    expect(renderSummary(reportOf(["Survived"]))).not.toContain("...and");
  });

  it("links the HTML report when a url is given", () => {
    expect(renderSummary(fixture(), { reportUrl: "https://example.test/r/" })).toContain(
      "Full details: [the HTML mutation report](https://example.test/r/).",
    );
  });

  it("is byte-stable across two renders", () => {
    expect(renderSummary(fixture())).toBe(renderSummary(fixture()));
  });
});

describe("formatCell", () => {
  it("flattens, clips and escapes pipes, leaving backticks for codeSpan to fence", () => {
    expect(formatCell("a\n  b")).toBe("a b");
    expect(formatCell("a | b")).toBe("a \\| b");
    expect(formatCell("`x`")).toBe("`x`");
    const long: string = formatCell("x".repeat(200));
    expect(long).toHaveLength(60);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("codeSpan", () => {
  it("fences plain content with a single backtick", () => {
    expect(codeSpan("subtotalCents >= 100_000")).toBe("`subtotalCents >= 100_000`");
  });

  it("widens the fence and pads when the content is itself backticks", () => {
    // The empty template literal `` (Stryker's StringLiteral mutator replacing a string
    // with an empty template literal) is two backticks. A fence of one backtick each side
    // would fuse with the content into a single unmatched 2-backtick run; codeSpan widens
    // the fence to three backticks and pads so it parses back to exactly "``".
    expect(codeSpan("``")).toBe("``` `` ```");
  });

  it("widens past a longer backtick run and pads either side that touches one", () => {
    expect(codeSpan("a`b``c")).toBe("```a`b``c```");
    expect(codeSpan("`leading")).toBe("`` `leading ``");
    expect(codeSpan("trailing`")).toBe("`` trailing` ``");
  });

  it("pads an empty cell so its fence does not fuse into an unmatched run", () => {
    expect(codeSpan("")).toBe("`  `");
  });
});

describe("isInsane", () => {
  it("is false for the hand-written fixture and for an empty report", () => {
    expect(isInsane(summarize(fixture()))).toBe(false);
    expect(isInsane(summarize(reportOf([])))).toBe(false);
  });

  it("is true when valid mutants exist and none was killed", () => {
    expect(isInsane(summarize(reportOf(["Survived", "Survived"])))).toBe(true);
    expect(isInsane(summarize(reportOf(["Timeout", "Survived"])))).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses the positional path and the flags", () => {
    expect(
      parseArgs(["r.json", "--assert-sane", "--break", "55", "--max-rows", "3"]),
    ).toMatchObject({ reportPath: "r.json", assertSane: true, breakOverride: 55, maxRows: 3 });
    expect(parseArgs(["--break", "none"]).breakOverride).toBeNull();
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects bad usage with exit code 1", () => {
    const bad = [
      ["--nope"],
      ["--break"],
      ["--break", "abc"],
      ["--max-rows", "-1"],
      ["a.json", "b.json"],
    ];
    for (const args of bad) {
      expect(() => parseArgs(args)).toThrowError(expect.objectContaining({ code: 1 }));
    }
  });
});

describe("runCli", () => {
  it("prints the block and exits 0 on the hand-written fixture", () => {
    const result = runCli([FIXTURE]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderSummary(fixture()));
  });

  it("reads MUTATION_REPORT when no path is given", () => {
    const result = runCli([], { env: { MUTATION_REPORT: FIXTURE } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("50.00%");
  });

  it("exits 0 with --assert-sane on a sane report", () => {
    expect(runCli([FIXTURE, "--assert-sane"]).code).toBe(0);
  });

  it("exits 3 with --assert-sane on the silent-0% report", () => {
    const path = tempFile(
      "insane.json",
      JSON.stringify(reportOf(Array.from({ length: 11 }, () => "Survived"))),
    );
    const result = runCli([path, "--assert-sane"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("--assert-sane failed");
    expect(result.stderr).toContain("11 valid mutants and not one killed");
    expect(result.stdout).toContain("**0.00%**");
  });

  it("exits 0 with --assert-sane on a report with no mutants at all", () => {
    const path = tempFile("empty.json", JSON.stringify({ schemaVersion: "2.0", files: {} }));
    expect(runCli([path, "--assert-sane"]).code).toBe(0);
  });

  it("exits 2 on a missing file", () => {
    const result = runCli([join(tmpdir(), "definitely-absent-mutation-report.json")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read mutation report");
  });

  it("exits 2 on a malformed report", () => {
    const broken = runCli([tempFile("broken.json", "{ this is not json")]);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain("is not valid JSON");

    const notAReport = runCli([tempFile("array.json", "[]")]);
    expect(notAReport.code).toBe(2);
    expect(notAReport.stderr).toContain("expected a JSON object");

    const noFiles = runCli([tempFile("nofiles.json", '{"schemaVersion":"2.0"}')]);
    expect(noFiles.code).toBe(2);
    expect(noFiles.stderr).toContain('missing a "files" object');
  });

  it("exits 1 and prints the usage on an unknown flag", () => {
    const result = runCli([FIXTURE, "--wat"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option --wat");
    expect(result.stderr).toContain("Usage: node scripts/mutation-summary.mjs");
  });

  it("prints the usage on --help", () => {
    const result = runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Exit codes: 0 ok, 1 usage, 2 bad input, 3 --assert-sane tripped.",
    );
  });

  it("writes to --out instead of stdout", () => {
    const out: string = join(mkdtempSync(join(tmpdir(), "mutation-summary-out-")), "summary.md");
    const result = runCli([FIXTURE, "--out", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(out, "utf8")).toBe(renderSummary(fixture()));
  });

  it("exits 2 when --out cannot be written", () => {
    const result = runCli([FIXTURE, "--out", join(tmpdir(), "no-such-dir-here", "x.md")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot write to");
  });
});

describe("the CLI as a subprocess", () => {
  const run = (args: string[]): { status: number; stdout: string } => {
    try {
      const stdout: string = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      return { status: failed.status, stdout: failed.stdout };
    }
  };

  it("exits 0 and prints byte-identical output on two runs", () => {
    const first = run([FIXTURE]);
    const second = run([FIXTURE]);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toBe(renderSummary(fixture()));
  });

  it("exits non-zero when --assert-sane trips", () => {
    const path = tempFile("insane.json", JSON.stringify(reportOf(["Survived", "Survived"])));
    expect(run([path, "--assert-sane"]).status).toBe(3);
  });
});

/**
 * Everything below runs the SAME script logic against a real StrykerJS 10.0.0 report
 * instead of the hand-written one. Every expected value here was read out of
 * test/fixtures/mutation-real.json (and cross-checks docs/measurements.md), not wished for.
 */
describe("the real Stryker 10.0.0 report (test/fixtures/mutation-real.json)", () => {
  it("has the top-level shape Stryker actually emits, not the one the contract assumes", () => {
    const report = realFixture();
    // Stryker 10.0.0 emits schemaVersion "1.0" and NO `system` / `performance` keys.
    // The hand-written fixture claims "2.0" and carries both. Recorded here so the
    // difference is a tested fact rather than folklore.
    expect(Object.keys(report).sort()).toEqual([
      "config",
      "files",
      "framework",
      "projectRoot",
      "schemaVersion",
      "testFiles",
      "thresholds",
    ]);
    expect(report.schemaVersion).toBe("1.0");
    expect(fixture().schemaVersion).toBe("2.0");
    expect(report.system).toBeUndefined();
    expect(report.performance).toBeUndefined();
  });

  it("carries `break` in the TOP-LEVEL thresholds, unlike the hand-written fixture", () => {
    // The schema's Thresholds object has no `break`; Stryker 10 emits it anyway, in both
    // places. readThresholds happens to prefer the top level, so both shapes resolve to 80.
    expect(realFixture().thresholds).toEqual({ high: 90, low: 70, break: 80 });
    expect((fixture().thresholds as Record<string, unknown>).break).toBeUndefined();
    expect(readThresholds(realFixture(), undefined)).toEqual({ high: 90, low: 70, break: 80 });
  });

  it("counts the measured census: 200 mutants, 32 ignored, 43 compile errors, 125 valid", () => {
    const stats = summarize(realFixture());
    expect({
      killed: stats.killed,
      survived: stats.survived,
      timeout: stats.timeout,
      noCoverage: stats.noCoverage,
      ignored: stats.ignored,
      invalid: stats.invalid,
      detected: stats.detected,
      valid: stats.valid,
      total: stats.total,
    }).toEqual({
      killed: 72,
      survived: 53,
      timeout: 0,
      noCoverage: 0,
      ignored: 32,
      invalid: 43,
      detected: 72,
      valid: 125,
      total: 200,
    });
  });

  it("scores exactly 57.60%, the number docs/measurements.md records", () => {
    const score = summarize(realFixture()).score;
    // 72 / 125 is exact in decimal and 57.599999999999994 in IEEE-754; Stryker prints 57.60.
    expect(score).toBe((72 / 125) * 100);
    expect(formatScore(score)).toBe("57.60%");
  });

  it("renders without throwing, and reports the real score and verdict", () => {
    const block: string = renderSummary(realFixture());
    expect(block.startsWith("<!-- mutant-hunt:mutation-summary -->\n")).toBe(true);
    expect(block.endsWith("\n")).toBe(true);
    expect(block).toContain("**57.60%** - 72 mutants slain, 53 escaped the hunt.");
    expect(block).toContain("**FAIL** - 57.60% is below the break threshold of 80%.");
    expect(block).toContain("Below `low: 70`.");
    expect(block).toContain("| 72 | 53 | 0 | 0 | 125 | 57.60% |");
    expect(block).toContain("Excluded from the score: 32 ignored, 43 runtime/compile errors.");
  });

  it("lists real survivors, capped at 20 rows with the rest counted", () => {
    const block: string = renderSummary(realFixture());
    expect(block).toContain("### 53 escaped the hunt");
    expect(tableRows(block)).toHaveLength(20);
    expect(block).toContain("...and 33 more.");
    // First three rows, verbatim: the guild-rank and bulk-break boundaries act 3 must kill.
    expect(block).toContain(
      "| `src/domain/discounts.ts` | 19 | EqualityOperator | `distinctItemCount > 3` |",
    );
    expect(block).toContain(
      "| `src/domain/discounts.ts` | 30 | EqualityOperator | `totalQuantity > 50` |",
    );
    expect(block).toContain(
      "| `src/domain/discounts.ts` | 33 | EqualityOperator | `totalQuantity > 10` |",
    );
  });

  it("shows every one of the 53 survivors when --max-rows allows it", () => {
    const block: string = renderSummary(realFixture(), { maxRows: 60 });
    expect(tableRows(block)).toHaveLength(53);
    expect(block).not.toContain("...and");
    // The blessing-fee boundary, the one survivor in surcharges.ts (line 35 after T02b).
    expect(block).toContain(
      "| `src/domain/surcharges.ts` | 35 | EqualityOperator | `orderValue >= 100_000` |",
    );
  });

  it("groups the real survivors the way the measured per-file table does", () => {
    const survivors = collectMutants(realFixture()).filter(
      (m: { status: string }) => m.status === "Survived",
    );
    const perFile: Record<string, number> = {};
    for (const mutant of survivors as { file: string }[]) {
      perFile[mutant.file] = (perFile[mutant.file] ?? 0) + 1;
    }
    expect(perFile).toEqual({
      "src/domain/discounts.ts": 3,
      "src/domain/money.ts": 12,
      "src/domain/receipt.ts": 24,
      "src/domain/renown.ts": 7,
      "src/domain/surcharges.ts": 1,
      "src/domain/validation.ts": 6,
    });
  });

  it("renders the 11 empty-template-literal survivors as an unambiguous, distinct code span", () => {
    // 11 of the 53 real survivors are StringLiteral mutants whose replacement is the empty
    // TEMPLATE literal `` (two backticks). A naive `<code>` fence of one backtick would fuse
    // with that content into a single unmatched 2-backtick run (see codeSpan's tests above),
    // rendering indistinguishably from an empty single-quoted string ''. On the real report
    // that is 21% of the survivors table, so the two must stay visibly different.
    const templateSurvivors = (
      collectMutants(realFixture()) as { status: string; replacement: string }[]
    ).filter((m) => m.status === "Survived" && m.replacement === "``");
    expect(templateSurvivors).toHaveLength(11);

    const block = renderSummary(realFixture(), { maxRows: 60 });
    // money.ts:46 is one of two survivors on that line (T10b): the template-literal mutant
    // must render as the widened, padded fence, not as `''`.
    expect(block).toContain("| `src/domain/money.ts` | 46 | StringLiteral | ``` `` ``` |");
    expect(block).not.toContain("| `src/domain/money.ts` | 46 | StringLiteral | `''` |");
  });

  it("is byte-stable across two renders, like the hand-written fixture", () => {
    expect(renderSummary(realFixture())).toBe(renderSummary(realFixture()));
  });

  it("is sane: 72 killed, so --assert-sane exits 0", () => {
    expect(isInsane(summarize(realFixture()))).toBe(false);
    const result = runCli([REAL_FIXTURE, "--assert-sane"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(renderSummary(realFixture()));
  });
});
