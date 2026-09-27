/** Terminal rendering: colored suggestion cards with word-level diffs. */
import pc from "picocolors";
import { wordDiff } from "@secscribe/core";
import type { Suggestion } from "@secscribe/core";

export function renderDiff(original: string, replacement: string): string {
  const ops = wordDiff(original, replacement);
  const parts: string[] = [];
  for (const op of ops) {
    const text = op.text + op.space;
    if (op.type === "same") parts.push(text);
    else if (op.type === "del") parts.push(pc.strikethrough(pc.red(text)));
    else parts.push(pc.green(text));
  }
  return parts.join("").trimEnd();
}

export function renderSuggestion(s: Suggestion, index: number, total: number): string[] {
  const sev = s.severity === "error" ? pc.bgRed(pc.white(" error ")) : pc.bgYellow(pc.black(" minor "));
  const lines: string[] = [
    `${pc.bold(`[${index + 1}/${total}]`)} ${sev} ${pc.cyan(s.category)}  ${pc.gray(`line ${s.line}`)}  ${pc.gray(s.id)}${s.match.status !== "applicable" ? pc.yellow(`  (${s.match.status})`) : ""}`,
    `  ${renderDiff(s.originalQuote, s.replacement)}`,
    `  ${pc.blue("EN:")} ${s.reasonEn}`,
    `  ${pc.blue("VI:")} ${s.reasonVi}`,
  ];
  if (s.alternatives.length) lines.push(`  ${pc.gray(`alt: ${s.alternatives.join(" | ")}`)}`);
  return lines;
}

export function renderSuggestionCompact(s: Suggestion, index: number): string[] {
  const sev = s.severity === "error" ? pc.red("error") : pc.yellow("minor");
  return [
    `${pc.bold(`${index + 1}.`)} line ${pc.bold(String(s.line))}  [${sev}/${s.category}]  ${pc.gray(s.id)}${s.match.status !== "applicable" ? pc.yellow(` (${s.match.status})`) : ""}`,
    `   ${pc.red(`- ${s.originalQuote}`)}`,
    `   ${pc.green(`+ ${s.replacement}`)}`,
    `   ${pc.blue("EN:")} ${s.reasonEn}`,
    `   ${pc.blue("VI:")} ${s.reasonVi}`,
    s.alternatives.length ? `   ${pc.gray(`alt: ${s.alternatives.join(" | ")}`)}` : "",
  ].filter(Boolean);
}
