export interface TestFailure {
    name: string;
    file?: string;
    line?: number;
    message: string;
}

export interface TestRunSummary {
    passed: number;
    failed: number;
    failures: readonly TestFailure[];
}

export interface TestRunner {
    runFile(filePath: string, all?: boolean): Promise<TestRunSummary>;
    runFailed(): Promise<TestRunSummary>;
}

export function formatTestRunSummary(s: TestRunSummary): string {
    const lines: string[] = [
        `<summary passed=${s.passed} failed=${s.failed} />`,
    ];
    for (const f of s.failures) {
        lines.push(`<testFailure name="${f.name}">`);
        lines.push(`<message>${f.message}</message>`);
        if (f.file !== undefined && f.line !== undefined) {
            lines.push(`<location path="${f.file}" line="${f.line}" />`);
        }
        lines.push(`</testFailure>`);
    }
    return lines.join('\n') + '\n';
}
