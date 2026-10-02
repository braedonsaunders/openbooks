export function extractHandwrittenAnnotations(previousBaseline: string): Map<string, string>;
export function canonicalizePgDump(rawDump: string, options?: { annotations?: Map<string, string>; registryRelations?: string[] }): string;
