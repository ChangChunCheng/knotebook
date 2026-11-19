import i18n from "@/i18n";
import en from "./mobile-toolbar.en.json";
import zhTW from "./mobile-toolbar.zh-TW.json";

// Lazy bundle (an entry-bundle import fails scripts/check-bundle-size.mjs). Tests read the main JSON via `?raw`.
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const MOBILE_TOOLBAR_STRINGS_READY = true;
