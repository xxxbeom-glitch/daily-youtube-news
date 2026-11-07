import { solidCard } from "./pipeline.js";
import { GRADE } from "./prompts.js";

const VERDICTS = new Set(["ok", "wrong_fact", "invented", "overclaim"]);

// 카드 문장을 AI 검수와 별개로 읽은 기사 원문에 직접 대조한다. 카드는 바꾸지 않는다.
export async function gradeCards(results, ask) {
  const grades = [];
  for (const row of results.filter((result) => solidCard(result.card))) {
    const lines = row.card.lines.filter((line) => line.passed).map(({ kind, text }, k) => ({ k, kind, text }));
    const articles = row.reads.filter((read) => read.status === "ok").map(({ source, title, body }) => ({ s: source, t: title, body }));
    try {
      const { lines: rows = [], sameEvent = true } = await ask("grade", GRADE, { event: row.event.title, lines, articles });
      grades.push({ title: row.card.title, sameEvent, lines: rows.map((result) => ({ ...result, text: lines[Number(result.k)]?.text })) });
    } catch (error) {
      console.warn(`grade skipped: ${error.message}`);
      grades.push({ title: row.card.title, failed: true, lines: [] });
    }
  }
  return grades;
}

// 공개 로그용 요약이다. 글자 없이 개수만 남긴다.
export function gradeSummary(grades) {
  const summary = { cards: grades.length, failed: 0, lines: 0, ok: 0, wrong_fact: 0, invented: 0, overclaim: 0, other: 0, mixedCards: 0 };
  for (const grade of grades) {
    if (grade.failed) summary.failed += 1;
    if (grade.sameEvent === false) summary.mixedCards += 1;
    for (const { verdict } of grade.lines) {
      summary.lines += 1;
      summary[VERDICTS.has(verdict) ? verdict : "other"] += 1;
    }
  }
  return summary;
}
