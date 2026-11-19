import { inputRulesPlugin, type Editor } from "@tiptap/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transaction/EditorState types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

export interface PmPluginSpec {
  appendTransaction?(trs: readonly Any[], oldState: Any, newState: Any): Any;
  filterTransaction?(tr: Any, state: Any): boolean;
  props?: { decorations?(state: Any): Any; transformPasted?(slice: Any, view: Any): Any };
  state?: { init(config: Any, state: Any): Any; apply(tr: Any, value: Any, oldState: Any, newState: Any): Any };
  view?(view: Any): { update?(view: Any, prevState: Any): void; destroy?(): void };
}

/**
 * `@tiptap/pm/state` isn't an apps/web dependency (MODULE_NOT_FOUND in the Vite
 * transform), so take the `Plugin` class from tiptap's own `inputRulesPlugin` instance
 * (construction doesn't touch `editor`).
 */
const PluginClass = (inputRulesPlugin({ editor: undefined as unknown as Editor, rules: [] }) as unknown as { constructor: new (spec: PmPluginSpec) => unknown })
  .constructor;

export function createPmPlugin(spec: PmPluginSpec): unknown {
  return new PluginClass(spec);
}
