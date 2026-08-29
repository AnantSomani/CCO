export type ItemOptionChoice = {
  id: string;
  name: string;
  groups: ItemOptionGroup[];
};

export type ItemOptionGroup = {
  name: string;
  min: number;
  max: number | null;
  required: boolean;
  options: ItemOptionChoice[];
};

export type NormalizedItemDetails = {
  itemId?: string;
  name?: string;
  groups: ItemOptionGroup[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const asId = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
};

const asCount = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

const unwrapItemRecord = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value) ?? {};
  for (const key of ['item', 'item_details', 'data', 'result'] as const) {
    const nested = asRecord(record[key]);
    if (nested && (Array.isArray(nested.extras) || nested.item_id || nested.name || nested.title)) {
      return { ...record, ...nested };
    }
  }
  return record;
};

const extrasFrom = (record: Record<string, unknown>): unknown[] => {
  for (const key of ['extras', 'extra_groups', 'option_groups', 'required_options'] as const) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
};

const choiceFrom = (value: unknown): ItemOptionChoice | null => {
  const option = asRecord(value);
  if (!option) return null;
  const id = asId(option.id) ?? asId(option.option_id);
  const name = asString(option.name) ?? asString(option.title) ?? id;
  if (!id || !name) return null;
  return {
    id,
    name,
    groups: extrasFrom(option).flatMap((extra) => {
      const group = groupFrom(extra);
      return group ? [group] : [];
    }),
  };
};

const groupFrom = (value: unknown): ItemOptionGroup | null => {
  const extra = asRecord(value);
  if (!extra) return null;
  const options = Array.isArray(extra.options)
    ? extra.options.flatMap((option) => {
        const choice = choiceFrom(option);
        return choice ? [choice] : [];
      })
    : [];
  const minCount = asCount(extra.min_num_options);
  const min =
    minCount !== null && minCount > 0
      ? minCount
      : extra.required === true || extra.is_required === true
        ? 1
        : 0;
  const max = asCount(extra.max_num_options);
  const name = asString(extra.name) ?? asString(extra.title) ?? 'a required option';
  return {
    name,
    min,
    max,
    required: min > 0,
    options,
  };
};

export const normalizeItemDetails = (value: unknown): NormalizedItemDetails => {
  const record = unwrapItemRecord(value);
  return {
    itemId: asId(record.item_id) ?? undefined,
    name: asString(record.name) ?? asString(record.title) ?? undefined,
    groups: extrasFrom(record).flatMap((extra) => {
      const group = groupFrom(extra);
      return group ? [group] : [];
    }),
  };
};

export const requiredOptionGroups = (details: NormalizedItemDetails): ItemOptionGroup[] =>
  details.groups.filter((group) => group.required);

const optionId = (value: unknown): string | null => {
  const record = asRecord(value);
  if (!record) return null;
  return asId(record.id) ?? asId(record.option_id);
};

const childSelections = (value: unknown): Array<Record<string, unknown>> => {
  const record = asRecord(value);
  if (!record) return [];
  const children = [record.options, record.nested_options].flatMap((entry) =>
    Array.isArray(entry) ? entry : [],
  );
  return children.flatMap((child) => {
    const nested = asRecord(child);
    return nested ? [nested] : [];
  });
};

export const itemOptionIds = (details: NormalizedItemDetails): Set<string> => {
  const ids = new Set<string>();
  const visit = (groups: ItemOptionGroup[]): void => {
    for (const group of groups) {
      for (const option of group.options) {
        ids.add(option.id);
        visit(option.groups);
      }
    }
  };
  visit(details.groups);
  return ids;
};

export const selectedOptionIds = (
  nestedOptions: Array<Record<string, unknown>> | undefined,
): string[] => {
  if (!nestedOptions) return [];
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const id = optionId(record);
    if (id) ids.push(id);
    visit(record.options);
    visit(record.nested_options);
  };
  visit(nestedOptions);
  return ids;
};

const missingFromGroups = (
  groups: ItemOptionGroup[],
  selected: Array<Record<string, unknown>>,
): string[] => {
  const selectedIds = new Set(
    selected.flatMap((entry) => {
      const id = optionId(entry);
      return id ? [id] : [];
    }),
  );
  return groups.flatMap((group) => {
    if (!group.required) {
      return selected.flatMap((entry) => {
        const id = optionId(entry);
        const choice = group.options.find((option) => option.id === id);
        return choice ? missingFromGroups(choice.groups, childSelections(entry)) : [];
      });
    }
    const hits = group.options.filter((option) => selectedIds.has(option.id));
    if (hits.length < group.min) return [group.name];
    return hits.flatMap((choice) => {
      const entry = selected.find((node) => optionId(node) === choice.id);
      return missingFromGroups(choice.groups, entry ? childSelections(entry) : []);
    });
  });
};

