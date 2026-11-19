import { isCustomColor } from "@knotebook/shared";

// #378: custom #rrggbb colors have no prewritten CSS, so rules are registered per code present.
// Each rule is inserted separately so one rejected rule (e.g. no :has support) leaves the others.

export type CustomColorKind = "inline" | "block";
export type CustomColorProp = "textColor" | "backgroundColor";

export const CUSTOM_COLORS_STYLE_ID = "kb-custom-colors";

const ATTR: Record<CustomColorProp, string> = {
  textColor: "data-text-color",
  backgroundColor: "data-background-color",
};
const DECL: Record<CustomColorProp, string> = {
  textColor: "color",
  backgroundColor: "background-color",
};

/** `hex` must already pass isCustomColor: it is spliced into a selector. */
export function customColorSelectors(kind: CustomColorKind, prop: CustomColorProp, hex: string): string[] {
  if (kind === "inline") {
    const sel = `[data-style-type="${prop}"][data-value="${hex}"]`;
    return [sel, `.kn-present ${sel}`];
  }
  const attr = ATTR[prop];
  // Same shape as the built-in color rules in present.css, so specificity matches on the presentation screen.
  return [
    `[${attr}="${hex}"]`,
    `.bn-block:has(> .bn-block-content[${attr}="${hex}"])`,
    `.kn-present [${attr}="${hex}"]`,
  ];
}

const registered = new Set<string>();

function getSheet(): CSSStyleSheet | null {
  let el = document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_COLORS_STYLE_ID;
    document.head.appendChild(el);
  }
  return el.sheet;
}

export function ensureCustomColor(kind: CustomColorKind, prop: CustomColorProp, hex: string): void {
  if (!isCustomColor(hex)) return;
  // prop is spliced into a selector; never register values outside the type.
  if (prop !== "textColor" && prop !== "backgroundColor") return;
  const key = `${kind}|${prop}|${hex}`;
  if (registered.has(key)) return;
  registered.add(key);
  const sheet = getSheet();
  if (!sheet) return;
  for (const sel of customColorSelectors(kind, prop, hex)) {
    try {
      sheet.insertRule(`${sel} { ${DECL[prop]}: ${hex}; }`, sheet.cssRules.length);
    } catch {
    }
  }
}

export const CUSTOM_COLOR_SELECTOR =
  '[data-value^="#"], [data-text-color^="#"], [data-background-color^="#"]';

const OBSERVER_KEY = Symbol.for("knotebook.customColors.observer");
type ObserverHost = { [OBSERVER_KEY]?: MutationObserver };

/** DOM attribute values are mapped to literal prop/kind and validated; never spliced into a selector directly. */
function registerElement(el: Element): void {
  const styleType = el.getAttribute("data-style-type");
  const value = el.getAttribute("data-value");
  if (value !== null) {
    if (styleType === "textColor") ensureCustomColor("inline", "textColor", value);
    else if (styleType === "backgroundColor") ensureCustomColor("inline", "backgroundColor", value);
  }
  const text = el.getAttribute("data-text-color");
  if (text !== null) ensureCustomColor("block", "textColor", text);
  const bg = el.getAttribute("data-background-color");
  if (bg !== null) ensureCustomColor("block", "backgroundColor", bg);
}

function registerTree(node: Node): void {
  if (!(node instanceof Element)) return;
  if (node.matches(CUSTOM_COLOR_SELECTOR)) registerElement(node);
  node.querySelectorAll(CUSTOM_COLOR_SELECTOR).forEach(registerElement);
}

/** Colors applied by remote collaborators never pass local operations, so they can only be registered from the DOM. */
export function installCustomColors(root: Element = document.body): void {
  const host = document as unknown as ObserverHost;
  host[OBSERVER_KEY]?.disconnect();
  registerTree(root);
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "attributes") {
        if (rec.target instanceof Element) registerElement(rec.target);
      }
      else rec.addedNodes.forEach(registerTree);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-value", "data-text-color", "data-background-color"],
  });
  host[OBSERVER_KEY] = observer;
}

export function resetCustomColorsForTest(): void {
  const host = document as unknown as ObserverHost;
  host[OBSERVER_KEY]?.disconnect();
  delete host[OBSERVER_KEY];
  registered.clear();
  document.getElementById(CUSTOM_COLORS_STYLE_ID)?.remove();
}
