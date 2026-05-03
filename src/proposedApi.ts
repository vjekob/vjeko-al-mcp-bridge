export const EXTENSION_ID = 'vjeko.vjeko-al-mcp-bridge';

export type ApiConfigResult =
    | { readonly action: 'already-configured' }
    | { readonly action: 'parse-failed' }
    | { readonly action: 'added' | 'created'; readonly content: string };

export function buildArgvContent(existing: string | undefined): ApiConfigResult {
    if (existing === undefined) {
        const root = { 'enable-proposed-api': [EXTENSION_ID] };
        return { action: 'created', content: JSON.stringify(root, null, 2) + '\n' };
    }

    const parsed = tryParseJsonc(existing);
    if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { action: 'parse-failed' };
    }

    const root = parsed as Record<string, unknown>;
    const current = root['enable-proposed-api'];
    const list: string[] = Array.isArray(current)
        ? current.filter((x): x is string => typeof x === 'string')
        : [];
    if (list.includes(EXTENSION_ID)) {
        return { action: 'already-configured' };
    }
    list.push(EXTENSION_ID);
    root['enable-proposed-api'] = list;
    return { action: 'added', content: JSON.stringify(root, null, 2) + '\n' };
}

function tryParseJsonc(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        // fall through and try after stripping comments
    }
    try {
        return JSON.parse(stripJsonComments(content));
    } catch {
        return undefined;
    }
}

function stripJsonComments(input: string): string {
    return input.replace(
        /"(?:\\.|[^"\\])*"|\/\/.*$|\/\*[\s\S]*?\*\//gm,
        (match) => (match.startsWith('"') ? match : ''),
    );
}
