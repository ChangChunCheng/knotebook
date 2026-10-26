import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGroupMembers, useGroups } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ImportMembersDialogProps = {
  /** 目前這個群組（不列在來源清單裡）。 */
  groupId: string;
  /** 目前這個群組的成員 userId：來源群組裡已在這裡的人不列出。 */
  currentMemberIds: ReadonlySet<string>;
  /** 自己（不列出；自己一定已在這個群組裡，除非是非成員的站台管理員）。 */
  myUserId: string | undefined;
  /** 加人表單目前選的角色名（說明文字用）。 */
  roleName: string;
  disabled: boolean;
  /** 按下確認：要加的 email（依來源名單的順序）。對話框隨即關閉，進度與結果在成員區塊顯示。 */
  onImport: (emails: string[]) => void;
};

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 「從其他群組匯入成員」：列出我所在的其他群組（`GET /api/groups` 只回我是成員的群組）→ 選一個 → 抓它的成員
 * （`GET …/members`，任一成員可讀）→ 勾選清單（預設全勾；已在這個群組的人與自己不列）→ 確認交給呼叫端依序加入。
 * 一次性複製：不建立任何「兩個群組的關聯」，來源群組之後的增減不會帶過來。
 * 觸發鈕用 `DialogTrigger`：關閉時 Radix 自己把焦點還給它。內容在關閉時卸載，每次打開都從頭選。
 */
export function ImportMembersDialog(props: ImportMembersDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={props.disabled}>
          {t("groups.bulk.importOpen")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <ImportBody
          {...props}
          onImport={(emails) => {
            setOpen(false);
            props.onImport(emails);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ImportBody({ groupId, currentMemberIds, myUserId, roleName, onImport }: ImportMembersDialogProps) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const [sourceId, setSourceId] = useState("");
  // 記「取消勾選的」而不是「勾選的」：名單晚到也自然是全勾（預設全勾），換來源群組時清空。
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const membersQuery = useGroupMembers(sourceId);

  const sources = (groupsQuery.data ?? []).filter((group) => group.id !== groupId);
  const candidates = sourceId === "" ? [] : (membersQuery.data ?? []).filter((m) => !currentMemberIds.has(m.userId) && m.userId !== myUserId);
  const picked = candidates.filter((m) => !unchecked.has(m.userId));
  const allChecked = candidates.length > 0 && picked.length === candidates.length;

  function toggle(userId: string, checked: boolean): void {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("groups.bulk.importTitle")}</DialogTitle>
        <DialogDescription>{t("groups.bulk.importDescription", { role: roleName })}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("groups.bulk.importNoGroups")}</p>
        ) : (
          <select
            aria-label={t("groups.bulk.importSourceLabel")}
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setUnchecked(new Set());
            }}
            className={SELECT_CLASS}
          >
            <option value="" disabled>
              {t("groups.bulk.importSourcePlaceholder")}
            </option>
            {sources.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        )}

        {sourceId !== "" &&
          (membersQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
          ) : membersQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.fallback")}
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("groups.bulk.importNobody")}</p>
          ) : (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={allChecked ? true : picked.length === 0 ? false : "indeterminate"}
                  onCheckedChange={() => setUnchecked(allChecked ? new Set(candidates.map((m) => m.userId)) : new Set())}
                />
                {t("groups.bulk.importSelectAll", { count: candidates.length })}
              </label>
              <ul aria-label={t("groups.bulk.importListLabel")} className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-input p-2">
                {candidates.map((m) => (
                  <li key={m.userId}>
                    <label className="flex min-w-0 items-center gap-2 py-1 text-sm">
                      <Checkbox
                        aria-label={m.email}
                        checked={!unchecked.has(m.userId)}
                        onCheckedChange={(checked) => toggle(m.userId, checked === true)}
                      />
                      <span className="truncate">{m.displayName}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{m.email}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t("groups.bulk.importExcludedHint")}</p>
            </div>
          ))}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("home.cancel")}
          </Button>
        </DialogClose>
        <Button type="button" variant="brandDeep" disabled={picked.length === 0} onClick={() => onImport(picked.map((m) => m.email))}>
          {t("groups.bulk.importConfirm", { count: picked.length })}
        </Button>
      </DialogFooter>
    </>
  );
}
