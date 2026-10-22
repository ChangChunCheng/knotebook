import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TrashItemDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { usePurgeTrash, useRestoreTrash, useTrash } from "@/api/trash";
import { useSession } from "@/auth/useSession";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { splitTrashSections, trashDetailLine, trashItemTitle } from "@/lib/trash-display";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, RotateCcw, SquareCheck, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { EmptyTrashDialog, PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";

/**
 * 垃圾桶 tab 的面板（spec 2026-10-21 §6.10.1、§6.10.3）：`AppShell` 在 tab 為 `trash` 時放進 tabpanel，取代 `NoteList`。
 * - 列**不是連結**：垃圾桶裡的筆記不能開（非目標「預覽」，§2.2）；只有 hover 浮出的「還原」與 ⋮（還原／永久刪除）。
 * - 兩區「個人」「工作坊」（某區 0 篇整區不渲染），區內照 server 的順序（`deleted_at DESC`）。
 * - 標題列動作照 `tabSpec("trash").actions` 渲染（spec §9-3）。「選取」只送 `start`；選取模式的畫面在 PR-2b T5。
 * - 清空＝把**清單上**的 id 全部送 purge（spec §6.3.4-5）：之後才移入的不受影響；超過 200 由 `purgeTrashIds` 分批。
 * - 確認框成敗都關，結果走 toast（`trash-dialogs.tsx`）。動作完成後焦點回清單容器（被處理的列會卸載）。
 */

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const MESSAGE_CLASS = "p-2 text-sm text-muted-foreground";

interface RowActions {
  onRestore: (id: string) => void;
  onPurge: (id: string, trigger: HTMLElement | null) => void;
}

function TrashRow({ item, now, actions }: { item: TrashItemDto; now: number; actions: RowActions }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const locale = i18n.language;
  return (
    <li
      data-node-kind="note"
      data-node-id={item.id}
      title={trashItemTitle(item, { t, locale })}
      className="group/noterow flex items-center gap-0.5 rounded-md py-1.5 pl-2 pr-1 text-[13px] hover:bg-brand-soft hover:text-brand-on-soft"
    >
      {/* 兩行一律 <div>（同 NoteList 最近 tab 的兩行列）。 */}
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{trashDetailLine(item, { now, t, locale })}</div>
      </div>
      {/* 側欄 24px 例外（button.tsx 檔頭）；與筆記列 ⋮ 共用 hoverReveal("noterow")。 */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("trash.restoreFor", { title: item.title })}
        title={t("trash.restore")}
        onClick={() => actions.onRestore(item.id)}
        className={cn("h-6 w-6 shrink-0", hoverReveal("noterow"))}
      >
        <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      {/* controlled＋三步（preventDefault → 關選單 → 動作）：同 NoteMenu 檔頭的 focus trap 規矩。 */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.menuFor", { title: item.title })}
            className={cn("h-6 w-6 shrink-0", hoverReveal("noterow"))}
          >
            <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onRestore(item.id);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("trash.restore")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onPurge(item.id, triggerRef.current);
            }}
          >
            <Trash className="mr-2 h-4 w-4" />
            {t("trash.purge")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function TrashSection({ label, items, now, actions }: { label: string; items: TrashItemDto[]; now: number; actions: RowActions }) {
  const headingId = useId();
  return (
    <>
      <h3 id={headingId} className="flex h-6 items-center px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul aria-labelledby={headingId} className="space-y-0.5">
        {items.map((item) => (
          <TrashRow key={item.id} item={item} now={now} actions={actions} />
        ))}
      </ul>
    </>
  );
}

export function TrashPanel() {
  const { t } = useTranslation();
  const trash = useTrash();
  const { user } = useSession();
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const emptyButtonRef = useRef<HTMLButtonElement>(null);
  /** 單篇永久刪除的對象（確認框開著）。 */
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  /** 每開一次清空框 +1：送出後回來時只關「同一次」開的框（期間取消又重開的不關）。 */
  const emptyRoundRef = useRef(0);
  /** 開框的鈕（該列 ⋮／「清空」）：取消時焦點還給它（沒有 DialogTrigger，Radix 預設會掉到 body）。關框那次 render 的
   * state 已清掉，所以存 ref。 */
  const openerRef = useRef<HTMLElement | null>(null);
  /** 確認後是否已送出（成敗不論）：送出過的關框焦點回清單（被處理的列會卸載），取消的回開框的鈕。 */
  const submittedRef = useRef(false);
  /** 連點不重送：mutation 的 isPending 要等下一個 macrotask 才反映到 disabled。 */
  const busyRef = useRef(false);

  const items = trash.data?.items ?? [];
  const actionsDisabled = !trash.isSuccess || items.length === 0;

  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  const rowActions: RowActions = {
    onRestore: (id) =>
      void exclusive(async () => {
        try {
          toastTrashResult("restore", await restore.mutateAsync([id]), t);
        } catch (err) {
          toastTrashFailure("restore", err, t);
        }
        // 被還原的列會卸載：焦點原本在面板內（或已落 body）才拉回清單；等回應期間使用者已移到別處（例如編輯器）就不搶。
        const active = document.activeElement;
        if (active === null || active === document.body || rootRef.current?.contains(active)) listRef.current?.focus();
      }),
    onPurge: (id, trigger) => {
      openerRef.current = trigger;
      submittedRef.current = false;
      setPurgeId(id);
    },
  };

  async function purgeIds(ids: readonly string[], close: () => void): Promise<void> {
    await exclusive(async () => {
      submittedRef.current = true;
      try {
        toastTrashResult("purge", await purge.mutateAsync(ids), t);
      } catch (err) {
        toastTrashFailure("purge", err, t);
      } finally {
        close();
      }
    });
  }

  function focusAfterClose(event: Event): void {
    event.preventDefault();
    const opener = openerRef.current;
    if (!submittedRef.current && opener?.isConnected) opener.focus();
    else listRef.current?.focus();
  }

  function renderAction(action: HeaderActionId): ReactNode {
    switch (action) {
      case "selectMode":
        return (
          <Button
            key={action}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.select")}
            title={t("trash.select")}
            disabled={actionsDisabled}
            // 已在選取模式時不重送 `start`（reducer 的 start 會清空已勾的；標題列換字樣前那一幀連點兩下也一樣）。
            onClick={() => {
              if (!selection.active) updateSelection({ type: "start" });
            }}
            className="h-6 w-6 shrink-0"
          >
            <SquareCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        );
      case "emptyTrash":
        return (
          <Button
            key={action}
            ref={emptyButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            disabled={actionsDisabled}
            onClick={() => {
              openerRef.current = emptyButtonRef.current;
              submittedRef.current = false;
              emptyRoundRef.current += 1;
              setEmptyOpen(true);
            }}
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
          >
            {t("trash.emptyTrash")}
          </Button>
        );
      // 一般 tab 的動作由 NoteList 渲染，垃圾桶 tab 不宣告。
      case "newPersonalNote":
      case "newGroup":
        return null;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  function renderBody(): ReactNode {
    if (trash.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (trash.isError) {
      return (
        <p role="alert" className="p-2 text-sm text-destructive">
          {errorMessage(t, trash.error)}
        </p>
      );
    }
    if (items.length === 0) return <p className={MESSAGE_CLASS}>{t("trash.empty")}</p>;
    const { personal, workspace } = splitTrashSections(items);
    const now = Date.now();
    return (
      <>
        {personal.length > 0 && <TrashSection label={t("trash.sectionPersonal")} items={personal} now={now} actions={rowActions} />}
        {workspace.length > 0 && <TrashSection label={t("trash.sectionWorkspace")} items={workspace} now={now} actions={rowActions} />}
        {trash.data.truncated && <p className="p-2 text-[11px] text-muted-foreground">{t("trash.truncated")}</p>}
      </>
    );
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div data-sidebar-header="" className="flex items-center gap-0.5 px-2 pt-3 pb-1">
        <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
          <span className="truncate">{trash.isSuccess ? t("trash.header", { count: items.length }) : t("sidebar.trash")}</span>
        </span>
        {tabSpec("trash").actions.map(renderAction)}
      </div>
      <div data-sidebar-list="" tabIndex={-1} ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 focus-visible:outline-none">
        {renderBody()}
      </div>
      <PurgeConfirmDialog
        count={1}
        open={purgeId !== null}
        pending={purge.isPending}
        onConfirm={() => {
          if (purgeId === null) return;
          const target = purgeId;
          // 回應前取消又對別列開框：第一發回來時不關第二個框。
          void purgeIds([target], () => setPurgeId((current) => (current === target ? null : current)));
        }}
        onOpenChange={(open) => {
          if (!open) setPurgeId(null);
        }}
        onCloseAutoFocus={focusAfterClose}
      />
      <EmptyTrashDialog
        items={items}
        meHandle={user?.handle ?? null}
        open={emptyOpen}
        pending={purge.isPending}
        onConfirm={() => {
          // 開框後清單被重抓成 0 篇（別處已清掉）：不送空請求、不報「已永久刪除 0 篇」，直接關框。
          if (items.length === 0) {
            setEmptyOpen(false);
            return;
          }
          const round = emptyRoundRef.current;
          void purgeIds(
            items.map((item) => item.id),
            () => {
              if (emptyRoundRef.current === round) setEmptyOpen(false);
            },
          );
        }}
        onOpenChange={setEmptyOpen}
        onCloseAutoFocus={focusAfterClose}
      />
    </div>
  );
}
