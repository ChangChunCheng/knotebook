import i18n from "@/i18n";
import en from "./mobile-toolbar.en.json";
import zhTW from "./mobile-toolbar.zh-TW.json";

/**
 * 手機編輯工具列的字串（首包上限）：只由 `components/editor/mobile/*` import，模組頂層註冊一次（冪等；
 * deep merge、不覆寫主檔既有鍵）。⚠ 不准從首包任何檔 import（scripts/check-bundle-size.mjs 的 MOBILE_TOOLBAR_I18N_MARKER 會紅）。
 * 新字串直接加進這兩個 JSON。做法同 `select-strings.ts`：主檔內容的檢查一律讀 `?raw`。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const MOBILE_TOOLBAR_STRINGS_READY = true;
