import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBadge,
  countMutants,
  DEFAULT_LABEL,
  DEFAULT_OUT,
  DEFAULT_REPORT,
  DEFAULT_THRESHOLDS,
  EXIT_INPUT,
  EXIT_OK,
  EXIT_USAGE,
  formatMessage,
  main,
  mutationScore,
  parseArgs,
  pickColor,
  resolveThresholds,
  serializeBadge,
} from "../../scripts/mutation-badge.mjs";

/**
 * The hand-written contract fixture (FIXTURE CONTRACT in .claude/ORCHESTRATION.md).
 * Synthetic on purpose: the only report in the repo carrying Timeout and NoCoverage
 * mutants, which a project at 100% line coverage can never produce.
 */
const FIXTURE = new URL("../fixtures/mutation.json", import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE);

/**
 * A real StrykerJS 10.0.0 report: the committed act-1 run measured at 57.60%
 * (docs/measurements.md). Trimmed from reports/mutation/mutation.json by DELETING three
 * keys and nothing else - every file entry's `source`, every testFile entry's `source`,
 * and `framework.branding.imageUrl` (a 2.6 kB inline SVG data URI). No status, mutator,
 * replacement, location, id or threshold was touched and no key was added; the badge is
 * byte-identical whether built from the trimmed copy or the untrimmed report.
 */
const REAL_FIXTURE = new URL("../fixtures/mutation-real.json", import.meta.url);
const REAL_FIXTURE_PATH = fileURLToPath(REAL_FIXTURE);

async function readFixture(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE, "utf8"));
}

async function readRealFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(REAL_FIXTURE, "utf8")) as Record<string, unknown>;
}

/**
 * A minimal schema-shaped report: `killed` detected mutants and `survived` undetected
 * ones, so the score is exactly killed / (killed + survived).
 */
function reportWith(
  killed: number,
  survived: number,
  thresholds: { high: number; low: number } | undefined = { high: 90, low: 70 },
): Record<string, unknown> {
  const mutants = [
    ...Array.from({ length: killed }, (_, i) => ({ id: `k${i}`, status: "Killed" })),
    ...Array.from({ length: survived }, (_, i) => ({ id: `s${i}`, status: "Survived" })),
  ];
  const report: Record<string, unknown> = {
    schemaVersion: "2.0",
    files: { "src/a.ts": { language: "typescript", source: "", mutants } },
  };
  if (thresholds !== undefined) {
    report.thresholds = thresholds;
  }
  return report;
}

describe("countMutants", () => {
  it("counts the hand-written fixture as 6 detected of 12 valid", async () => {
    expect(countMutants(await readFixture())).toEqual({
      detected: 6, // 5 Killed + 1 Timeout
      undetected: 6, // 4 Survived + 2 NoCoverage
      valid: 12,
      total: 12,
    });
  });

  it("excludes Ignored, RuntimeError, CompileError and Pending from `valid`", () => {
    const report = {
      files: {
        "src/a.ts": {
          mutants: [
            { id: "1", status: "Killed" },
            { id: "2", status: "Timeout" },
            { id: "3", status: "Survived" },
            { id: "4", status: "NoCoverage" },
            { id: "5", status: "Ignored" },
            { id: "6", status: "RuntimeError" },
            { id: "7", status: "CompileError" },
            { id: "8", status: "Pending" },
          ],
        },
      },
    };
    expect(countMutants(report)).toEqual({ detected: 2, undetected: 2, valid: 4, total: 8 });
  });

  it("sums across files and tolerates an empty report", () => {
    const report = {
      files: {
        "src/b.ts": { mutants: [{ id: "1", status: "Killed" }] },
        "src/a.ts": { mutants: [{ id: "2", status: "Survived" }] },
        "src/c.ts": { mutants: [] },
      },
    };
    expect(countMutants(report)).toEqual({ detected: 1, undetected: 1, valid: 2, total: 2 });
    expect(countMutants({ files: {} })).toEqual({ detected: 0, undetected: 0, valid: 0, total: 0 });
  });
});

describe("mutationScore", () => {
  it("is detected / valid as a percentage", () => {
    expect(mutationScore({ detected: 6, undetected: 6, valid: 12, total: 12 })).toBe(50);
    expect(mutationScore({ detected: 3, undetected: 1, valid: 4, total: 4 })).toBe(75);
  });

  it("is NaN when there is no valid mutant", () => {
    expect(mutationScore({ detected: 0, undetected: 0, valid: 0, total: 0 })).toBeNaN();
  });
});

