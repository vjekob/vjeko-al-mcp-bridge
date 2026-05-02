export interface InitializeResult {
    alExtensionActive: boolean;
    message?: string;
}

export interface Initializer {
    initialize(appJsonPath: string): Promise<InitializeResult>;
}

export function formatInitializeResult(r: InitializeResult): string {
    const tag = `<init alExtensionActive="${r.alExtensionActive ? 'true' : 'false'}" />`;
    return r.message !== undefined ? `${tag}\n${r.message}\n` : `${tag}\n`;
}
