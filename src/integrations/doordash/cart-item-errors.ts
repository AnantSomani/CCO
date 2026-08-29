const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const optionGroupName = (value: unknown): string | null => {
  const group = asRecord(value);
  return asString(group?.name) ?? asString(group?.title);
};

const formatPrice = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `$${value.toFixed(2)}`;
};

const optionChoiceLabel = (value: unknown): string | null => {
  const option = asRecord(value);
  if (!option) return null;
  const name = asString(option.name) ?? asString(option.title);
  if (!name) return null;
  const price = formatPrice(option.price);
  return price ? `${name} (${price})` : name;
};

const requiredOptionSummary = (entry: Record<string, unknown>): string[] => {
  if (!Array.isArray(entry.required_options)) return [];
  return entry.required_options.flatMap((group) => {
    const name = optionGroupName(group);
    if (!name) return [];
    const record = asRecord(group);
    const choices = Array.isArray(record?.options)
      ? record.options.flatMap((option) => {
          const label = optionChoiceLabel(option);
          return label ? [label] : [];
        })
      : [];
    if (choices.length === 0) return [name];
    return [`${name}: ${joinNames(choices.slice(0, 8))}`];
  });
};

const itemLabel = (entry: Record<string, unknown>): string => {
  const request = asRecord(entry.request);
  return (
    asString(entry.item_name) ??
    asString(entry.name) ??
    asString(request?.item_name) ??
    asString(request?.name) ??
    'an item'
  );
};

const joinNames = (names: string[]): string => {
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
};

const formatOneError = (value: unknown): string | null => {
  const entry = asRecord(value);
  if (!entry) return null;
  const name = itemLabel(entry);
  const required = requiredOptionSummary(entry);
  if (required.length > 0) return `${name} needs ${joinNames(required)}`;
  if (typeof entry.error_message === 'string' && entry.error_message.trim()) {
    return `${name}: ${entry.error_message.trim()}`;
  }
  if (typeof entry.message === 'string' && entry.message.trim()) {
    return `${name}: ${entry.message.trim()}`;
  }
  return `${name} could not be added`;
};

export const formatCartItemErrors = (errors: unknown[]): string => {
  const parts = errors
    .flatMap((entry) => {
      const formatted = formatOneError(entry);
      return formatted ? [`${formatted}.`] : [];
    })
    .slice(0, 5);
  const body = parts.length > 0 ? parts.join(' ') : 'Those items could not be added.';
  return `DoorDash could not add the items. ${body} I did not submit an order. Tell me the required options and I can try again.`;
};
