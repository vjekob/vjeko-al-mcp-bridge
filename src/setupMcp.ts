export type ClientId = 'claude-code' | 'cursor';

export interface ClientConfig {
    readonly id: ClientId;
    readonly label: string;
    readonly relativePath: string;
    readonly serversKey: 'mcpServers';
    readonly includeType: boolean;
}

export const SERVER_ID = 'al-mcp-bridge';

export const CLIENTS: readonly ClientConfig[] = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        relativePath: '.mcp.json',
        serversKey: 'mcpServers',
        includeType: true,
    },
    {
        id: 'cursor',
        label: 'Cursor',
        relativePath: '.cursor/mcp.json',
        serversKey: 'mcpServers',
        includeType: false,
    },
];

export function isConfigured(content: string | undefined, client: ClientConfig): boolean {
    if (content === undefined) return false;
    const parsed = tryParseJson(content);
    if (parsed === undefined) return false;
    const map = (parsed as Record<string, unknown>)[client.serversKey];
    if (!map || typeof map !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(map, SERVER_ID);
}

export function buildConfigContent(
    existing: string | undefined,
    client: ClientConfig,
    port: number,
): string {
    const parsed = (existing !== undefined ? tryParseJson(existing) : undefined) ?? {};
    const root = parsed as Record<string, unknown>;
    const url = `http://127.0.0.1:${port}/`;
    const entry: Record<string, unknown> = { url };
    if (client.includeType) entry.type = 'http';
    const servers = (root[client.serversKey] as Record<string, unknown> | undefined) ?? {};
    servers[SERVER_ID] = entry;
    root[client.serversKey] = servers;
    return JSON.stringify(root, null, 2) + '\n';
}

function tryParseJson(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        return undefined;
    }
}
