import type { ProjectJournalEntry, ProjectJournalMediaDelivery } from "../../Lib/projects/types.ts";

export function buildDayJournalPresentation(
  entries: readonly ProjectJournalEntry[],
  deliveries: readonly ProjectJournalMediaDelivery[],
): { textEntries: ProjectJournalEntry[]; media: ProjectJournalMediaDelivery[] } {
  const mediaByEntry = new Map<string, ProjectJournalMediaDelivery[]>();
  for (const media of deliveries) {
    const entryMedia = mediaByEntry.get(media.journalEntryId) ?? [];
    entryMedia.push(media);
    mediaByEntry.set(media.journalEntryId, entryMedia);
  }
  return {
    textEntries: entries.filter((entry) => Boolean(entry.title?.trim() || entry.body.trim())),
    media: entries.flatMap((entry) => mediaByEntry.get(entry.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}
