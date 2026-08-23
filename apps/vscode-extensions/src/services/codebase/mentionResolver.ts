import { MENTION_LIMITS } from '../../../constants';
import { NamedRoot, listDirectory, readFile } from './codebaseTools';

/** A resolved @-mention, ready to be inlined into the prompt. */
export interface ResolvedMention {
  /** The path exactly as the user mentioned it. */
  name: string;
  /** File text, directory listing, or the reason it couldn't be read. */
  content: string;
}

/**
 * Turns the paths the user @-mentioned into prompt-ready text: files become
 * their contents (capped by `readFile`), folders become a listing of what's
 * in them. A path that no longer resolves yields an explicit note rather than
 * being dropped — silence would let the model answer as if the user had never
 * pointed at it.
 */
export async function resolveMentions(
  mentions: string[],
  roots: NamedRoot[]
): Promise<ResolvedMention[]> {
  if (!mentions.length || !roots.length) return [];

  const unique = [...new Set(mentions)].slice(0, MENTION_LIMITS.MAX_PER_MESSAGE);

  return Promise.all(
    unique.map(async (mentionPath): Promise<ResolvedMention> => {
      // Try it as a file first: mentioning a file is the common case, and a
      // directory read fails fast and cheaply.
      try {
        const result = await readFile({ path: mentionPath }, roots);
        return {
          name: mentionPath,
          content: result.truncated
            ? `${result.content}\n\n[... truncated — file has ${result.totalLines} lines ...]`
            : result.content,
        };
      } catch (fileError) {
        try {
          const listing = await listDirectory({ path: mentionPath }, roots);
          const entries = listing.entries
            .map((e) => (e.type === 'directory' ? `${e.name}/` : e.name))
            .join('\n');
          return {
            name: `${mentionPath}/`,
            content: entries || '(empty directory)',
          };
        } catch {
          return {
            name: mentionPath,
            content: `[Could not read: ${fileError instanceof Error ? fileError.message : String(fileError)}]`,
          };
        }
      }
    })
  );
}
