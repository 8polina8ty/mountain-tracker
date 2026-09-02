declare module "node:sqlite" {
  type SQLInputValue = string | number | bigint | null | Uint8Array;

  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...values: SQLInputValue[]): StatementResultingChanges;
    get(...values: SQLInputValue[]): Record<string, unknown> | undefined;
    all(...values: SQLInputValue[]): Array<Record<string, unknown>>;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
