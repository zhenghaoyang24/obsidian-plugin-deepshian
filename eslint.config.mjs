import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Shared style rules for shipped source and tests.
const styleRules = {
  // The view/composer code deliberately asserts bound elements after
  // build(); keep the existing `!` style instead of `if (!x) throw`.
  "@typescript-eslint/no-non-null-assertion": "off",
  // Style: double quotes everywhere; single quotes stay only when the
  // string contains double quotes (icon SVG markup, etc.).
  quotes: ["error", "double", { avoidEscape: true }],
  semi: ["error", "always"],
  // No console.log in shipped code; console.debug stays for the
  // opt-in debug logging (bridge.ts stderr/unparsed lines).
  "no-console": ["error", { allow: ["debug"] }],
  // Two-space indentation, cases indented one level inside switch.
  indent: ["error", 2, { SwitchCase: 1 }],
};

export default defineConfig([
  globalIgnores(["build/**", "node_modules/**", "dsh-profile/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build tooling runs in Node: process/console are defined, and printing
    // build progress is expected output, not a code smell.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    // Plugin source and unit tests share the strict style rules.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: styleRules,
  },
]);
