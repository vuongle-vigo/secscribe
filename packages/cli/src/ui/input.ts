/** Interactive input helpers: raw keypress on a TTY, line-based when piped. */
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** Hidden input for secrets: the typed characters are never echoed. */
export async function askHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  const sink = new Writable({ write(_chunk, _enc, cb) {
    cb();
  } });
  const rl = readline.createInterface({ input: stdin, output: sink });
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    stdout.write("\n");
  }
}

/**
 * Single-key prompt. On a TTY reads one keypress without Enter; when piped,
 * reads a line and uses its first character (test-friendly). Returns the
 * fallback (or null) on EOF so callers can bail out.
 */
export async function askKey(prompt: string, valid: string[], fallback?: string): Promise<string | null> {
  if (!stdin.isTTY) {
    const line = await readPipedLine();
    if (line === null) return fallback ?? null;
    const ch = line.trim().toLowerCase().slice(0, 1);
    if (valid.includes(ch)) return ch;
    if (ch === "") return fallback ?? null;
    return fallback ?? ch;
  }
  return new Promise((resolve) => {
    stdout.write(`${prompt} [${valid.join("/")}] `);
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8").trim().toLowerCase().slice(0, 1);
      if (ch === "\u0003") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        process.exit(130);
      }
      if (valid.includes(ch)) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write(`${ch}\n`);
        resolve(ch);
      }
    };
    stdin.on("data", onData);
  });
}

/** Line-based read that resolves null on EOF (piped input exhausted). */
export function readPipedLine(): Promise<string | null> {
  return new Promise((resolve) => {
    if (stdin.readableEnded || stdin.destroyed) return resolve(null);
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once("line", (line: string) => done(String(line)));
    rl.once("close", () => done(null));
  });
}

export async function askConfirm(prompt: string, def: boolean): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  if (!stdin.isTTY) {
    const line = await readPipedLine();
    if (line === null || line.trim() === "") return def;
    return line.trim().toLowerCase().startsWith("y");
  }
  const key = await askKey(`${prompt} (${hint})`, ["y", "n"]);
  return key === null ? def : key === "y";
}

export async function askNumber(prompt: string, min: number, max: number, def: number): Promise<number> {
  while (true) {
    const raw = await askLine(`${prompt} (${min}-${max}) [${def}]: `);
    if (raw === "") return def;
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
  }
}
