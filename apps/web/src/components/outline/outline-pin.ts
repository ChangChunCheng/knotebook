import { useCallback, useState } from "react";

/**
 * 標題大綱的釘住偏好：全站一個設定（不分筆記），`"1"`＝釘住，取消時刪鍵。
 * 開到寬版、全寬筆記或空間不夠時只是暫時不釘，偏好照舊，回到能釘的筆記自動再釘住。
 * 儲存被封鎖時偏好只活在這次的 state。
 */
export const OUTLINE_PINNED_STORAGE_KEY = "outline.pinned";

export function readOutlinePinned(): boolean {
  try {
    return window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOutlinePinned(pinned: boolean): void {
  try {
    if (pinned) window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(OUTLINE_PINNED_STORAGE_KEY);
  } catch {
    // 儲存被封鎖：畫面照樣切換，只是不記住。
  }
}

/** 釘住偏好的 state；setter 先改畫面再盡力寫入儲存。 */
export function useOutlinePinned(): [boolean, (next: boolean) => void] {
  const [pinned, setPinned] = useState(readOutlinePinned);
  const update = useCallback((next: boolean) => {
    setPinned(next);
    writeOutlinePinned(next);
  }, []);
  return [pinned, update];
}
