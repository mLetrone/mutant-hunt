import { defineConfig } from "vite-plus";

// Only keys verified against `vp fmt --init` / `vp lint --init` output and
// `vp lint --print-config` are used here. See docs/decisions/0001-test-runner.md.
export default defineConfig({
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      // Vite+'s own plugin: specs must import from "vite-plus/test", not "vitest".
      "vite-plus/prefer-vite-plus-imports": "error",
      // oxlint correctness/suspicious rules that matter for a pricing domain.
      eqeqeq: "error",
      "no-console": "error",
      "no-debugger": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-param-reassign": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/explicit-function-return-type": "error",
      "typescript/consistent-type-imports": "error",
      "unicorn/no-array-reduce": "off",
    },
    options: {
      // Type-aware linting. The decision record warns it can die on Windows
      // (MAX_PATH); it does NOT reproduce here - with typescript@6.0.3 the
      // longest tsgolint path in the store is 161 chars. Verified locally:
      // a floating promise is reported, and `vp lint --deny-warnings` exits 1.
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Build outputs are already in .gitignore (which oxfmt honours), but keep
    // them here too so `vp fmt <path>` stays safe.
    // `.claude/**` and `docs/**` are prose, not source: oxfmt reflows markdown,
    // and a formatter rewriting decision records is noise, not a quality signal.
    ignorePatterns: [
      "reports/**",
      "coverage/**",
      ".stryker-tmp/**",
      "public/**",
      ".claude/**",
      "docs/**",
      // Fixtures are verbatim tool output (T10 swaps in a real Stryker report);
      // reformatting them would make the fixture stop matching what Stryker writes.
      "test/fixtures/**",
    ],
  },
  test: {
    include: ["test/**/*.spec.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts"],
      // Act 1 of the demo is 100% covered and still riddled with live mutants.
      // That is the whole point: this number must be 100 and must mean nothing.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
