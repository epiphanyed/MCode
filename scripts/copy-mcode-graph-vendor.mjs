#!/usr/bin/env node
/**
 * Copy vis-network + 3d-force-graph bundles into mcode media for offline Graph webview.
 * Run after: npm install vis-network 3d-force-graph
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/vs/workbench/contrib/mcode/browser/media/graph-vendor');

const copies = [
	['node_modules/vis-network/standalone/umd/vis-network.min.js', 'vis-network.min.js'],
	['node_modules/3d-force-graph/dist/3d-force-graph.min.js', '3d-force-graph.min.js'],
	['node_modules/vis-network/LICENSE-APACHE-2.0', 'vis-network.LICENSE'],
	['node_modules/3d-force-graph/LICENSE', '3d-force-graph.LICENSE'],
];

fs.mkdirSync(outDir, { recursive: true });
for (const [src, dest] of copies) {
	const from = path.join(root, src);
	if (!fs.existsSync(from)) {
		console.warn(`[copy-mcode-graph-vendor] skip missing: ${src}`);
		continue;
	}
	fs.copyFileSync(from, path.join(outDir, dest));
	console.log(`[copy-mcode-graph-vendor] ${dest}`);
}
