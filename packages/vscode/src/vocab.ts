/** Vocabulary service: wraps the core store + pending-review confirmation. */
import {
  VocabularyStore,
  todayIso,
  type WorkspacePaths,
  type VocabularyExtract,
} from "@secscribe/core";

export interface PanelCard {
  term: string;
  phonetic: string;
  definitionEn: string;
  definitionVi: string;
  synonyms: string[];
  tags: string[];
  due: boolean;
  dueDate: string;
  intervalDays: number;
  repetitions: number;
  sources: Array<{ file: string; quote: string }>;
}

export interface PanelPendingVocab {
  key: string;
  term: string;
  phonetic: string;
  definitionEn: string;
  definitionVi: string;
  example: string;
  synonyms: string[];
  tags: string[];
}

export class VocabularyService {
  private readonly store: VocabularyStore;
  /** LLM extracts from the latest review, not yet accepted or skipped. */
  private pending: Array<{ extract: VocabularyExtract; key: string }> = [];
  private keySeq = 0;

  constructor(paths: WorkspacePaths) {
    this.store = new VocabularyStore(paths.vocabulary);
  }

  /** Queue extracts for confirmation (or add them all when auto-add is on). */
  ingest(extracts: VocabularyExtract[], file: string, autoAdd: boolean): { added: number } {
    let added = 0;
    this.pending = [];
    for (const extract of extracts) {
      if (autoAdd) {
        this.store.addFromExtract(extract, file);
        added++;
      } else {
        this.pending.push({ extract, key: `v${++this.keySeq}` });
      }
    }
    if (added > 0) this.store.save();
    return { added };
  }

  confirm(key: string, accept: boolean, file: string): boolean {
    const index = this.pending.findIndex((p) => p.key === key);
    if (index === -1) return false;
    const [entry] = this.pending.splice(index, 1);
    if (accept && entry) {
      this.store.addFromExtract(entry.extract, file);
      this.store.save();
    }
    return true;
  }

  addManual(term: string, source?: { file: string; quote: string }): { created: boolean; card: unknown } {
    const { card, created } = this.store.add({ term, source });
    this.store.save();
    return { created, card };
  }

  delete(term: string): boolean {
    const ok = this.store.delete(term);
    if (ok) this.store.save();
    return ok;
  }

  cards(): PanelCard[] {
    const today = todayIso();
    return this.store.all().map((c) => ({
      term: c.term,
      phonetic: c.phonetic,
      definitionEn: c.definition_en,
      definitionVi: c.definition_vi,
      synonyms: c.synonyms,
      tags: c.tags,
      due: c.srs.dueDate <= today,
      dueDate: c.srs.dueDate,
      intervalDays: c.srs.intervalDays,
      repetitions: c.srs.repetitions,
      sources: c.sources,
    }));
  }

  pendingList(): PanelPendingVocab[] {
    return this.pending.map(({ extract, key }) => ({
      key,
      term: extract.term,
      phonetic: extract.phonetic,
      definitionEn: extract.definitionEn,
      definitionVi: extract.definitionVi,
      example: extract.example,
      synonyms: extract.synonyms,
      tags: extract.tags,
    }));
  }

  dueCount(): number {
    return this.store.dueCards().length;
  }

  raw(): VocabularyStore {
    return this.store;
  }
}
