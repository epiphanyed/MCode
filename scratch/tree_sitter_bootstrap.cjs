'use strict';
const fs = require('fs');
const path = require('path');

const wasmDir = path.resolve(__dirname, '../node_modules/@vscode/tree-sitter-wasm/wasm');
const scriptPath = path.join(wasmDir, 'tree-sitter.js');

const defineCalls = [];
global.define = (id, deps, cb) => {
	if (typeof id !== 'string') {
		cb = deps;
	}
	defineCalls.push({ callback: cb });
};
global.define.amd = true;

require(scriptPath);

const def = defineCalls.pop();
const exp = {};
const mod = def.callback(exp);
const { Parser, Language } = mod ?? exp;

(async () => {
	await Parser.init({ locateFile: () => path.join(wasmDir, 'tree-sitter.wasm') });
	const langBytes = fs.readFileSync(path.join(wasmDir, 'tree-sitter-cpp.wasm'));
	const lang = await Language.load(langBytes);
	const parser = new Parser();
	parser.setLanguage(lang);
	const tree = parser.parse('int foo() { return 1; }');
	console.log('OK', tree.rootNode.type);
})().catch(err => {
	console.error(err);
	process.exit(1);
});
