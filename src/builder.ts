export type BuildSeverity = 'error' | 'warning' | 'info';

export interface BuildDiagnostic {
    severity: BuildSeverity;
    file: string;
    line: number;
    column?: number;
    code?: string;
    message: string;
}

export interface BuildSummary {
    errors: number;
    warnings: number;
    infos: number;
    diagnostics: readonly BuildDiagnostic[];
}

export interface Builder {
    build(folderPath: string): Promise<BuildSummary>;
}

export function formatBuildSummary(s: BuildSummary): string {
    const lines: string[] = [
        `<summary errors=${s.errors} warnings=${s.warnings} infos=${s.infos} />`,
    ];
    for (const d of s.diagnostics) {
        const codePart = d.code !== undefined ? ` code="${d.code}"` : '';
        const colPart = d.column !== undefined ? ` col="${d.column}"` : '';
        lines.push(
            `<diagnostic severity="${d.severity}" file="${d.file}" line="${d.line}"${colPart}${codePart}>${d.message}</diagnostic>`,
        );
    }
    return lines.join('\n') + '\n';
}