export const missingRequiredOptionNames = (
  details: NormalizedItemDetails,
  nestedOptions: Array<Record<string, unknown>> | undefined,
): string[] => missingFromGroups(details.groups, nestedOptions ?? []);

const normalizeOptionName = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[™®*']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const namesMatch = (left: string, right: string): boolean => {
  const a = normalizeOptionName(left);
  const b = normalizeOptionName(right);
  return a === b || a.includes(b) || b.includes(a);
};

const flattenSelections = (
  selected: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  const visit = (entry: Record<string, unknown>): void => {
    out.push(entry);
    for (const child of childSelections(entry)) visit(child);
  };
  for (const entry of selected) visit(entry);
  return out;
};

const matchChoice = (
  choices: ItemOptionChoice[],
  entry: Record<string, unknown>,
): ItemOptionChoice | null => {
  const id = optionId(entry);
  if (id) {
    const byId = choices.find((choice) => choice.id === id);
    if (byId) return byId;
  }
  const name = asString(entry.name) ?? asString(entry.title);
  if (!name) return null;
  const exact = choices.filter(
    (choice) => normalizeOptionName(choice.name) === normalizeOptionName(name),
  );
  if (exact.length === 1) return exact[0] ?? null;
  const fuzzy = choices.filter((choice) => namesMatch(choice.name, name));
  return fuzzy.length === 1 ? (fuzzy[0] ?? null) : null;
};

const selectionNode = (
  choice: ItemOptionChoice,
  children: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  id: choice.id,
  name: choice.name,
  quantity: 1,
  ...(children.length > 0 ? { options: children } : {}),
});

export const arrangeSelectedOptions = (
  details: NormalizedItemDetails,
  nestedOptions: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined => {
  if (!nestedOptions || nestedOptions.length === 0) return nestedOptions;
  const flat = flattenSelections(nestedOptions);
  const used = new Set<string>();
  const takeFrom = (groups: ItemOptionGroup[]): Array<Record<string, unknown>> => {
    const choices = groups.flatMap((group) => group.options);
    return flat.flatMap((entry) => {
      const choice = matchChoice(choices, entry);
      if (!choice || used.has(choice.id)) return [];
      used.add(choice.id);
      return [selectionNode(choice, takeFrom(choice.groups))];
    });
  };
  const arranged = takeFrom(details.groups);
  return arranged.length > 0 ? arranged : nestedOptions;
};

const applyDefaultsToGroups = (
  groups: ItemOptionGroup[],
  selected: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  const next = selected.map((entry) => ({ ...entry }));
  for (const group of groups) {
    if (!group.required || group.options.length !== 1) continue;
    const only = group.options[0];
    if (!only) continue;
    if (next.some((entry) => optionId(entry) === only.id)) continue;
    next.push({
      id: only.id,
      name: only.name,
      quantity: 1,
      options: applyDefaultsToGroups(only.groups, []),
    });
  }
  return next.map((entry) => {
    const id = optionId(entry);
    const choice = groups.flatMap((group) => group.options).find((option) => option.id === id);
    if (!choice) return entry;
    return { ...entry, options: applyDefaultsToGroups(choice.groups, childSelections(entry)) };
  });
};

export const applyDefaultSingleChoices = (
  details: NormalizedItemDetails,
  nestedOptions: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined => {
  const filled = applyDefaultsToGroups(details.groups, nestedOptions ?? []);
  if (filled.length === 0 && !nestedOptions) return undefined;
  return filled;
};

type SummarizedOptionGroup = {
  name: string;
  min: number;
  max: number | null;
  choices: Array<{
    id: string;
    name: string;
    requiredOptions?: SummarizedOptionGroup[];
  }>;
};

const summarizeGroup = (group: ItemOptionGroup): SummarizedOptionGroup => ({
  name: group.name,
  min: group.min,
  max: group.max,
  choices: group.options.map((option) => {
    const nested = option.groups.filter((nestedGroup) => nestedGroup.required);
    return {
      id: option.id,
      name: option.name,
      ...(nested.length > 0 ? { requiredOptions: nested.map(summarizeGroup) } : {}),
    };
  }),
});

export const summarizeItemDetails = (details: NormalizedItemDetails) => ({
  itemId: details.itemId,
  name: details.name,
  hasRequiredOptions: requiredOptionGroups(details).length > 0,
  requiredOptions: requiredOptionGroups(details).map(summarizeGroup),
});
