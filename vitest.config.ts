import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The VS Code extension has its own @vscode/test-electron runner; keep its
    // files (which import the ambient `vscode` module) out of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "packages/vscode/**"],
    projects: ["packages/core/vitest.config.ts", "packages/cli/vitest.config.ts"],
  },
});
