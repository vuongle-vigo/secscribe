/**
 * Local fake OpenAI-compatible Chat Completions server for contract/e2e tests
 * (spec §12). Records every request; replies from a scripted queue or a
 * dynamic responder built from the request's sentences.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  auth: string | undefined;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
  };
}

export type Responder = (req: RecordedRequest, callIndex: number) => string;

/** Build a well-formed completion body around a content string. */
export function completion(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  });
}

/**
 * Suggestions built from the sentences in the user prompt: flip the case of
 * the first letter so every suggestion is an exact-substring quote with a
 * valid, prose-only replacement.
 */
export function echoResponder(transform?: (quote: string) => string): Responder {
  return (req) => {
    const userMsg = [...req.body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const sentences = userMsg
      .split("\n")
      .filter((l) => /^\[\d+\] /.test(l))
      .map((l) => l.replace(/^\[\d+\] /, ""));
    const suggestions = sentences.map((s, i) => ({
      id: `s${i + 1}`,
      category: "grammar",
      severity: "error",
      original_quote: s,
      replacement: transform ? transform(s) : flipFirst(s),
      reason_en: "Test suggestion.",
      reason_vi: "Gợi ý kiểm thử.",
      alternatives: [],
    }));
    const vocabulary = sentences.map((s) => {
      const word = (s.split(/\s+/)[0] ?? "term").replace(/[^A-Za-z'-]/g, "") || "term";
      return {
        term: word.toLowerCase(),
        definition_en: `Test definition of ${word}.`,
        definition_vi: `Nghĩa kiểm thử của ${word}.`,
        example_from_text: s,
        tags: ["test"],
      };
    });
    return completion(JSON.stringify({ suggestions, vocabulary }));
  };
}

function flipFirst(s: string): string {
  const m = /^([a-zA-Z])(.*)$/s.exec(s);
  if (!m) return `${s}!`;
  const [first, rest] = [m[1]!, m[2]!];
  return (first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase()) + rest;
}

/** Canned bilingual definition for `Define the term: X` requests. */
export function defineCompletion(term: string): string {
  return completion(
    JSON.stringify({
      phonetic: "/test/",
      definition_en: `Test definition of ${term}.`,
      definition_vi: `Nghĩa kiểm thử của ${term}.`,
      synonyms: ["syn"],
      tags: ["test"],
      example: `A test sentence using ${term}.`,
    }),
  );
}

/** Wrap a responder so definition requests get a canned entry, the rest pass through. */
export function withDefine(respond: Responder): Responder {
  return (req, i) => {
    const user = [...req.body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const m = /^Define the term:\s*(.+)$/m.exec(user);
    if (m) return defineCompletion(m[1]!.trim());
    return respond(req, i);
  };
}

export interface FakeServer {
  url: string;
  server: Server;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeServer(respond: Responder): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: RecordedRequest["body"];
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const recorded: RecordedRequest = { auth: req.headers["authorization"], body };
      requests.push(recorded);
      let content: string;
      try {
        content = respond(recorded, requests.length - 1);
      } catch (err) {
        res.writeHead(500).end(String(err));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(content);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    server,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
