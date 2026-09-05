export type CustomFieldEditorState = {
  fieldType: string;
  options: string[];
  helpText: string;
  placeholder: string;
  defaultValue: unknown;
  minValue: string;
  maxValue: string;
  showInList: boolean;
  displayMode: string;
  allowedRoles: string[];
  referenceTable: string;
};

/** Replace only configuration owned by this editor; preserve extension and
 * reference-filter metadata, and never coerce exact bounds through Number. */
export function customFieldEditorConfig(original: Record<string, unknown>, state: CustomFieldEditorState): Record<string, unknown> {
  const config = { ...original };
  for (const key of ['options', 'helpText', 'placeholder', 'defaultValue', 'min', 'max', 'showInList', 'displayMode', 'allowedRoles', 'referenceTable']) delete config[key];
  const choices = state.fieldType === 'select' || state.fieldType === 'multi_select';
  const numeric = state.fieldType === 'number' || state.fieldType === 'currency';
  if (choices) config.options = state.options;
  if (state.helpText) config.helpText = state.helpText;
  if (state.placeholder && !choices && state.fieldType !== 'boolean') config.placeholder = state.placeholder;
  if (state.defaultValue !== undefined && state.defaultValue !== null && state.defaultValue !== '') config.defaultValue = state.defaultValue;
  if (numeric && state.minValue !== '') config.min = state.minValue.trim();
  if (numeric && state.maxValue !== '') config.max = state.maxValue.trim();
  if (state.showInList) config.showInList = true;
  if (state.displayMode !== 'always' && state.displayMode !== 'normal') config.displayMode = state.displayMode;
  if (state.allowedRoles.length) config.allowedRoles = state.allowedRoles;
  if (state.fieldType === 'reference') config.referenceTable = state.referenceTable;
  else delete config.referenceFilter;
  return config;
}
