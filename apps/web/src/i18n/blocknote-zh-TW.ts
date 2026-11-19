import { zhTW } from "@blocknote/core/locales";
import type { Dictionary } from "@blocknote/core";

// BlockNote's built-in dictionary, not a hand-made copy: its `Dictionary` type forces full key coverage, while a copy
// would silently go stale when BlockNote adds keys.
export const blocknoteZhTW: Dictionary = zhTW;
