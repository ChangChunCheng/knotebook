import i18n from "@/i18n";
import en from "./tour.en.json";
import zhTW from "./tour.zh-TW.json";

// Lazy bundle: never import from an entry-bundle file. addResourceBundle mutates the main JSON module objects
// (i18next doesn't clone resources), so tests read the main JSON via `?raw`.
// The main JSON has no tour keys; they all live under tourGuide.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const TOUR_STRINGS_READY = true;
