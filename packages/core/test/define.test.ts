import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineTerm } from "../src/vocab/define.js";
import { VocabularyStore } from "../src/vocab/cards.js";
import { LlmClient } from "../src/llm/client.js";
import { completion, echoResponder, startFakeServer, withDefine } from "./helpers/fake-server.js";

describe("defineTerm (vocabulary definition backfill)", () => {
  it("returns a bilingual dictionary entry from the endpoint", async () => {
    const fake = await startFakeServer(withDefine(echoResponder()));
    try {
      const llm = new LlmClient({ baseUrl: fake.url, apiKey: "k", model: "m" });
      const def = await defineTerm(llm, "reconnaissance");
      expect(def).not.toBeNull();
      expect(def!.definition_en).toContain("reconnaissance");
      expect(def!.definition_vi).toContain("reconnaissance");
      expect(def!.phonetic).toBe("/test/");
      // only the term was sent — no document content involved
      const sent = JSON.stringify(fake.requests[0]!.body.messages);
      expect(sent).toContain("Define the term: reconnaissance");
    } finally {
      await fake.close();
    }
  });

  it("merging into the store fills empty fields and keeps existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "secscribe-define-"));
    const store = new VocabularyStore(join(dir, "vocabulary.json"));
    store.add({ term: "reconnaissance", definition_en: "Existing EN meaning." });

    // The merge path used by callers: add() fills only empty fields.
    store.add({
      term: "Reconnaissance",
      phonetic: "/rɪˈkɒnɪsəns/",
      definition_en: "From LLM (should NOT overwrite)",
      definition_vi: "Trinh sát mục tiêu.",
      synonyms: ["recon"],
      tags: ["security"],
    });
    store.add({ term: "hardening" }); // manual card without meaning
    store.add({ term: "hardening", definition_en: "From LLM.", definition_vi: "Tăng cường bảo mật." });

    const recon = store.find("reconnaissance")!;
    expect(recon.definition_en).toBe("Existing EN meaning."); // existing wins
    expect(recon.definition_vi).toBe("Trinh sát mục tiêu."); // empty field filled
    expect(recon.phonetic).toBe("/rɪˈkɒnɪsəns/");

    const hardening = store.find("hardening")!;
    expect(hardening.definition_en).toBe("From LLM.");
    expect(hardening.definition_vi).toBe("Tăng cường bảo mật.");
  });

  it("returns null on malformed replies after one repair attempt", async () => {
    let call = 0;
    const fake = await startFakeServer(() => {
      call++;
      return completion("not json at all {{{");
    });
    try {
      const llm = new LlmClient({ baseUrl: fake.url, apiKey: "k", model: "m" });
      const def = await defineTerm(llm, "payload");
      expect(def).toBeNull();
      expect(call).toBe(2); // initial + one repair
    } finally {
      await fake.close();
    }
  });
});
