export const NON_EDITING_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio',
  'range', 'color', 'file', 'image', 'hidden',
]);

/**
 * Check if the user is currently editing an interactive element
 * (input, textarea, select, or contenteditable) to avoid discarding unsaved inputs.
 *
 * @returns {boolean}
 */
export function isUserEditing() {
  if (typeof document === 'undefined') return false;
  const activeElem = document.activeElement;
  if (!activeElem) return false;
  if (activeElem.disabled || activeElem.readOnly) return false;
  const activeTag = activeElem.tagName?.toLowerCase();
  if (activeTag === 'textarea' || activeTag === 'select' || activeElem.isContentEditable) {
    return true;
  }
  if (activeTag === 'input') {
    const type = activeElem.type?.toLowerCase();
    if (NON_EDITING_INPUT_TYPES.has(type)) {
      return false;
    }
    return true;
  }
  return false;
}
