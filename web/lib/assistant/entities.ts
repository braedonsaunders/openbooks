export type AssistantDocumentEntity = {
  id: string;
  kind: string;
  documentNumber: string;
  referenceNumber?: string;
  documentDate?: string;
  dueDate?: string;
  status?: string;
  currency?: string;
  total?: string | number;
  party?: string;
  partyId?: string;
  postedEntryId?: string;
  memo?: string;
};

export type AssistantPartyEntity = {
  id: string;
  displayName: string;
  kind?: string;
  shortCode?: string;
  email?: string;
  phone?: string;
  isActive?: boolean;
};

export type AssistantEntityIndex = {
  documentsByReference: ReadonlyMap<string, AssistantDocumentEntity>;
  partiesByName: ReadonlyMap<string, AssistantPartyEntity>;
};

type AnyRecord = Record<string, unknown>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KIND = /^[a-z][a-z0-9_]{0,63}$/;

function record(value: unknown): AnyRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function uuid(value: unknown): string | undefined {
  const resolved = text(value);
  return resolved && UUID.test(resolved) ? resolved : undefined;
}

function resultData(output: unknown): AnyRecord | null {
  const wrapper = record(output);
  if (!wrapper || wrapper.ok === false) return null;
  return record(wrapper.data) ?? wrapper;
}

function documentEntity(value: unknown): AssistantDocumentEntity | null {
  const item = record(value);
  if (!item) return null;
  const id = uuid(item.id);
  const kind = text(item.kind);
  const documentNumber = text(item.documentNumber);
  if (!id || !kind || !KIND.test(kind) || !documentNumber) return null;

  const total =
    typeof item.total === "number" || typeof item.total === "string"
      ? item.total
      : undefined;
  return {
    id,
    kind,
    documentNumber,
    referenceNumber: text(item.referenceNumber),
    documentDate: text(item.documentDate),
    dueDate: text(item.dueDate),
    status: text(item.status),
    currency: text(item.currency),
    total,
    party: text(item.party),
    partyId: uuid(item.partyId),
    postedEntryId: uuid(item.postedEntryId),
    memo: text(item.memo),
  };
}

function partyEntity(value: unknown): AssistantPartyEntity | null {
  const item = record(value);
  if (!item) return null;
  const id = uuid(item.id);
  const displayName = text(item.displayName);
  if (!id || !displayName) return null;
  return {
    id,
    displayName,
    kind: text(item.kind),
    shortCode: text(item.shortCode),
    email: text(item.email),
    phone: text(item.phone),
    isActive: typeof item.isActive === "boolean" ? item.isActive : undefined,
  };
}

export function assistantEntitiesFromToolOutput(
  toolName: string,
  output: unknown,
): { documents: AssistantDocumentEntity[]; parties: AssistantPartyEntity[] } {
  const data = resultData(output);
  if (!data) return { documents: [], parties: [] };

  if (toolName === "find_documents") {
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      documents: items
        .map(documentEntity)
        .filter((item): item is AssistantDocumentEntity => !!item),
      parties: [],
    };
  }
  if (toolName === "get_document") {
    const document = documentEntity(data);
    return { documents: document ? [document] : [], parties: [] };
  }
  if (toolName === "find_parties") {
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      documents: [],
      parties: items
        .map(partyEntity)
        .filter((item): item is AssistantPartyEntity => !!item),
    };
  }
  return { documents: [], parties: [] };
}

function normalizedReference(value: string): string {
  return value.trim().toLowerCase();
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

/**
 * Builds a record lookup from every completed tool part in one assistant turn.
 * The lookup lets historic markdown links inherit the IDs already saved in the
 * tool result, so old generic /ar and /ap links become native drawer links.
 */
export function assistantEntityIndex(parts: unknown[]): AssistantEntityIndex {
  const documents = new Map<string, AssistantDocumentEntity>();
  const parties = new Map<string, AssistantPartyEntity>();

  for (const rawPart of parts) {
    const part = record(rawPart);
    const type = text(part?.type);
    if (
      !part ||
      !type ||
      (type !== "dynamic-tool" && !type.startsWith("tool-"))
    )
      continue;
    const toolName =
      type === "dynamic-tool"
        ? text(part.toolName)
        : type.slice("tool-".length);
    if (!toolName) continue;
    const entities = assistantEntitiesFromToolOutput(toolName, part.output);
    for (const document of entities.documents) {
      const key = normalizedReference(document.documentNumber);
      const previous = documents.get(key);
      documents.set(key, {
        ...previous,
        ...definedFields(document),
      } as AssistantDocumentEntity);
    }
    for (const party of entities.parties) {
      const key = normalizedReference(party.displayName);
      const previous = parties.get(key);
      parties.set(key, {
        ...previous,
        ...definedFields(party),
      } as AssistantPartyEntity);
    }
  }

  return { documentsByReference: documents, partiesByName: parties };
}

export function assistantDocumentByLabel(
  index: AssistantEntityIndex | undefined,
  label: string,
): AssistantDocumentEntity | undefined {
  return index?.documentsByReference.get(normalizedReference(label));
}

export function assistantPartyByLabel(
  index: AssistantEntityIndex | undefined,
  label: string,
): AssistantPartyEntity | undefined {
  return index?.partiesByName.get(normalizedReference(label));
}
