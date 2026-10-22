/**
 * 資料夾交易與服務層共用的錯誤訊息（plan 附錄 C；HTTP 層中文）。`folders/tx/*` 與 `folders/service.ts` 都從這裡 import，
 * 交易內與交易外快速路徑丟出的 404／403／409 逐位元組相同。純資料（S14：tx 檔可 import）。
 * 只有服務層會丟的訊息（名稱三句、撞名、節流、server_busy）留在 `service.ts` 檔頭。
 */
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";

export const FOLDER_NOT_FOUND_MESSAGE = "找不到此資料夾";
export const FOLDER_FORBIDDEN_MESSAGE = "沒有管理這個資料夾的權限";
/** 群組根層（以群組 id 進來、沒有具體資料夾）角色不能編輯；句型同 `POST /api/notes {groupId}`。 */
export const FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE = "你在這個群組的角色不能建立資料夾";
export const FOLDER_TOO_DEEP_MESSAGE = `資料夾最多 ${FOLDER_DEPTH_MAX} 層`;
export const FOLDER_LIMIT_MESSAGE = "資料夾數量已達上限";
/** 搬資料夾：兩者都看得到但不同空間（§5.7.3）。 */
export const FOLDER_CROSS_SPACE_MESSAGE = "資料夾不能移到其他空間";
export const FOLDER_CYCLE_MESSAGE = "不能把資料夾移到它自己裡面";
