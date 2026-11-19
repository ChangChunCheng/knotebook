// Types only, so `*InTx` code typed with `Tx` can't reach the pool and borrow a second connection mid-transaction.
import type { Db } from "./index.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
