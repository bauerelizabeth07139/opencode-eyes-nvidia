/**
 * Static composition checks for this DSH plugin package.
 *
 * Everything the Harness and the plugin catalogs resolve before the bundle is
 * mounted: the manifest fields that make it installable, the card metadata the
 * readers look up, the loader patch, the bundled skill (when the package ships
 * one), and the syntax of the entry point. No Harness and no network needed,
 * so it runs on a fresh clone and in CI.
 *
 * `js-yaml` belongs to the Harness, not to this package: when no copy is
 * reachable the YAML check reports SKIP instead of failing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ICON_TYPES = [".svg", ".png", ".jpg", ".jpeg", ".webp"];
const MAX_ICON_BYTES = 256 * 1024;

let failed = 0;
let skipped = 0;
async function check(label, body) {
	try {
		const detail = await body();
		if (typeof detail === "string" && detail.startsWith("SKIP")) {
			skipped++;
			console.log(`  SKIP  ${label}${detail.length > 4 ? ` — ${detail.slice(5)}` : ""}`);
			return;
		}
		console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL  ${label} — ${error.message}`);
	}
}

console.log(`${manifest.name} plugin composition`);

await check("the package is a named DSH plugin", async () => {
	assert.match(manifest.name, /^dsh-/, `unexpected name ${manifest.name}`);
	assert.match(manifest.version, /^\d+\.\d+\.\d+/, `unexpected version ${manifest.version}`);
	return `${manifest.name}@${manifest.version}`;
});

await check("declares dsh.bundle.patch and the file exists", async () => {
	const patch = manifest.dsh?.bundle?.patch;
	assert.ok(patch, "dsh.bundle.patch missing");
	assert.ok(existsSync(join(ROOT, patch)), `${patch} does not exist`);
	return patch;
});

await check("declares a bundle manifest version", async () => {
	assert.equal(manifest.dsh?.manifestVersion, 1);
	return "manifestVersion 1";
});

await check("the declared DSH range admits the 0.2 line", async () => {
	const range = manifest.engines?.dsh;
	assert.ok(range, "engines.dsh missing");
	assert.match(
		range,
		/^>=0\.1\.5-rc\.1 <0\.2\.0-0 \|\| >=0\.2\.0-rc\.0 <0\.3\.0-0$/,
		`unexpected range ${range}`,
	);
	assert.match(manifest.engines?.node ?? "", />=22/, "engines.node must require Node 22+");
	return range;
});

await check("exposes the subpaths the card readers resolve", async () => {
	assert.ok(manifest.exports?.["./package.json"], "exports['./package.json'] missing");
	assert.ok(manifest.exports?.["./locale/*.json"], "exports['./locale/*.json'] missing");
	assert.ok(Array.isArray(manifest.files) && manifest.files.includes("locale"), "files must ship locale/");
	return Object.keys(manifest.exports).join(", ");
});

await check("ships a card icon within the reader's limits", async () => {
	const icon = manifest.icon;
	assert.ok(icon, "icon missing");
	const file = join(ROOT, icon);
	assert.ok(existsSync(file), `${icon} does not exist`);
	const bytes = statSync(file).size;
	assert.ok(bytes > 0 && bytes <= MAX_ICON_BYTES, `${bytes} bytes`);
	assert.ok(ICON_TYPES.includes(icon.slice(icon.lastIndexOf("."))), `unsupported type ${icon}`);
	return `${icon} (${bytes} bytes)`;
});

for (const language of ["en", "zh"]) {
	await check(`locale/${language}.json carries a card title and description`, async () => {
		const card = JSON.parse(readFileSync(join(ROOT, "locale", `${language}.json`), "utf8"));
		assert.ok(card.meta?.title, "meta.title missing");
		assert.ok(card.meta?.description, "meta.description missing");
		return `"${card.meta.title}"`;
	});
}

await check("the loader patch inserts exactly one row naming the package", async () => {
	let load;
	for (const candidate of [
		process.env.DSH_JS_YAML,
		"js-yaml",
		join(homedir(), ".dsh", "profiles", "web", "node_modules", "js-yaml", "dist", "js-yaml.mjs"),
	]) {
		try {
			if (!candidate) continue;
			const specifier = /[/\\]/.test(candidate) ? pathToFileURL(candidate).href : candidate;
			({ load } = await import(specifier));
			if (load) break;
		} catch {
			// try the next candidate
		}
	}
	if (!load) return "SKIP no js-yaml available; set DSH_JS_YAML to the Harness copy";
	const parsed = load(readFileSync(join(ROOT, manifest.dsh.bundle.patch), "utf8"));
	assert.ok(Array.isArray(parsed), "a patch layer must be a top-level array");
	const inserts = parsed.filter((entry) => entry?.insert !== undefined);
	assert.equal(inserts.length, 1, "expected exactly one insert entry");
	const rows = inserts[0].insert;
	assert.ok(Array.isArray(rows) && rows.length === 1, "expected exactly one loader row");
	assert.equal(rows[0].name, manifest.name, "the row name must match the package name");
	assert.equal(typeof rows[0].id, "string");
	assert.notEqual(rows[0].id.length, 0);
	return `insert -> { id: ${rows[0].id}, name: ${rows[0].name} }`;
});

if (existsSync(join(ROOT, "skills"))) {
	for (const entry of await readdir(join(ROOT, "skills"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		await check(`skills/${entry.name}/SKILL.md parses as a DSH skill`, async () => {
			const file = join(ROOT, "skills", entry.name, "SKILL.md");
			assert.ok(existsSync(file), `${file} does not exist`);
			const text = readFileSync(file, "utf8");
			const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
			assert.ok(front, "front-matter missing");
			assert.match(front[1], /^name:\s*\S+/mu, "front-matter name missing");
			assert.match(front[1], /^description:\s*\S+/mu, "front-matter description missing");
			assert.equal(/^name:\s*(\S+)/mu.exec(front[1])[1], entry.name, "skill name must match its directory");
			const body = text.slice(front[0].length).trim();
			assert.ok(body.length > 200, `skill body is suspiciously short (${body.length} chars)`);
			return `${body.length} chars of instructions`;
		});
	}
}

await check("the entry point parses as JavaScript", async () => {
	const entry = manifest.main ?? "./index.js";
	assert.ok(existsSync(join(ROOT, entry)), `${entry} does not exist`);
	execFileSync(process.execPath, ["--check", join(ROOT, entry)], { stdio: "pipe" });
	const extra = readdirSync(ROOT).filter((file) => file.endsWith(".js") && `./${file}` !== entry);
	for (const file of extra) {
		execFileSync(process.execPath, ["--check", join(ROOT, file)], { stdio: "pipe" });
	}
	return extra.length ? `${entry} + ${extra.length} more` : entry;
});

await check("no machine-local paths leaked into the published files", async () => {
	const suspects = [/(?:^|[^A-Za-z])[A-Z]:\\Users\\/u, /D:\\deeph/u, /nyaproxy/u, /local-plugins/u];
	const files = ["package.json", "README.md", "index.js", "cordis.patch.yml"];
	const offenders = [];
	for (const file of files) {
		const path = join(ROOT, file);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		if (suspects.some((pattern) => pattern.test(text))) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `machine paths in ${offenders.join(", ")}`);
	return `${files.length} files clean`;
});

console.log(
	`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}` +
		(skipped ? `, ${skipped} skipped` : ""),
);
process.exit(failed === 0 ? 0 : 1);
