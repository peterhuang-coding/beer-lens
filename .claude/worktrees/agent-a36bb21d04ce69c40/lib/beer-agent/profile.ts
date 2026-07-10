import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalEntry } from "./types";

const journalPath = path.join(process.cwd(), "data", "beer_journal.json");
const profilePath = path.join(process.cwd(), "data", "beer_profile.md");

type JournalFile = {
  version: number;
  entries: JournalEntry[];
};

export async function readJournal(): Promise<JournalFile> {
  try {
    const raw = await readFile(journalPath, "utf8");
    return JSON.parse(raw) as JournalFile;
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function appendJournalEntry(entry: JournalEntry) {
  const journal = await readJournal();
  journal.entries.unshift(entry);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await writeFile(profilePath, buildProfileMarkdown(journal.entries));
}

export async function getProfileSummary() {
  const journal = await readJournal();
  if (journal.entries.length === 0) {
    return "还没有正式记录。先按热带水果、柑橘、清爽、低甜度作为冷启动偏好。";
  }

  const avg =
    journal.entries.reduce((total, entry) => total + (entry.parsed.overallScore ?? 0), 0) /
    journal.entries.filter((entry) => entry.parsed.overallScore).length;

  const tags = countTags(
    journal.entries.flatMap((entry) => [
      ...entry.parsed.aromaTags,
      ...entry.parsed.tasteTags,
      ...entry.parsed.contextTags
    ])
  );

  return `已有 ${journal.entries.length} 条记录，平均反馈 ${avg.toFixed(
    1
  )}/5。高频偏好：${tags.slice(0, 5).join("、") || "还不明显"}。`;
}

function countTags(tags: string[]) {
  const counts = tags.reduce<Record<string, number>>((acc, tag) => {
    acc[tag] = (acc[tag] ?? 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([tag]) => tag);
}

function buildProfileMarkdown(entries: JournalEntry[]) {
  const tags = countTags(
    entries.flatMap((entry) => [
      ...entry.parsed.aromaTags,
      ...entry.parsed.tasteTags,
      ...entry.parsed.contextTags
    ])
  );

  const recent = entries
    .slice(0, 8)
    .map((entry) => {
      const score = entry.parsed.overallScore ? `${entry.parsed.overallScore}/5` : "未打分";
      const tagsLine = [
        ...entry.parsed.aromaTags,
        ...entry.parsed.tasteTags,
        ...entry.parsed.contextTags
      ].join("、");
      return `- ${entry.createdAt}: ${entry.parsed.beerName ?? "Unknown beer"}，${score}，${
        tagsLine || "无标签"
      }`;
    })
    .join("\n");

  return `# Beer Profile

## Current Taste Read

已有 ${entries.length} 条记录。

## Preference Signals

- 高频标签: ${tags.slice(0, 8).join("、") || "TBD"}
- Preferred styles: 根据记录继续学习
- Preferred hops: 根据记录继续学习
- Disliked notes: 根据低分记录继续学习
- ABV comfort range: 根据记录继续学习
- Bitterness preference: 根据记录继续学习
- Sweetness preference: 根据记录继续学习
- Sourness preference: 根据记录继续学习

## Recent Entries

${recent || "还没有正式记录。"}
`;
}

