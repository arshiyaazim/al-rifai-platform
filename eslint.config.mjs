import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "tests/legacy-source/**",
    "next-env.d.ts",
  ]),
  {
    // Preserve audited v10 fetch/reset effects during the runtime port.
    // Keep the performance diagnostic visible as a warning; other hook checks remain enabled.
    files: ["app/accounts-panel.tsx", "app/import-review.tsx", "app/operations.tsx", "app/program-tools.tsx", "app/register-views.tsx", "app/tracker.tsx", "app/vessel-dashboard.tsx"],
    rules: {"react-hooks/set-state-in-effect": "warn"},
  },
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
