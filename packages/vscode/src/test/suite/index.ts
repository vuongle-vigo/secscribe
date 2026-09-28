/** Extension-host test entry: mocha runner loaded by @vscode/test-electron. */
import Mocha from "mocha";
import { join } from "node:path";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 120_000 });
  // The suite bundles sit next to this file; mocha stays external so both
  // bundles share one instance. Order matters: m2 asserts the untouched
  // document before m3 applies a fix under assist mode.
  mocha.addFile(join(__dirname, "review.test.js"));
  mocha.addFile(join(__dirname, "m3.test.js"));
  const failures = await new Promise<number>((resolve) => mocha.run(resolve));
  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
}