describe("resolveThresholds", () => {
  it("reads thresholds.high / thresholds.low from the report", async () => {
    expect(resolveThresholds(await readFixture())).toEqual({ high: 90, low: 70 });
  });

  it("falls back to Stryker's defaults when the report has none", () => {
    expect(resolveThresholds({ files: {} })).toEqual({ ...DEFAULT_THRESHOLDS });
    expect(DEFAULT_THRESHOLDS).toEqual({ high: 80, low: 60 });
  });

  it("lets the CLI override either threshold independently", () => {
    expect(resolveThresholds(reportWith(1, 1), { high: 95 })).toEqual({ high: 95, low: 70 });
    expect(resolveThresholds(reportWith(1, 1), { low: 10 })).toEqual({ high: 90, low: 10 });
  });

  it("ignores the report's `break` key, which the schema's Thresholds object does not have", () => {
    // The schema's Thresholds object has only high/low, but Stryker 10.0.0 emits `break`
    // there anyway (see the real-report suite below). Either way it must not reach the badge.
    const resolved = resolveThresholds({ thresholds: { high: 90, low: 70, break: 80 }, files: {} });
    expect(resolved).toEqual({ high: 90, low: 70 });
  });

  it("rejects a high below low, and a non-numeric threshold in the report", () => {
    expect(() => resolveThresholds(reportWith(1, 1), { high: 50 })).toThrow(/below thresholds.low/);
    expect(() => resolveThresholds({ thresholds: { high: "90" }, files: {} })).toThrow(
      /not a number/,
    );
  });
});

describe("pickColor", () => {
  const thresholds = { high: 90, low: 70 };

  it("is brightgreen at or above high", () => {
    expect(pickColor(90, thresholds)).toBe("brightgreen"); // exactly high
    expect(pickColor(90.000_01, thresholds)).toBe("brightgreen");
    expect(pickColor(100, thresholds)).toBe("brightgreen");
  });

  it("is yellow from low up to just below high", () => {
    expect(pickColor(70, thresholds)).toBe("yellow"); // exactly low
    expect(pickColor(89.999_99, thresholds)).toBe("yellow");
  });

  it("is red below low", () => {
    expect(pickColor(69.999_99, thresholds)).toBe("red");
    expect(pickColor(50, thresholds)).toBe("red");
    expect(pickColor(0, thresholds)).toBe("red");
  });

  it("is lightgrey for NaN, like Stryker's own grey 'n/a' row", () => {
    expect(pickColor(Number.NaN, thresholds)).toBe("lightgrey");
  });

  it("treats high === low as a two-colour scale with no yellow band", () => {
    expect(pickColor(80, { high: 80, low: 80 })).toBe("brightgreen");
    expect(pickColor(79.999_99, { high: 80, low: 80 })).toBe("red");
  });
});

describe("formatMessage", () => {
  it("renders two decimals and a percent sign, matching Stryker's toFixed(2)", () => {
    expect(formatMessage(50)).toBe("50.00%");
    expect(formatMessage(92.4)).toBe("92.40%");
    expect(formatMessage(100 / 3)).toBe("33.33%");
    expect(formatMessage(100)).toBe("100.00%");
  });

  it("renders 'n/a' rather than an empty message, which the endpoint schema forbids", () => {
    expect(formatMessage(Number.NaN)).toBe("n/a");
    expect(formatMessage(Number.NaN)).not.toBe("");
  });
});

