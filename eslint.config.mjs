import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // Agent worktrees nest under .claude/; linting them would report other branches' errors.
    ignores: ["**/dist/**", "**/node_modules/**", "**/test-results/**", "**/playwright-report/**", ".claude/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow destructure-omit (`const { x, ...rest } = obj`).
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
