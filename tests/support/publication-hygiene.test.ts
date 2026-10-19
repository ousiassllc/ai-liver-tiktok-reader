import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * Issue #2782: 独立公開する reader の配布物・ignore 設定・単独完結性の回帰テスト。
 * 公開 snapshot に秘密情報や絶対 symlink、monorepo 外部への依存が混入しないことを固定する。
 */
const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** node_modules / dist / coverage を除いた reader 配下の全パス。 */
function walk(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(name)) continue;
    const path = join(dir, name);
    found.push(path);
    if (lstatSync(path).isDirectory()) walk(path, found);
  }
  return found;
}

describe('ignore 設定', () => {
  const required = ['.env', '.env.*', '!.env.example', '*.pem', '*.key', 'node_modules'];

  it.each(['.gitignore', '.dockerignore'])('%s は秘密情報・鍵・.env.* を除外し .env.example だけ残す', (file) => {
    const lines = read(file).split('\n').map((line) => line.trim());
    for (const entry of required) {
      let pattern = entry;
      if (file === '.dockerignore') {
        pattern = entry.startsWith('!') ? `!**/${entry.slice(1)}` : `**/${entry}`;
      }
      expect(lines).toContain(pattern);
    }
  });

  it('.dockerignore は Dockerfile が COPY するファイルを除外していない', () => {
    const ignored = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
    const copied = ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'SOURCE.md', 'scripts/generate-third-party-notices.mjs', 'src/server.ts', 'tsconfig.build.json'];
    for (const file of copied) {
      expect(ignored).not.toContain(file);
      expect(ignored).not.toContain(file.split('/')[0]);
    }
  });
});

describe('npm 配布物', () => {
  it('private で、files allowlist により架空の .env.* や鍵が梱包されない', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.private).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'tiktok-reader-pack-'));
    try {
      for (const file of ['package.json', 'LICENSE', 'NOTICE', 'SOURCE.md']) {
        cpSync(join(ROOT, file), join(dir, file));
      }
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist/server.js'), '// built\n');
      // 実秘密情報ではない架空のファイル。
      writeFileSync(join(dir, '.env.publication-audit'), 'FAKE=1\n');
      writeFileSync(join(dir, 'fake.pem'), 'FAKE\n');
      writeFileSync(join(dir, 'fake.key'), 'FAKE\n');

      const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
      expect(packed.status).toBe(0);
      const files: string[] = JSON.parse(packed.stdout)[0].files.map((f: { path: string }) => f.path);

      expect(files).toContain('dist/server.js');
      expect(files).toContain('LICENSE');
      expect(files).toContain('NOTICE');
      expect(files).not.toContain('.env.publication-audit');
      expect(files).not.toContain('fake.pem');
      expect(files).not.toContain('fake.key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('単独完結性', () => {
  it('絶対パスを指す symlink を含まない', () => {
    const absolute = walk(ROOT).filter((path) => lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith('/'));
    expect(absolute).toEqual([]);
  });

  it('src / scripts / tests / 設定が monorepo 外（../tools, ../../tools 等）を参照しない', () => {
    const selfPath = __filename;
    const offenders = walk(ROOT)
      .filter((path) => lstatSync(path).isFile() && /\.(ts|mjs|js|json|toml)$/.test(path) && path !== selfPath)
      .filter((path) => !path.endsWith('package-lock.json') && !path.endsWith('package.json'))
      .filter((path) => /\.\.\/(\.\.\/)*tools\//.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('package.json の preinstall は monorepo の guard が無い環境では何もせず成功する', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.preinstall).toMatch(/^if \[ -f \.\.\/tools\/.*\]; then .*; fi$/);
  });

  it('bunfig の preload が同梱の vendor を指し、同梱ファイルが存在する', () => {
    for (const file of ['preload-bun-version.mjs', 'preload-test-timeout.mjs', 'vendor/bun-version-guard.mjs', 'vendor/bun-test-timeout.mjs']) {
      expect(existsSync(join(ROOT, 'scripts', file))).toBe(true);
    }
    expect(read('scripts/preload-bun-version.mjs')).toContain("'./vendor/bun-version-guard.mjs'");
    expect(read('scripts/preload-test-timeout.mjs')).toContain("'./vendor/bun-test-timeout.mjs'");
  });

  it('.nvmrc を reader 内に持つ', () => {
    expect(read('.nvmrc').trim()).toMatch(/^22/);
  });
});

describe('ライセンス・ソース案内', () => {
  it('package.json の license が LICENSE / NOTICE と一致する', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.license).toBe('AGPL-3.0-only');
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(read('NOTICE')).toContain('AGPL-3.0-only');
    expect(read('NOTICE')).toContain('tiktok-live-connector');
  });

  it('Dockerfile の runtime image に LICENSE / NOTICE / SOURCE.md / 依存 notices / 稼働版の識別子を入れる', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('COPY LICENSE NOTICE SOURCE.md ./');
    expect(dockerfile).toContain('THIRD_PARTY_NOTICES.txt');
    expect(dockerfile).toContain('ARG SOURCE_COMMIT');
    expect(dockerfile).toContain('SOURCE_COMMIT=${SOURCE_COMMIT}');
    expect(dockerfile).toContain('org.opencontainers.image.revision');
    expect(dockerfile).toContain('ARG TIKTOK_READER_SOURCE_URL=');
    expect(dockerfile).toContain('TIKTOK_READER_SOURCE_URL=${TIKTOK_READER_SOURCE_URL}');
    expect(dockerfile).toContain('org.opencontainers.image.source="${TIKTOK_READER_SOURCE_URL}"');
  });

  it('generate-third-party-notices は本番依存のライセンス本文を出力する', () => {
    const result = spawnSync('node', ['scripts/generate-third-party-notices.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tiktok-live-connector@');
    expect(result.stdout).toContain('--- LICENSE');
    // devDependency は含めない。
    expect(result.stdout).not.toContain('\ntypescript@');
  });
});

describe('README と .env.example', () => {
  it('.env.example の全環境変数が README の環境変数リストにあり、BACKEND_API_URL の例は /api/v1 を含む', () => {
    const vars = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(10);
    const readme = read('README.md');
    for (const name of vars) {
      expect(readme).toContain(`- \`${name}\``);
    }

    const backendUrl = read('.env.example').match(/^#?\s*BACKEND_API_URL=(.*)$/m);
    expect(backendUrl?.[1]).toMatch(/\/api\/v1$/);
  });
});
