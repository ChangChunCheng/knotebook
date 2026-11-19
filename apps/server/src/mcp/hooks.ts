import type { IssueBulkTransferTokenSeam } from "../auth/tx/issue-bulk-transfer-token.js";
import type { IssueTransferTokenSeam } from "../auth/tx/issue-transfer-token.js";

export interface McpTestHooks {
  afterClose?: () => void;
  /** Called after the Response is materialized and before `reply.send`, on every request; a throw goes through our own `finally`, not the SDK. A test that wants "only the Nth" counts in the hook. */
  beforeReply?: () => void;
  beforeTool?: (name: string) => void;
  issueTransferToken?: IssueTransferTokenSeam;
  issueBulkTransferToken?: IssueBulkTransferTokenSeam;
}
