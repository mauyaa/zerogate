import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Correctness first.
 *
 * The base is `recommendedTypeChecked` rather than `strictTypeChecked`: the
 * strict preset's extra rules here are stylistic (non-null assertions on indexes
 * the code has already bounds-checked, `async` methods that satisfy an interface
 * without awaiting), and silencing thirty of those would hide the handful of
 * rules below that actually catch bugs.
 */
export default tseslint.config(
  {
    // `.scratch` holds the documentation snippets extracted for type-checking.
    // They are published prose, linted by compiling them, not by style rules.
    ignores: ["dist/**", "node_modules/**", "site/**", "coverage/**", ".scratch/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // These are the ones that matter for a library that awaits provider I/O.
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-shadow": "error",
      "no-shadow": "off",
      // In-memory ledgers and test adapters are `async` to satisfy interfaces
      // whose database-backed implementations do real I/O. Dropping `async`
      // there would change the signature, not remove a mistake.
      "@typescript-eslint/require-await": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" }
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true }
      ]
    }
  },
  {
    files: ["src/cli/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // The CLI's entire job is to write to stdout.
      "no-console": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "examples/**/*.ts"],
    rules: {
      // node:test's `test()` returns a promise that is deliberately not awaited.
      "@typescript-eslint/no-floating-promises": "off"
    }
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Node scripts; TypeScript is not resolving globals for these.
      "no-undef": "off",
      "no-console": "off"
    }
  }
);
