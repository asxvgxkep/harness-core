/** Workspace selection and bounded metadata inspection.
 *  Only the directory the user explicitly chose is ever scanned; walks are
 *  capped and skip VCS/dependency trees. Git probes use fixed argument lists.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GIT_PROBE_TIMEOUT_MS, WORKSPACE_SCAN_MAX_ENTRIES } from './desktop-config.js';

/** Bounded shallow language histogram by extension. */
const LANGUAGE_BY_EXTENSION = new Map([
    ['.js', 'JavaScript'],
    ['.jsx', 'JavaScript'],
    ['.mjs', 'JavaScript'],
    ['.cjs', 'JavaScript'],
    ['.ts', 'TypeScript'],
    ['.tsx', 'TypeScript'],
    ['.py', 'Python'],
    ['.rs', 'Rust'],
    ['.go', 'Go'],
    ['.java', 'Java'],
    ['.kt', 'Kotlin'],
    ['.c', 'C'],
    ['.h', 'C/C++'],
    ['.cc', 'C++'],
    ['.cpp', 'C++'],
    ['.hpp', 'C++'],
    ['.cs', 'C#'],
    ['.rb', 'Ruby'],
    ['.php', 'PHP'],
    ['.swift', 'Swift'],
    ['.sh', 'Shell'],
    ['.ps1', 'PowerShell'],
    ['.html', 'HTML'],
    ['.css', 'CSS'],
    ['.scss', 'SCSS'],
    ['.vue', 'Vue'],
    ['.svelte', 'Svelte'],
    ['.json', 'JSON'],
    ['.md', 'Markdown'],
    ['.yml', 'YAML'],
    ['.yaml', 'YAML'],
    ['.toml', 'TOML'],
    ['.sql', 'SQL'],
]);

/** Files whose presence marks a recognizable scaffold. */
const MANIFEST_NAMES = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'CMakeLists.txt']);

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'out']);

/** Infer a project type line (e.g. "Electron / React / TypeScript") from package.json. */
export function inferProjectType(packageJson) {
    if (packageJson === undefined)
        return null;
    const labels = [];
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    if ('electron' in deps)
        labels.push('Electron');
    if ('react' in deps || 'react-dom' in deps)
        labels.push('React');
    if ('vue' in deps)
        labels.push('Vue');
    if ('svelte' in deps)
        labels.push('Svelte');
    if ('next' in deps)
        labels.push('Next.js');
    if ('vite' in deps)
        labels.push('Vite');
    if ('typescript' in deps)
        labels.push('TypeScript');
    if ('express' in deps || 'fastify' in deps || 'koa' in deps)
        labels.push('Node');
    if (packageJson.scripts !== undefined && 'tauri' in packageJson.scripts)
        labels.push('Tauri');
    return labels.length > 0 ? labels.join(' / ') : 'Node';
}

/** Walk a directory shallowly, capped; returns {count, languages, manifests, sampleFiles}. */
export function scanDirectory(root) {
    const languages = new Map();
    const manifests = new Set();
    let count = 0;
    const pending = [root];
    while (pending.length > 0 && count < WORKSPACE_SCAN_MAX_ENTRIES) {
        const dir = pending.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            if (count >= WORKSPACE_SCAN_MAX_ENTRIES)
                break;
            const full = join(dir, name);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(name))
                    pending.push(full);
                continue;
            }
            count++;
            if (MANIFEST_NAMES.has(name))
                manifests.add(name);
            const dot = name.lastIndexOf('.');
            if (dot > 0 && dot < name.length - 1) {
                const ext = name.slice(dot).toLowerCase();
                const language = LANGUAGE_BY_EXTENSION.get(ext);
                if (language !== undefined)
                    languages.set(language, (languages.get(language) ?? 0) + 1);
            }
        }
    }
    return {
        count,
        capped: count >= WORKSPACE_SCAN_MAX_ENTRIES,
        languages: [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, files]) => ({ name, files })),
        manifests: [...manifests],
    };
}

/** Count modified/untracked entries from `git status --porcelain`. Pure. */
export function parseGitStatus(text) {
    let modified = 0;
    let untracked = 0;
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw;
        if (line.length < 2 || line === '')
            continue;
        if (line === '??' || line.startsWith('?? '))
            untracked++;
        else
            modified++;
    }
    return { modified, untracked };
}

/** Inspect the chosen workspace: git state, files, languages, scaffold. */
export async function inspectWorkspace(root, run) {
    if (!existsSync(root)) {
        return { ok: false, reason: 'directory does not exist' };
    }
    let stat;
    try {
        stat = statSync(root);
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!stat.isDirectory()) {
        return { ok: false, reason: 'not a directory' };
    }

    const meta = {
        path: root,
        name: basename(root),
        scan: scanDirectory(root),
        git: null,
        packageJson: null,
        type: null,
    };

    const packageJsonPath = join(root, 'package.json');
    if (existsSync(packageJsonPath)) {
        try {
            const raw = readFileText(packageJsonPath);
            if (raw !== null) {
                meta.packageJson = JSON.parse(raw);
                meta.type = inferProjectType(meta.packageJson);
            }
        }
        catch {
            meta.packageJson = null;
        }
    }
    if (meta.type === null) {
        if (meta.scan.manifests.includes('requirements.txt') || meta.scan.manifests.includes('pyproject.toml'))
            meta.type = 'Python';
        else if (meta.scan.manifests.includes('Cargo.toml'))
            meta.type = 'Rust';
        else if (meta.scan.manifests.includes('CMakeLists.txt'))
            meta.type = 'C/C++';
        else if (meta.scan.languages.length > 0)
            meta.type = meta.scan.languages.map((entry) => entry.name).join(' / ');
    }

    const branch = await run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    if (branch.error === undefined && branch.code === 0) {
        const git = { branch: branch.stdout.trim() || 'detached' };
        const status = await run('git', ['-C', root, 'status', '--porcelain'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
        if (status.error === undefined && status.code === 0) {
            Object.assign(git, parseGitStatus(status.stdout));
        }
        meta.git = git;
    }

    return { ok: true, meta };
}

/** Read a UTF-8 file, null on failure. */
function readFileText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
