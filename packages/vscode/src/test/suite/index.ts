/** Extension-host test entry: mocha runner loaded by @vscode/test-electron. */
import Mocha from "mocha";
import { join } from "node:path";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
  // The suite bundles sit next to this file; mocha stays external so both
  // bundles share one instance.
  mocha.addFile(join(__dirname, "review.test.js"));
  const failures = await new Promise<number>((resolve) => mocha.run(resolve));
  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
}