describe("buildBadge", () => {
  it("renders the hand-written fixture RED at 50.00%", async () => {
    expect(buildBadge(await readFixture())).toEqual({
      schemaVersion: 1,
      label: "mutants slain",
      message: "50.00%",
      color: "red",
    });
  });

  it("emits the four endpoint keys in a fixed order, and nothing else", async () => {
    expect(Object.keys(buildBadge(await readFixture()))).toEqual([
      "schemaVersion",
      "label",
      "message",
      "color",
    ]);
  });

  describe("colour boundaries end to end, thresholds high 90 / low 70", () => {
    it("exactly low (70.00%) is yellow", () => {
      expect(buildBadge(reportWith(70, 30))).toMatchObject({ message: "70.00%", color: "yellow" });
    });

    it("one mutant below low (69.00%) is red", () => {
      expect(buildBadge(reportWith(69, 31))).toMatchObject({ message: "69.00%", color: "red" });
    });

    it("exactly high (90.00%) is brightgreen", () => {
      expect(buildBadge(reportWith(90, 10))).toMatchObject({
        message: "90.00%",
        color: "brightgreen",
      });
    });

    it("one mutant below high (89.00%) is yellow", () => {
      expect(buildBadge(reportWith(89, 11))).toMatchObject({ message: "89.00%", color: "yellow" });
    });

    it("100.00% is brightgreen and 0.00% is red", () => {
      expect(buildBadge(reportWith(10, 0))).toMatchObject({
        message: "100.00%",
        color: "brightgreen",
      });
      expect(buildBadge(reportWith(0, 10))).toMatchObject({ message: "0.00%", color: "red" });
    });
  });

  it("shows n/a in grey when the report has zero mutants", () => {
    expect(buildBadge({ thresholds: { high: 90, low: 70 }, files: {} })).toEqual({
      schemaVersion: 1,
      label: DEFAULT_LABEL,
      message: "n/a",
      color: "lightgrey",
    });
  });

  it("shows n/a in grey when every mutant is invalid (RuntimeError only)", () => {
    const report = {
      thresholds: { high: 90, low: 70 },
      files: { "src/a.ts": { mutants: [{ id: "1", status: "RuntimeError" }] } },
    };
    expect(buildBadge(report)).toMatchObject({ message: "n/a", color: "lightgrey" });
  });

  it("colours from the raw score, not the rounded message", () => {
    // 899/1000 = 89.9% -> rounds to "89.90%", still below high: yellow, not green.
    expect(buildBadge(reportWith(899, 101))).toMatchObject({
      message: "89.90%",
      color: "yellow",
    });
  });

  it("honours --label and threshold overrides", async () => {
    const report = await readFixture();
    expect(buildBadge(report, { label: "mutation" })).toMatchObject({ label: "mutation" });
    // The fixture scores 50%. Drop low under it and it goes yellow, drop high too and it goes green.
    expect(buildBadge(report, { low: 40 })).toMatchObject({ color: "yellow" });
    expect(buildBadge(report, { high: 50, low: 40 })).toMatchObject({ color: "brightgreen" });
  });

  it("rejects a malformed report", () => {
    expect(() => buildBadge(null)).toThrow(/not a JSON object/);
    expect(() => buildBadge([])).toThrow(/not a JSON object/);
    expect(() => buildBadge({ schemaVersion: "2.0" })).toThrow(/no "files" object/);
    expect(() => buildBadge({ files: { "src/a.ts": {} } })).toThrow(/mutants is not an array/);
    expect(() => buildBadge({ files: { "src/a.ts": { mutants: [{ id: "1" }] } } })).toThrow(
      /without a status/,
    );
  });
});

describe("serializeBadge", () => {
  it("is byte-stable, LF-terminated and re-parses to the same object", async () => {
    const badge = buildBadge(await readFixture());
    const once = serializeBadge(badge);
    expect(serializeBadge(buildBadge(await readFixture()))).toBe(once);
    expect(once).toBe(
      '{\n  "schemaVersion": 1,\n  "label": "mutants slain",\n  "message": "50.00%",\n  "color": "red"\n}\n',
    );
    expect(once.includes("\r")).toBe(false);
    expect(JSON.parse(once)).toEqual(badge);
  });
});

describe("parseArgs", () => {
  it("defaults the report and the output path", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      report: DEFAULT_REPORT,
      out: DEFAULT_OUT,
      label: DEFAULT_LABEL,
      high: undefined,
      low: undefined,
    });
  });

  it("reads MUTATION_REPORT and MUTATION_BADGE_OUT from the environment", () => {
    const parsed = parseArgs([], { MUTATION_REPORT: "r.json", MUTATION_BADGE_OUT: "o.json" });
    expect(parsed).toMatchObject({ report: "r.json", out: "o.json" });
  });

  it("lets the positional argument win over the environment variable", () => {
    expect(parseArgs(["cli.json"], { MUTATION_REPORT: "env.json" })).toMatchObject({
      report: "cli.json",
    });
  });

  it("parses every flag", () => {
    expect(
      parseArgs(["r.json", "--out", "b.json", "--label", "mutants", "--high", "95", "--low", "80"]),
    ).toEqual({
      help: false,
      report: "r.json",
      out: "b.json",
      label: "mutants",
      high: 95,
      low: 80,
    });
  });

  it("flags --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects bad usage", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--out"])).toThrow(/--out expects a value/);
    expect(() => parseArgs(["--out", "--label"])).toThrow(/--out expects a value/);
    expect(() => parseArgs(["--high", "abc"])).toThrow(/between 0 and 100/);
    expect(() => parseArgs(["--low", "101"])).toThrow(/between 0 and 100/);
    expect(() => parseArgs(["a.json", "b.json"])).toThrow(/unexpected second report path/);
  });
});

