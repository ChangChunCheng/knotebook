import i18n from "@/i18n";
import en from "./management.en.json";
import zhTW from "./management.zh-TW.json";

// Lazy bundle (an entry-bundle import fails scripts/check-bundle-size.mjs). The main JSON keeps only the keys the entry bundle
// needs; add new admin.*/settings.* keys to management.*.json. Every file using these keys imports it
// itself, since pages like AuthorizePage are reachable without opening settings (management-copy.test.ts checks).
// addResourceBundle mutates the main JSON module objects (i18next doesn't clone resources), so tests read it via `?raw`.
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const MANAGEMENT_STRINGS_READY = true;
