import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
const db = new DatabaseSync(path);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all();
console.log("tables:", tables.map((t) => t.name));
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
    console.log(t.name, (c as { c: number }).c);
  } catch (e) {
    console.log(t.name, "err", (e as Error).message);
  }
}
db.close();
