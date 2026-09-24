/**
 * s4 fixture: a TypeScript project where a method rename can't be done
 * correctly from text search alone.
 *
 * Three classes have a `close()` method — Account, Connection, FileHandle —
 * and the task renames only Account's. Call sites go through fields and
 * helpers whose type is declared away from the call: every service holds its
 * dependency as `this.target`, so a hit line like `this.target.close(...)`
 * says nothing about which class it is; the type is in that file's
 * constructor, and the registry helpers' return types are in another file.
 * `find_references` on Account.close answers exactly; a text search returns
 * every `.close(` in the project and leaves the model to work out each one.
 *
 * Deterministic (seeded), so every run and both --host modes see the same
 * project. `expected` is computed while generating.
 */

const KINDS = ['Account', 'Connection', 'FileHandle'];
const SERVICE_NAMES = [
  'billing', 'ledger', 'payout', 'refund', 'invoice', 'statement', 'dunning', 'audit', 'kyc', 'limits',
  'fraud', 'settlement', 'transfer', 'webhook', 'sync', 'export', 'import', 'backup', 'archive', 'cache',
  'session', 'socket', 'stream', 'upload', 'download', 'report', 'metrics', 'notify', 'schedule', 'cleanup',
  'migrate', 'reconcile', 'snapshot', 'retention', 'quota', 'health',
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** How each class's close() is called, and whether the call is awaited. */
const CALL = {
  Account: (recv, r) => `${recv}.close('${['duplicate', 'fraud', 'customer request', 'inactive'][Math.floor(r() * 4)]}')`,
  Connection: (recv) => `${recv}.close()`,
  FileHandle: (recv) => `await ${recv}.close()`,
};
const HELPER = { Account: 'lookupAccount', Connection: 'openConnection', FileHandle: 'openFile' };
const HELPER_ARG = { Account: 'id', Connection: 'host', FileHandle: 'path' };

export function symbolRenameFixture(seed = 20260924) {
  const r = rng(seed);
  const files = {};
  const expected = { Account: 0, Connection: 0, FileHandle: 0 };
  const accountCallFiles = new Set();

  files['tsconfig.json'] = JSON.stringify(
    { compilerOptions: { strict: true, target: 'es2022', module: 'commonjs', noEmit: true, skipLibCheck: true }, include: ['src'] },
    null,
    2
  ) + '\n';
  files['package.json'] = JSON.stringify({ name: 'accounts-platform', private: true, scripts: { typecheck: 'tsc --noEmit -p .' } }, null, 2) + '\n';
  files['.gitignore'] = 'node_modules/\n';
  files['README.md'] = `# accounts-platform

Account, network and file services. \`src/accounts\`, \`src/net\` and
\`src/files\` hold the core types; \`src/services\` holds one service per
concern. Type-check with \`npx tsc --noEmit\`.
`;

  files['src/accounts/account.ts'] = `import { audit } from '../audit';

export class Account {
  private closedAt: Date | null = null;

  constructor(
    public readonly id: string,
    public balance: number
  ) {}

  /** Closes the account; a closed account rejects every later operation. */
  close(reason: string): void {
    if (this.closedAt) throw new Error(\`account \${this.id} is already closed\`);
    this.closedAt = new Date();
    audit('account.closed', { id: this.id, reason });
  }

  isClosed(): boolean {
    return this.closedAt !== null;
  }

  deposit(amount: number): void {
    if (this.isClosed()) throw new Error('closed');
    this.balance += amount;
  }
}
`;
  files['src/net/connection.ts'] = `export class Connection {
  private open = true;

  constructor(public readonly host: string) {}

  send(payload: string): number {
    if (!this.open) throw new Error('connection closed');
    return payload.length;
  }

  close(): void {
    this.open = false;
  }
}
`;
  files['src/files/fileHandle.ts'] = `export class FileHandle {
  private released = false;

  constructor(public readonly path: string) {}

  async read(): Promise<string> {
    if (this.released) throw new Error('handle released');
    return '';
  }

  async close(): Promise<void> {
    this.released = true;
  }
}
`;
  files['src/audit.ts'] = `const events: string[] = [];

export function audit(event: string, data: Record<string, unknown>): void {
  events.push(\`\${event} \${JSON.stringify(data)}\`);
}
`;
  files['src/registry.ts'] = `import { Account } from './accounts/account';
import { Connection } from './net/connection';
import { FileHandle } from './files/fileHandle';

const accounts = new Map<string, Account>();

export function lookupAccount(id: string): Account {
  let a = accounts.get(id);
  if (!a) {
    a = new Account(id, 0);
    accounts.set(id, a);
  }
  return a;
}

export function openConnection(host: string): Connection {
  return new Connection(host);
}

export function openFile(path: string): FileHandle {
  return new FileHandle(path);
}
`;

  const imports = {
    Account: "import { Account } from '../accounts/account';",
    Connection: "import { Connection } from '../net/connection';",
    FileHandle: "import { FileHandle } from '../files/fileHandle';",
  };

  for (const [i, name] of SERVICE_NAMES.entries()) {
    const own = KINDS[i % 3];
    // Every third-ish service also reaches another kind through a registry helper.
    const other = r() < 0.5 ? KINDS[(i + 1 + Math.floor(r() * 2)) % 3] : null;
    const cls = `${cap(name)}Service`;
    const lines = [];
    const used = new Set([own]);
    if (other) used.add(other);
    for (const k of KINDS) if (used.has(k) && k === own) lines.push(imports[k]);
    if (other) lines.push(`import { ${HELPER[other]} } from '../registry';`);
    lines.push('');
    lines.push(`/** ${cap(name)}: owns one ${own === 'FileHandle' ? 'file handle' : own.toLowerCase()} for its lifetime. */`);
    lines.push(`export class ${cls} {`);
    lines.push(`  private runs = 0;`);
    lines.push('');
    lines.push(`  constructor(private readonly target: ${own}) {}`);
    lines.push('');
    lines.push(`  status(): string {`);
    lines.push(`    return \`${name}: \${this.runs} runs\`;`);
    lines.push(`  }`);
    lines.push('');
    // Account stays under find_references' 30-result cap (codebaseTools MAX_SYMBOL_RESULTS):
    // this scenario measures the lookup, not how a model copes with a truncated one.
    const ownCalls = own === 'Account' ? 1 : 1 + Math.floor(r() * 2);
    for (let c = 0; c < ownCalls; c++) {
      const method = ['shutdown', 'finish', 'abort', 'retire'][c % 4];
      lines.push(`  async ${method}${c ? c + 1 : ''}(): Promise<void> {`);
      lines.push(`    this.runs++;`);
      lines.push(`    ${CALL[own]('this.target', r)};`);
      lines.push(`  }`);
      lines.push('');
      expected[own]++;
      if (own === 'Account') accountCallFiles.add(`src/services/${name}Service.ts`);
    }
    if (other) {
      const arg = HELPER_ARG[other];
      lines.push(`  async release(${arg}: string): Promise<void> {`);
      lines.push(`    ${CALL[other](`${HELPER[other]}(${arg})`, r)};`);
      lines.push(`  }`);
      lines.push('');
      expected[other]++;
      if (other === 'Account') accountCallFiles.add(`src/services/${name}Service.ts`);
    }
    lines.push(`  describe(): string {`);
    lines.push(`    return '${name} service (closes its resources on shutdown)';`);
    lines.push(`  }`);
    lines.push(`}`);
    files[`src/services/${name}Service.ts`] = lines.join('\n') + '\n';
  }

  files['src/index.ts'] = SERVICE_NAMES.map((n) => `export { ${cap(n)}Service } from './services/${n}Service';`).join('\n') + '\n';

  return { files, expected: { ...expected, accountCallFiles: [...accountCallFiles].sort() } };
}
