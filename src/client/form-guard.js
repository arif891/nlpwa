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
export function isUserEditing({ checkDirty = true } = {}) {
  if (typeof document === 'undefined') return false;
  const activeElem = document.activeElement;
  if (activeElem && !activeElem.disabled && !activeElem.readOnly) {
    const activeTag = activeElem.tagName?.toLowerCase();
    if (activeTag === 'textarea' || activeTag === 'select' || activeElem.isContentEditable) {
      return true;
    }
    if (activeTag === 'input') {
      const type = activeElem.type?.toLowerCase();
      if (!NON_EDITING_INPUT_TYPES.has(type)) {
        return true;
      }
    }
  }

  // Check for dirty/modified form inputs even if focus was blurred
  if (checkDirty && typeof document.querySelectorAll === 'function') {
    try {
      const inputs = document.querySelectorAll(
        'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])'
      );
      for (const el of inputs) {
        if (el.value !== el.defaultValue) {
          return true;
        }
      }
      if (document.querySelector('[data-dirty="true"], [data-unsaved="true"]')) {
        return true;
      }
    } catch {}
  }

  return false;
}