describe("main", () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "mutation-badge-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("writes a red badge for the hand-written fixture and exits 0", async () => {
    await withTmpDir(async (dir) => {
      const out = join(dir, "nested", "badge.json");
      const code = await main([FIXTURE_PATH, "--out", out]);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
        schemaVersion: 1,
        label: "mutants slain",
        message: "50.00%",
        color: "red",
      });
    });
  });

  it("exits 1 when the report does not exist", async () => {
    await withTmpDir(async (dir) => {
      const code = await main([join(dir, "missing.json"), "--out", join(dir, "badge.json")]);
      expect(code).toBe(EXIT_INPUT);
    });
  });

  it("exits 1 on malformed JSON", async () => {
    await withTmpDir(async (dir) => {
      const bad = join(dir, "bad.json");
      await writeFile(bad, "{ not json", "utf8");
      expect(await main([bad, "--out", join(dir, "badge.json")])).toBe(EXIT_INPUT);
    });
  });

  it("exits 1 on valid JSON that is not a Stryker report", async () => {
    await withTmpDir(async (dir) => {
      const bad = join(dir, "bad.json");
      await writeFile(bad, '{"hello":"world"}', "utf8");
      expect(await main([bad, "--out", join(dir, "badge.json")])).toBe(EXIT_INPUT);
    });
  });

  it("exits 2 on bad usage without touching the filesystem", async () => {
    expect(await main(["--nope"])).toBe(EXIT_USAGE);
    expect(await main(["--out"])).toBe(EXIT_USAGE);
  });

  it("exits 0 for --help", async () => {
    expect(await main(["--help"])).toBe(EXIT_OK);
  });
});

/**
 * Everything below builds a badge from a real StrykerJS 10.0.0 report instead of the
 * hand-written one. Every expected value was read out of test/fixtures/mutation-real.json
 * (and cross-checks docs/measurements.md), not wished for.
 */
describe("the real Stryker 10.0.0 report (test/fixtures/mutation-real.json)", () => {
  it("has the top-level shape Stryker actually emits, not the one the contract assumes", async () => {
    // Stryker 10.0.0 emits schemaVersion "1.0" and NO `system` / `performance` keys;
    // the hand-written fixture claims "2.0" and carries both. The badge script reads
    // neither, which is why it survives the difference - by luck, not by design.
    const report = await readRealFixture();
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
    expect(report.system).toBeUndefined();
    expect(report.performance).toBeUndefined();
  });

  it("counts the measured census: 72 detected, 53 undetected, 125 valid of 200", async () => {
    // total 200 includes the 32 Ignored and 43 CompileError mutants excluded from `valid`.
    expect(countMutants(await readRealFixture())).toEqual({
      detected: 72,
      undetected: 53,
      valid: 125,
      total: 200,
    });
  });

  it("scores exactly 57.60%", async () => {
    const score = mutationScore(countMutants(await readRealFixture()));
    expect(score).toBe((72 / 125) * 100);
    expect(formatMessage(score)).toBe("57.60%");
  });

  it("reads high 90 / low 70 and drops the `break: 80` Stryker really emits there", async () => {
    const report = await readRealFixture();
    expect(report.thresholds).toEqual({ high: 90, low: 70, break: 80 });
    expect(resolveThresholds(report)).toEqual({ high: 90, low: 70 });
  });

  it("builds a RED badge, because 57.60% is below `low: 70`", async () => {
    expect(buildBadge(await readRealFixture())).toEqual({
      schemaVersion: 1,
      label: "mutants slain",
      message: "57.60%",
      color: "red",
    });
  });

  it("writes that badge through main() and exits 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mutation-badge-real-"));
    try {
      const out = join(dir, "badge.json");
      expect(await main([REAL_FIXTURE_PATH, "--out", out])).toBe(EXIT_OK);
      expect(await readFile(out, "utf8")).toBe(
        '{\n  "schemaVersion": 1,\n  "label": "mutants slain",\n  "message": "57.60%",\n  "color": "red"\n}\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
