export function publishedMigrationSessionSettings(
  filename: string,
  content: string,
): readonly { readonly name: string; readonly sql: string }[];

export function publishedMigrationSessionPrelude(filename: string, content: string): string;
