// Type shim for the VS Code `testObserver` proposed API.
// The actual API is provided by VS Code at runtime when the extension declares
// `enabledApiProposals: ["testObserver"]` and is launched with
// `--enable-proposed-api <publisher>.<extension-name>`.

import 'vscode';

declare module 'vscode' {
    namespace tests {
        const testResults: readonly TestRunResult[];
        const onDidChangeTestResults: Event<void>;
    }

    interface TestRunResult {
        readonly completedAt: number;
        readonly name?: string;
        readonly results: readonly TestResultSnapshot[];
    }

    interface TestResultSnapshot {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly uri?: Uri;
        readonly range?: Range;
        readonly children: readonly TestResultSnapshot[];
        readonly taskStates: readonly TestSnapshotTaskState[];
    }

    interface TestSnapshotTaskState {
        readonly state: TestResultState;
        readonly duration?: number;
        readonly messages: readonly TestMessage[];
    }

    enum TestResultState {
        Queued = 1,
        Running = 2,
        Passed = 3,
        Failed = 4,
        Skipped = 5,
        Errored = 6,
    }
}
