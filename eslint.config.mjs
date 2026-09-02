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
    "next-env.d.ts",
    // Vercel prebuilt 產物（.gitignore 第 40 行已擋，但 eslint 預設不知道）。
    // 不排除的話 `npm run lint` 會去 lint 打包後的 minified chunk，
    // 恆定回報 55 個 error（實測 2026-09-02：55 error 全部落在 .vercel/output/，
    // src/ 內 0 error）→ lint 的離開碼永遠是 1，這道關卡就失去把關能力。
    ".vercel/**",
  ]),
]);

export default eslintConfig;
