const NATIVE_CONTEXT_MENU = "native";
const DISABLED_CONTEXT_MENU = "disabled";

const textInputTypes = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

const contextMenuBlockingSelector = [
  ".non-selectable",
  "a",
  "button",
  "canvas",
  "img",
  "option",
  "select",
  "summary",
  "svg",
  "video",
  "[draggable='true']",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
].join(",");

const selectableContentSelector = ".selectable,code,pre";

function elementsFromPath(path: EventTarget[]) {
  return path.filter((target): target is Element => target instanceof Element);
}

function explicitPreference(elements: Element[]) {
  for (const element of elements) {
    const preference = element.getAttribute("data-context-menu");
    if (preference === NATIVE_CONTEXT_MENU) {
      return true;
    }
    if (preference === DISABLED_CONTEXT_MENU) {
      return false;
    }
  }

  return undefined;
}

function nearestContextPreference(elements: Element[]) {
  let inheritedContentEditableBlocked = false;

  for (const element of elements) {
    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled;
    }

    if (element instanceof HTMLInputElement) {
      return !element.disabled && textInputTypes.has(element.type);
    }

    if (element.getAttribute("contenteditable")?.toLowerCase() === "false") {
      inheritedContentEditableBlocked = true;
    }

    if (
      !inheritedContentEditableBlocked &&
      element instanceof HTMLElement &&
      element.isContentEditable
    ) {
      return element.getAttribute("aria-disabled") !== "true";
    }

    if (element.matches(contextMenuBlockingSelector)) {
      return false;
    }

    if (element.matches(selectableContentSelector)) {
      return true;
    }
  }

  return false;
}

/**
 * 桌面应用只在文本编辑或明确可复制的区域保留 WebView 原生菜单，
 * 避免普通界面暴露网页式的返回、刷新和开发者工具菜单。
 */
export function shouldShowDefaultContextMenu(path: EventTarget[]) {
  const elements = elementsFromPath(path);
  const override = explicitPreference(elements);
  if (override !== undefined) {
    return override;
  }

  return nearestContextPreference(elements);
}

export function handleGlobalContextMenu(event: MouseEvent) {
  if (!shouldShowDefaultContextMenu(event.composedPath())) {
    event.preventDefault();
  }
}
