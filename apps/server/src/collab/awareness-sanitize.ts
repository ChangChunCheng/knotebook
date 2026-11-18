/**
 * 入站 awareness 的伺服器端淨化（#312）。
 *
 * awareness 是 client 自報的資料：任何有編輯權的人都能偽造別人的 `user`（名字／顏色／id）、
 * 冒用他人或 server 的 client id、塞超大欄位，或送出會讓 y-prosemirror throw 的 cursor。
 * 所以 server 只信「這條連線是誰」（userId、顯示名、頭貼、角色都來自連線的驗證結果），
 * 把每筆狀態用 server 值整個重建，client 只貢獻合法的 cursor。
 *
 * 依賴的 Hocuspocus 4.5.0 行為（升級若改了這些，整合測試會抓到）：
 *   - `beforeHandleAwareness`／awareness 更新解碼出的 map 可原地修改，re-encode 時依 map 的 key 為準；
 *   - 暫存用的 Awareness 會多一筆自己的 `{}` 條目；
 *   - `document.getClients(connection)` 回傳的是 `removeConnection` 實際使用的活 Set，
 *     所以對它 add／delete 就等於登記／註銷該連線擁有的 client id；
 *     連線已移除（`close()` 之後仍會處理佇列中的訊息）時則回傳一個用完即丟的新 Set，
 *     登記會憑空消失，所以已不在文件連線清單內的連線要整批拒絕。
 */
import {
  PRESENCE_FIELD,
  collabUserColor,
  parseAwarenessCursor,
  type AvatarRef,
  type PresenceRole,
  type UserPresenceField,
} from "@knotebook/shared";

/** 一條連線最多可擁有的 awareness client id 數。 */
export const MAX_AWARENESS_CLIENTS_PER_CONNECTION = 1;

/** server 自己寫 awareness（AI 代理頭像）時使用的 origin。 */
export const SERVER_PRESENCE_ORIGIN = "ai-presence";

export interface ConnectionPresence {
  name: string;
  avatar: AvatarRef | null;
  since: number;
  role: PresenceRole;
}

export type AwarenessIssue =
  | "foreign-client"
  | "server-client"
  | "client-limit"
  | "user-mismatch"
  | "bad-cursor"
  | "no-identity";

/** 結構型別，Hocuspocus 的 `Connection`／`Document` 直接符合。 */
export interface AwarenessConn {
  context?: { userId?: unknown };
}

export interface AwarenessDoc {
  awareness: { states: ReadonlyMap<number, unknown> };
  getConnections(): AwarenessConn[];
  getClients(connection: AwarenessConn): Set<number>;
}

export interface SanitizeInput {
  states: Map<number, Record<string, unknown>>;
  document: AwarenessDoc;
  connection: AwarenessConn | undefined;
  userId: string | undefined;
  presence: ConnectionPresence | undefined;
  /** 唯讀連線：游標位置不分享，cursor 一律清成 null。 */
  readOnly: boolean;
  serverOwned: ReadonlySet<number>;
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * 原地淨化 `states`，回傳遇到的問題（可重複，供記錄用）。依 map 順序逐筆處理，
 * 順序會影響「同批第二個新 id 被拒」的判定。絕不 throw。
 */
export function sanitizeInboundAwareness(input: SanitizeInput): AwarenessIssue[] {
  const { states, document, connection, userId, presence, readOnly, serverOwned } = input;
  if (!connection || userId === undefined || !presence) {
    states.clear();
    return ["no-identity"];
  }
  const connections = document.getConnections();
  if (!connections.includes(connection)) {
    // 連線已被移除：登記不到任何地方，放行會留下沒有連線擁有的孤兒狀態。
    states.clear();
    return ["no-identity"];
  }
  const issues: AwarenessIssue[] = [];
  const mine = document.getClients(connection);

  for (const [id, state] of [...states]) {
    // 暫存 Awareness 自己的 `{}`，或 client 送的空狀態：沒有東西可顯示。
    if (!isPlainObject(state) || Object.keys(state).length === 0) {
      states.delete(id);
      continue;
    }
    if (serverOwned.has(id)) {
      states.delete(id);
      mine.delete(id);
      issues.push("server-client");
      continue;
    }
    const owner: AwarenessConn | undefined = mine.has(id) ? connection : connections.find((c) => document.getClients(c).has(id));
    if (owner === connection) {
      // 已登記在這條連線上
    } else if (owner) {
      if (owner.context?.userId === userId) {
        if (mine.size >= MAX_AWARENESS_CLIENTS_PER_CONNECTION) {
          // 接手同樣算新增，否則兩條連線互相接手可無限累積 id。
          states.delete(id);
          issues.push("client-limit");
          continue;
        }
        document.getClients(owner).delete(id);
        mine.add(id);
      } else {
        states.delete(id);
        issues.push("foreign-client");
        continue;
      }
    } else if (document.awareness.states.has(id)) {
      // 沒有連線擁有、文件上卻有這個狀態：是 server 寫的。
      states.delete(id);
      issues.push("server-client");
      continue;
    } else if (mine.size >= MAX_AWARENESS_CLIENTS_PER_CONNECTION) {
      states.delete(id);
      issues.push("client-limit");
      continue;
    } else {
      // 同時把重連的 client 綁到新連線，關閉時狀態會立即移除。
      mine.add(id);
    }

    const claimed = isPlainObject(state.user) ? state.user.id : undefined;
    if (typeof claimed === "string" && claimed !== userId) issues.push("user-mismatch");
    const cursor = readOnly ? null : parseAwarenessCursor(state.cursor);
    if (!readOnly && state.cursor != null && cursor === null) issues.push("bad-cursor");

    const field: UserPresenceField = {
      v: 1,
      kind: "user",
      role: presence.role,
      avatar: presence.avatar,
      since: presence.since,
    };
    states.set(id, {
      user: { id: userId, name: presence.name, color: collabUserColor(userId) },
      [PRESENCE_FIELD]: field,
      cursor,
    });
  }
  return issues;
}

/** 記錄每份文件中由 server 自己擁有的 awareness client id；文件卸載時隨 WeakMap 一起釋放。 */
export class ServerOwnedClients {
  private readonly byDocument = new WeakMap<object, Set<number>>();

  mark(document: object, ids: readonly number[]): void {
    let set = this.byDocument.get(document);
    if (!set) {
      set = new Set();
      this.byDocument.set(document, set);
    }
    for (const id of ids) set.add(id);
  }

  get(document: object): ReadonlySet<number> {
    return this.byDocument.get(document) ?? new Set();
  }
}
