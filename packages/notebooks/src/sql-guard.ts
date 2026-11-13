/**
 * What a site's database script or query may not do: reach a file of the host (`ATTACH`,
 * `VACUUM INTO`), change the engine (`PRAGMA`), load code (`load_extension`), or control the
 * transaction it runs in. A query runs inside a transaction that is rolled back, and a script
 * inside one that loads it whole; a `COMMIT` among their statements would end it early and
 * keep what follows. A host's own SQL authorizer may refuse these too; not every host's does
 * (cellb's checks only the first statement). A word in a string literal is refused as well:
 * rename it.
 */
const REFUSED_WORD = /\b(attach|detach|vacuum|pragma|load_extension)\b/i;

/** A transaction statement at the start of the text or of a statement, after comments. */
const TRANSACTION_STATEMENT =
  /(?:^|;)(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(begin|commit|end|rollback|savepoint|release)\b/i;

/** The word that makes `text` refused, in lower case, or undefined. */
export function refusedSql(text: string): string | undefined {
  return (REFUSED_WORD.exec(text)?.[1] ?? TRANSACTION_STATEMENT.exec(text)?.[1])?.toLowerCase();
}
