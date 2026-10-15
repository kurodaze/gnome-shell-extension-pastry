/** Collapses all whitespace runs so the text fits on one line. */
export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

// Previews only look at the start of the text, which keeps huge entries cheap
const PREVIEW_SOURCE_LENGTH = 4096;

/** One-line preview of `text`, cut to `max` characters. */
export function truncate(text: string, max: number): string {
    const cut = text.length > PREVIEW_SOURCE_LENGTH;
    const line = oneLine(cut ? text.slice(0, PREVIEW_SOURCE_LENGTH) : text);
    // Spread so surrogate pairs (emoji etc.) are never split
    const chars = [...line];
    if (chars.length <= max && !cut)
        return line;
    return `${chars.slice(0, max).join('').trimEnd()}...`;
}

export interface Matcher {
    valid: boolean;
    test(text: string): boolean;
}

/**
 * Builds a search matcher. `/pattern/flags` is a regular expression,
 * anything else is a case-insensitive substring search.
 */
export function buildMatcher(query: string): Matcher | null {
    if (!query)
        return null;

    const re = /^\/(.+)\/([a-z]*)$/s.exec(query);
    if (re) {
        try {
            // g and y make test() stateful, which breaks repeated matching
            const regex = new RegExp(re[1], re[2].replace(/[gy]/g, ''));
            return {valid: true, test: text => regex.test(text)};
        } catch {
            return {valid: false, test: () => false};
        }
    }

    // Case-insensitive without a lowercased copy of every entry per keystroke
    const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    return {valid: true, test: text => needle.test(text)};
}
