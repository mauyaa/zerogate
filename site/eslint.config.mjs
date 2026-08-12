import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  globalIgnores([".next/**", "out/**", "dist/**", "build/**", "next-env.d.ts"]),
  ...nextVitals,
  ...nextTs,
]);

export default eslintConfig;
